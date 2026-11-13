export interface RetryOptions {
  retries: number;
  backoffMs: number;
  backoffCapMs?: number;
  /** Injectable so tests run without real timers. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}
