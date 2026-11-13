/**
 * The contract every model API hides behind. `core` and the worker may only
 * know these shapes — no provider-specific field may leak past this file.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  /** A JSON Schema object for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * One turn of the conversation as the model sees it. A tool result is its own
 * role, and an assistant turn that asked for tools carries the calls that were
 * made, so the next request can be replayed faithfully instead of paraphrased.
 */
export type ModelMessage =
  | { role: "user" | "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolName: string };

export interface ModelRunInput {
  systemPrompt: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
  temperature: number;
  /** Omitted means "a plain completion"; the provider must not invent tools. */
  tools?: ToolDefinition[];
  /**
   * Ask the provider to constrain the reply to a JSON object. The parser on the
   * other side is still strict — this reduces malformed wrappers, it does not
   * excuse reading a label that was not asked for.
   */
  responseFormat?: "json";
}

export interface ModelRunResult {
  content: string;
  /** MUST come from the provider's own usage payload — never a local estimate. */
  inputTokens: number;
  outputTokens: number;
  /** Empty/absent when the model answered in text. */
  toolCalls?: ToolCall[];
  stopReason: "stop" | "tool_calls";
}

/**
 * One embedding round: vectors in the order the texts were given, plus the model
 * and dimension the provider actually answered with.
 *
 * The dimension is part of the result rather than a constant in this file because
 * two embedding models can disagree about it, and a stored vector of the wrong
 * length is a comparison Postgres refuses — which is better than one it silently
 * accepts. Nothing here reports usage: Ollama's embedding endpoint is not billed
 * per token, so a token count would be invented.
 */
export interface EmbedResult {
  vectors: number[][];
  model: string;
  dim: number;
}

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  run(input: ModelRunInput): Promise<ModelRunResult>;
  /** Installed models, read from the provider itself when it can answer. */
  listModels?(): Promise<string[]>;
  /**
   * Whether the daemon declares tool support for this model. Absent means the
   * adapter cannot answer, which is treated as "no" by callers that must not
   * assume capability.
   */
  supportsTools?(): Promise<boolean>;
  /**
   * Embeddings, when the adapter has them. `model` defaults to the configured
   * embedding model; a caller naming another one gets vectors tagged with what
   * was actually used.
   */
  embed?(texts: string[], model?: string): Promise<EmbedResult>;
  /** Models the provider itself reports as embedding-capable, not a guessed list. */
  listEmbedModels?(): Promise<string[]>;
}

/** Providers are constructed from validated config, so the factory stays sync-light. */
export type ProviderFactory = (deps: { config: ProviderConfig; log?: unknown }) => ModelProvider;

export interface ProviderConfig {
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaTimeoutMs: number;
  /** The model the embedding lane asks for; the default is Ollama's standard embedder. */
  ollamaEmbedModel?: string;
}
