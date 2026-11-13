import { registerProvider } from "./registry.ts";
import { OllamaProvider } from "./ollama.ts";

export type {
  ModelProvider,
  ModelRunInput,
  ModelRunResult,
  ModelMessage,
  ToolDefinition,
  ToolCall,
  ProviderConfig,
  ProviderFactory,
  EmbedResult,
} from "./types.ts";
export { registerProvider, resolveProvider, registeredProviders, __resetProviderRegistry } from "./registry.ts";
export { OllamaProvider } from "./ollama.ts";

// Importing this package is what populates the registry; a new adapter is a
// new file here, never an `if` in the worker.
registerProvider(
  "ollama",
  ({ config }) =>
    new OllamaProvider({
      baseUrl: config.ollamaBaseUrl,
      model: config.ollamaModel,
      timeoutMs: config.ollamaTimeoutMs,
      ...(config.ollamaEmbedModel === undefined || config.ollamaEmbedModel === "" ? {} : { embedModel: config.ollamaEmbedModel }),
    }),
);
