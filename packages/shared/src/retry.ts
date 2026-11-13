import { TransientError } from "./errors.ts";
import type { RetryOptions } from "./retry.types.ts";

export type { RetryOptions };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Retry only what is marked transient. A guard refusal, a 4xx, or a
 * UsageUnavailableError must fail on the first attempt — repeating them
 * turns a clean error into a retry storm against someone's quota.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { retries, backoffMs, backoffCapMs = 30_000, sleep = realSleep, random = Math.random } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const transient = error instanceof TransientError || (error as TransientProviderFlag)?.transient === true;
      if (!transient || attempt === retries) throw error;
      const exponential = Math.min(backoffCapMs, backoffMs * 2 ** attempt);
      const jittered = exponential * (0.5 + random() * 0.5);
      const asked = (error as { retryAfterMs?: number }).retryAfterMs ?? 0;
      await sleep(Math.max(jittered, asked));
    }
  }
  throw lastError;
}

interface TransientProviderFlag {
  transient?: boolean;
}
