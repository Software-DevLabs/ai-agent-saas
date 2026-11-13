import { ProviderError, TransientProviderError, UsageUnavailableError } from "@saas/shared";
import type { EmbedResult, ModelMessage, ModelProvider, ModelRunInput, ModelRunResult, ToolCall } from "./types.ts";

/**
 * Ollama `/api/chat`, the daemon the cli project already runs
 * (`OLLAMA_BASE_URL=http://127.0.0.1:11434`, model `gemma4:31b-cloud`).
 *
 * Token counts come from `prompt_eval_count` / `eval_count` in the response.
 * If they are absent the call is a hard `UsageUnavailableError`: a guessed
 * count drifts from what we are actually charged, and the ledger would bill
 * the tenant a fiction.
 *
 * Tool calling is the same endpoint: the request carries `tools`, the reply
 * may carry `message.tool_calls`, and the caller replays the assistant turn
 * plus one `role:"tool"` message per result.
 */

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface OllamaRawToolCall {
  function?: { name?: string; arguments?: unknown };
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string; tool_calls?: OllamaRawToolCall[] };
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
  done?: boolean;
}

interface OllamaShowResponse {
  capabilities?: string[];
  error?: string;
}

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** The model `/api/embed` is asked for; a caller may override it per call. */
  embedModel?: string;
}

interface OllamaEmbedResponse {
  embeddings?: unknown;
  error?: string;
}

const DEFAULT_EMBED_MODEL = "nomic-embed-text";
/** `/api/show` per model is a metadata read, not a per-document cost. */
const EMBED_LIST_TTL_MS = 5 * 60_000;
const embedModelCache = new Map<string, { models: string[]; at: number }>();

/** `/api/show` is a capability probe, not a per-run cost: five minutes per process is enough. */
const CAPABILITY_TTL_MS = 5 * 60_000;
const capabilityCache = new Map<string, { supports: boolean; at: number }>();

function serializeMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_name: message.toolName };
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } })),
    };
  }
  return { role: message.role, content: message.content };
}

/**
 * Ollama usually answers with an object, but some templates emit the arguments
 * as a JSON string. A string that does not parse is a malformed call from a
 * round that was already billed — refuse it loudly.
 */
function parseArguments(raw: unknown, toolName: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // fall through to the error below
    }
  }
  throw new ProviderError(`ollama sent malformed arguments for tool "${toolName}"`, "ollama");
}

function parseToolCalls(raw: OllamaRawToolCall[] | undefined): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const entry of raw) {
    const name = entry?.function?.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new ProviderError("ollama sent a tool call without a function name", "ollama");
    }
    calls.push({ name, arguments: parseArguments(entry.function?.arguments, name) });
  }
  return calls;
}

export class OllamaProvider implements ModelProvider {
  readonly name = "ollama";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly embedModel: string;
  private readonly fetch: FetchLike;

  constructor(options: OllamaOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.embedModel = options.embedModel ?? DEFAULT_EMBED_MODEL;
    this.fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async run(input: ModelRunInput): Promise<ModelRunResult> {
    const tools = (input.tools ?? []).map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    const body: Record<string, unknown> = {
      model: this.model,
      stream: false,
      options: { temperature: input.temperature, num_predict: input.maxOutputTokens },
      messages: [
        { role: "system", content: input.systemPrompt },
        ...input.messages.map(serializeMessage),
      ],
    };
    if (tools.length > 0) body.tools = tools;
    if (input.responseFormat === "json") body.format = "json";

    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // Network failure or the timeout abort — both worth repeating.
      throw new TransientProviderError(`ollama unreachable: ${(error as Error).message}`, this.name);
    }

    if (response.status === 429 || response.status >= 500) {
      const retryAfterHeader = Number(response.headers.get("retry-after"));
      throw new TransientProviderError(`ollama transient failure (HTTP ${response.status})`, this.name, response.status,
        Number.isFinite(retryAfterHeader) ? retryAfterHeader * 1000 : undefined);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(`ollama rejected the request (HTTP ${response.status}): ${text.slice(0, 300)}`, this.name, response.status);
    }

    let payload: OllamaChatResponse;
    try {
      payload = (await response.json()) as OllamaChatResponse;
    } catch {
      throw new TransientProviderError("ollama answered with a non-JSON body", this.name);
    }
    if (payload.error) {
      // model-not-found is permanent; nothing a retry changes.
      throw new ProviderError(`ollama error: ${payload.error}`, this.name);
    }

    // Usage is checked before the content: a turn that called a tool still cost
    // tokens, and an unbilled round would drift the ledger.
    if (typeof payload.prompt_eval_count !== "number" || typeof payload.eval_count !== "number") {
      throw new UsageUnavailableError(
        `ollama did not report usage counts for "${this.model}" — the ledger refuses to estimate`,
        this.name,
      );
    }

    const toolCalls = parseToolCalls(payload.message?.tool_calls);
    const rawContent = payload.message?.content;
    // A tool-calling turn may legitimately carry an empty string.
    if (typeof rawContent !== "string" && toolCalls.length === 0) {
      throw new ProviderError("ollama response carried no assistant content", this.name);
    }

    return {
      content: typeof rawContent === "string" ? rawContent : "",
      inputTokens: payload.prompt_eval_count,
      outputTokens: payload.eval_count,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      stopReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    };
  }

