/** Error hierarchy with one contract: only `TransientError` may be retried. */

export class ConfigError extends Error {}/** Marker for anything worth repeating: 429/5xx/network. Nothing else extends it. */
export class TransientError extends Error {
  readonly transient = true;
  constructor(
    message: string,
    /** A `Retry-After` from the far side wins over our backoff curve when larger. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TransientError";
  }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Anything 429/5xx/network — the only provider failures `withRetry` will repeat. */
export class TransientProviderError extends ProviderError {
  readonly transient = true;
  constructor(
    message: string,
    provider: string,
    status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message, provider, status);
    this.name = "TransientProviderError";
  }
}

/**
 * The model behind this provider cannot call tools. Activation refuses with
 * this instead of letting a run discover it on its first billed call.
 */
export class ToolUnsupportedError extends ProviderError {
  constructor(message: string, provider: string) {
    super(message, provider);
    this.name = "ToolUnsupportedError";
  }
}

/**
 * The provider answered but refused to say what it cost. Billing off an
 * estimate would drift from what the provider actually charged us, so the
 * ledger treats this as a hard failure, never a guessed number.
 */
export class UsageUnavailableError extends ProviderError {
  constructor(message: string, provider: string) {
    super(message, provider);
    this.name = "UsageUnavailableError";
  }
}

/**
 * Errors that carry the HTTP status the caller should see. The Fastify error
 * handler is the only place that turns one into a response, so services and the
 * worker stay free of `reply` — and `@saas/core` can refuse a run without
 * importing anything from the API that raised it.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new HttpError(400, code, message, details);
export const notFound = (code = "not_found", message = "resource not found") => new HttpError(404, code, message);
export const conflict = (code: string, message: string, details?: unknown) => new HttpError(409, code, message, details);
export const tooLarge = (code: string, message: string) => new HttpError(413, code, message);
