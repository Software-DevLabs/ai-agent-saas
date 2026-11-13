import { resolveProvider } from "@saas/providers";
import type { ProviderConfig } from "@saas/providers";
import type { QueryEmbedder } from "@saas/core";

/**
 * The API's query embedder: one place that turns a question into a vector, so the
 * playground turn and the knowledge search box agree about which model answered.
 *
 * It is deliberately not per-agent. An agent's chat model is its own business; the
 * embedding model is a property of the deployment, because two agents embedding the
 * same chunk under different models would put two incomparable numbers in one table.
 * A daemon that cannot embed is reported by returning `null`, which makes retrieval
 * keyword-only rather than failing the request.
 */
export function makeQueryEmbedder(config: ProviderConfig): QueryEmbedder {
  // A caller that configured no embedding model has none. The adapter would
  // otherwise fall back to its own default and quietly reach for a daemon the
  // entrypoint never named — which is how a test double becomes a network call.
  if (config.ollamaEmbedModel === undefined || config.ollamaEmbedModel === "") {
    return async () => null;
  }
  return async (text) => {
    const provider = resolveProvider("ollama", { config });
    if (provider.embed === undefined) return null;
    const result = await provider.embed([text]);
    const vector = result.vectors[0];
    return vector === undefined ? null : { vector, model: result.model, dim: result.dim };
  };
}
