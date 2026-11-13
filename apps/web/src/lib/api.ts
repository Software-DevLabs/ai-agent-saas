import type { HealthResponse } from "./domain";

/**
 * The single HTTP seam. Every console read and write goes through here, which
 * means every number on screen came from the API — there is no local fallback
 * that could render a value the database does not hold.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const BASE = "/api";

interface ErrorBody {
  error?: string;
  message?: string;
  details?: unknown;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        // Only a JSON body gets a JSON content type. A `FormData` body must keep its
        // generated boundary, and stamping this header onto one is how an upload
        // arrives as a body nobody can parse.
        ...(typeof init?.body === "string" ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    throw new ApiError(0, "network_error", `cannot reach the API at ${BASE} — is \`pnpm dev:api\` running?`, error);
  }

  if (response.status === 204) return null as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const body = payload as ErrorBody | null;
    throw new ApiError(
      response.status,
      body?.error ?? "request_failed",
      body?.message ?? `the API responded with HTTP ${response.status}`,
      // The server's own structured reason, not the envelope holding it.
      body?.details,
    );
  }
  return payload as T;
}

export const getJson = <T>(path: string): Promise<T> => request<T>(path);

export const postJson = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const patchJson = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body) });

/** Replace-all writes (`PUT`) are a different contract from a patch, so they are a different call. */
export const putJson = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: "PUT", body: JSON.stringify(body) });

export const deleteJson = <T>(path: string): Promise<T> => request<T>(path, { method: "DELETE" });

/** One file, plus optional fields. The API's upload route is the only multipart one. */
export const postForm = <T>(path: string, form: FormData): Promise<T> => request<T>(path, { method: "POST", body: form });

export function fetchHealth(): Promise<HealthResponse> {
  return getJson<HealthResponse>("/healthz");
}

/**
 * Read the structured reason a refusal came with, or null when there was none.
 * `ApiError.details` is `unknown` because the server decides its shape per
 * endpoint; this keeps the cast to one line at each call site.
 */
export function errorDetails<T>(error: unknown): T | null {
  if (!(error instanceof ApiError)) return null;
  const value: unknown = error.details;
  return typeof value === "object" && value !== null ? (value as T) : null;
}
