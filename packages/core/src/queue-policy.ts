/**
 * When a job is repeated, and when it is put to rest.
 *
 * Pure on purpose — `pg-queue.ts` owns the SQL, this owns the decision, and the
 * two are tested separately so a change to the backoff curve never needs a
 * database. The rule that matters most is the negative one: only what the
 * provider layer classifies as transient is repeated. A guard refusal retried
 * three times is three refusals, and a quota refusal retried is a storm against
 * a balance that is already at zero.
 */
import { HttpError, TransientError } from "@saas/shared";

export const ATTEMPT_BASE_MS = 1_000;
export const ATTEMPT_CAP_MS = 60_000;

/**
 * Exponential with jitter, capped. The jitter is what stops ten jobs that all
 * failed at minute one from coming back at minute two together.
 */
export function attemptDelay(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(ATTEMPT_CAP_MS, ATTEMPT_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.5 + random() * 0.5));
}

export type AttemptDecision = "retry" | "dead" | "blocked";

/**
 * `blocked` is not `dead`. A tenant out of tokens is a condition that changes —
 * the graph is fine, the balance is not — and calling it "dead" would make the
 * console report a broken workflow. It also decides the run's own status, so the
 * Runs page can say "blocked, no provider call was made" rather than "failed".
 */
export function attemptDecide(error: unknown, attempts: number, maxAttempts: number): AttemptDecision {
  if (error instanceof HttpError) {
    if (error.status === 402 || error.code === "quota_exhausted") return "blocked";
    // 502 is what `runAgentTurn` raises once `withRetry` has already burned its
    // own attempts on the provider. Repeating it is legitimate while the job has
    // attempts left; a 400/404/409 refusal never is.
    if (error.status === 502) return attempts >= maxAttempts ? "dead" : "retry";
    return "dead";
  }
  const transient = error instanceof TransientError || (error as { transient?: boolean })?.transient === true;
  if (!transient) return "dead";
  return attempts >= maxAttempts ? "dead" : "retry";
}

/** The column is `String?` and the message comes from someone else's API. */
export const describeError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
