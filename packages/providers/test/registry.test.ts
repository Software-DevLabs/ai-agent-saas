import { describe, expect, it } from "vitest";
import { registerProvider, resolveProvider, __resetProviderRegistry } from "../src/index.ts";

const deps = { config: { ollamaBaseUrl: "http://x", ollamaModel: "m", ollamaTimeoutMs: 1000 } };

describe("provider registry", () => {
  it("ships ollama registered at import time", () => {
    // index.ts self-registers; resolve must find it without any wiring.
    expect(() => resolveProvider("ollama", deps)).not.toThrow();
  });

  it("refuses to shadow an existing name", () => {
    expect(() => registerProvider("ollama", () => resolveProvider("ollama", deps))).toThrow(/already registered/);
  });

  it("names the registered set when a lookup misses", () => {
    expect(() => resolveProvider("gpt9000", deps)).toThrow(/unknown provider "gpt9000"/);
    expect(() => resolveProvider("gpt9000", deps)).toThrow(/ollama/);
  });

  it("duplicate rule survives a fresh registry (boot order cannot hide it)", () => {
    __resetProviderRegistry();
    registerProvider("only", () => ({
      name: "only",
      model: "m",
      run: async () => ({ content: "", inputTokens: 0, outputTokens: 0, stopReason: "stop" as const }),
    }));
    expect(() => registerProvider("only", () => resolveProvider("only", deps))).toThrow(/refusing to shadow/);
    __resetProviderRegistry();
    registerProvider("ollama", ({ config }) => ({
      name: "ollama",
      model: config.ollamaModel,
      run: async () => ({ content: "", inputTokens: 0, outputTokens: 0, stopReason: "stop" as const }),
    }));
  });
});
