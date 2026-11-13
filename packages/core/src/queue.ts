/**
 * The queue contract. Shapes only — no SQL, no driver, no `Pool`.
 *
 * It is deliberately the shape a Postgres lease needs and also the shape BullMQ
 * or pg-boss would satisfy, so that swapping `pg-queue.ts` for another
 * implementation is one file and no call site. A method that leaked a `WHERE`
 * clause would put the storage engine back into the runner's head.
 */

export const GRAPH_LANE = "graph.run";

/** A job as the worker sees it after claiming: the lease is already held. */
export interface QueueJob {
  id: string;
  tenantId: string | null;
  lane: string;
  source: string;
  externalMessageId: string;
  /** The job body, already parsed from JSON. `graph.run` puts a `GraphRunPayload` here. */
  payload: unknown;
  workflowId: string | null;
  /** Set when a run row exists for this job — a re-claim resumes it, never starts a second one. */
  runId: string | null;
  attempts: number;
  maxAttempts: number;
}

export interface NewJob {
  lane: string;
  tenantId: string | null;
  /** Idempotency namespace: "telegram", "whatsapp", "console-test". */
  source: string;
  /** The dedupe key. Two deliveries of one message must not spend tokens twice. */
  externalMessageId: string;
  payload: unknown;
  workflowId?: string;
  /** The run row the producer already wrote, so the worker resumes rather than duplicates it. */
  runId?: string;
  maxAttempts?: number;
}

export interface QueueCounts {
  queued: number;
  /** Held by some worker right now: `lockedUntil > now()`. */
  claimed: number;
  /** Waiting out a backoff. */
  failed: number;
  dead: number;
}

export interface Queue {
  /**
   * Insert, or return the row that already carries this key. The second call for
   * one message id is a `duplicate`, and a duplicate is NOT re-queued: re-queueing
   * a delivered message is the double-reply bug this whole interface exists to
   * prevent.
   */
  enqueue(job: NewJob): Promise<{ id: string; duplicate: boolean }>;
  /** One statement, holding the row lock for microseconds — never across a model call. */
  claim(lane: string, workerId: string, leaseMs: number): Promise<QueueJob | null>;
  /** False means somebody else holds it now. The runner must abandon, not finish. */
  heartbeat(id: string, workerId: string, leaseMs: number): Promise<boolean>;
  /**
   * Record which `WorkflowRun` this job produced, so a re-claimed lease resumes
   * that run instead of starting a second one and billing the tenant twice.
   */
  attachRun(id: string, workerId: string, runId: string, workflowId: string): Promise<void>;
  succeed(id: string, workerId: string): Promise<void>;
  /** Backoff: invisible to `claim` until `delayMs` has passed. */
  retry(id: string, workerId: string, error: string, delayMs: number): Promise<void>;
  /** Terminal. A human reads this list; nothing here is silently dropped. */
  dead(id: string, workerId: string, error: string): Promise<void>;
  /** Shutdown mid-job: give the lease back and un-count the attempt. */
  release(id: string, workerId: string): Promise<void>;
  counts(lane: string): Promise<QueueCounts>;
}
