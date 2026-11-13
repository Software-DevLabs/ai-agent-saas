import { loadConfigFromEnv } from "@saas/shared";
import { resolveProvider } from "@saas/providers";

/**
 * Live smoke — one real call, no mocks. Kept out of vitest on purpose:
 * unit tests must never touch the network, but the exit gate for M3 says
 * this exact path works against the running daemon.
 */
const config = loadConfigFromEnv();
const provider = resolveProvider("ollama", {
  config: {
    ollamaBaseUrl: config.OLLAMA_BASE_URL,
    ollamaModel: config.OLLAMA_MODEL,
    ollamaTimeoutMs: config.OLLAMA_TIMEOUT_MS,
  },
});

const result = await provider.run({
  systemPrompt: "You answer with a single word.",
  messages: [{ role: "user", content: "Reply with exactly: OK" }],
  maxOutputTokens: 16,
  temperature: 0,
});

console.log(JSON.stringify({ provider: provider.name, model: provider.model, ...result }));