  /**
   * `GET /api/tags` — what the daemon actually has pulled. The console lists
   * these instead of a hand-typed model array, so a model that is not on the
   * machine cannot be selected in the builder.
   */
  async listModels(): Promise<string[]> {
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new TransientProviderError(`ollama unreachable: ${(error as Error).message}`, this.name);
    }
    if (!response.ok) {
      throw new ProviderError(`ollama tags request failed (HTTP ${response.status})`, this.name, response.status);
    }
    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    return (payload.models ?? []).map((entry) => entry.name).filter((name): name is string => typeof name === "string" && name.length > 0);
  }

  /**
   * `POST /api/embed` — one vector per input, in input order.
   *
   * The response is validated rather than trusted: a missing or ragged vector array
   * would become rows of the wrong `dim`, and Postgres refuses comparisons between
   * vectors of different lengths only at query time, long after the write looked
   * fine. Nothing here is metered — Ollama bills embedding tokens at zero, so a
   * `UsageEvent` would be a number nobody measured.
   */
  async embed(texts: string[], model: string = this.embedModel): Promise<EmbedResult> {
    if (texts.length === 0) return { vectors: [], model, dim: 0 };
    if (texts.some((text) => text.trim() === "")) {
      throw new ProviderError("an empty string cannot be embedded — the empty document is filtered before this call", this.name);
    }

    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new TransientProviderError(`ollama unreachable: ${(error as Error).message}`, this.name);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new TransientProviderError(`ollama transient failure (HTTP ${response.status})`, this.name, response.status);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // The common case on a fresh machine: no embedding model pulled. The message
      // carries the command to fix it, because "HTTP 404" fixes nothing.
      if (response.status === 404 || /not found|pull/i.test(text)) {
        throw new ProviderError(`ollama has no embedding model "${model}" — run \`ollama pull ${model}\` (HTTP ${response.status})`, this.name, response.status);
      }
      throw new ProviderError(`ollama rejected the embedding request (HTTP ${response.status}): ${text.slice(0, 300)}`, this.name, response.status);
    }

    let payload: OllamaEmbedResponse;
    try {
      payload = (await response.json()) as OllamaEmbedResponse;
    } catch {
      throw new TransientProviderError("ollama answered the embedding request with a non-JSON body", this.name);
    }
    if (payload.error) {
      const notFound = /not found|pull/i.test(payload.error);
      throw new ProviderError(
        notFound ? `ollama has no embedding model "${model}" — run \`ollama pull ${model}\`` : `ollama error: ${payload.error}`,
        this.name,
      );
    }

    const vectorList = payload.embeddings;
    if (!Array.isArray(vectorList) || vectorList.length !== texts.length) {
      throw new ProviderError(`ollama returned ${Array.isArray(vectorList) ? vectorList.length : "no"} embedding(s) for ${texts.length} input(s)`, this.name);
    }
    const vectors: number[][] = [];
    for (const raw of vectorList) {
      if (!Array.isArray(raw) || raw.length === 0 || !raw.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new ProviderError("ollama returned an embedding that is not a vector of finite numbers", this.name);
      }
      vectors.push(raw as number[]);
    }
    const dim = vectors[0]!.length;
    if (vectors.some((vector) => vector.length !== dim)) {
      throw new ProviderError("ollama returned embeddings of different lengths in one response", this.name);
    }
    return { vectors, model, dim };
  }

  /**
   * The pulled models whose `/api/show` declares an `embedding` capability.
   *
   * Not a hardcoded list and not every installed model: a chat model asked to embed
   * either errors or returns nonsense, and the console would then offer a model that
   * cannot do the job. A model whose probe fails is left out and the rest are still
   * reported — one broken tag must not hide the working one.
   */
  async listEmbedModels(): Promise<string[]> {
    const key = this.baseUrl;
    const hit = embedModelCache.get(key);
    if (hit && Date.now() - hit.at < EMBED_LIST_TTL_MS) return hit.models;

    const names = await this.listModels();
    const models: string[] = [];
    for (const name of names) {
      try {
        const response = await this.fetch(`${this.baseUrl}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: name }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) continue;
        const payload = (await response.json()) as OllamaShowResponse;
        if (Array.isArray(payload.capabilities) && payload.capabilities.includes("embedding")) models.push(name);
      } catch {
        // One unreadable tag does not invalidate the others.
      }
    }
    embedModelCache.set(key, { models, at: Date.now() });
    return models;
  }

  /**
   * `POST /api/show` reports `capabilities`. Cloud models are absent from
   * `/api/tags`, so this is the only honest source. Only an explicit "tools"
   * entry is a yes: an unknown shape is a no, and activation refuses rather
   * than discovering it on the first billed call.
   */
  async supportsTools(): Promise<boolean> {
    const key = `${this.baseUrl}|${this.model}`;
    const hit = capabilityCache.get(key);
    if (hit && Date.now() - hit.at < CAPABILITY_TTL_MS) return hit.supports;

    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new TransientProviderError(`ollama unreachable: ${(error as Error).message}`, this.name);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new TransientProviderError(`ollama show failed (HTTP ${response.status})`, this.name, response.status);
    }
    if (!response.ok) {
      throw new ProviderError(`ollama show failed (HTTP ${response.status})`, this.name, response.status);
    }

    let payload: OllamaShowResponse;
    try {
      payload = (await response.json()) as OllamaShowResponse;
    } catch {
      throw new ProviderError("ollama show answered with a non-JSON body", this.name);
    }
    const supports = Array.isArray(payload.capabilities) && payload.capabilities.includes("tools");
    capabilityCache.set(key, { supports, at: Date.now() });
    return supports;
  }
}
