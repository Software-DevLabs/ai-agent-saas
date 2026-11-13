import { describe, expect, it } from "vitest";
import { ProviderError, TransientProviderError, UsageUnavailableError } from "@saas/shared";
import { OllamaProvider } from "../src/ollama.ts";

const baseInput = {
  systemPrompt: "You are terse.",
  messages: [{ role: "user" as const, content: "hi" }],
  maxOutputTokens: 1024,
  temperature: 0.7,
};

function providerReturning(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new OllamaProvider({
    baseUrl: "http://127.0.0.1:11434",
    model: "gemma4:31b-cloud",
    fetchImpl: async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }),
  });
}

describe("OllamaProvider.run", () => {
  it("posts the chat shape ollama expects and returns real usage counts", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const provider = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma4:31b-cloud",
      fetchImpl: async (_url, init) => {
        seenBody = JSON.parse(String(init!.body));
        return new Response(
          JSON.stringify({ message: { role: "assistant", content: "OK" }, prompt_eval_count: 18, eval_count: 2, done: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const out = await provider.run(baseInput);
    expect(out).toEqual({ content: "OK", inputTokens: 18, outputTokens: 2, stopReason: "stop" });
    expect(seenBody).toMatchObject({
      model: "gemma4:31b-cloud",
      stream: false,
      options: { temperature: 0.7, num_predict: 1024 },
    });
    const messages = (seenBody as { messages: { role: string }[] }).messages;
    expect(messages[0]!.role).toBe("system");
    expect((seenBody as { format?: string }).format).toBeUndefined();
  });

  it("asks for a JSON object when the caller constrains the reply", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const provider = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.2:3b",
      fetchImpl: async (_url, init) => {
        seenBody = JSON.parse(String(init!.body));
        return new Response(
          JSON.stringify({ message: { role: "assistant", content: '{"sentiment":"POSITIVE"}' }, prompt_eval_count: 10, eval_count: 5, done: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await provider.run({ ...baseInput, tools: undefined, responseFormat: "json" });
    expect((seenBody as { format?: string }).format).toBe("json");
  });

  it("maps 429 and 5xx to transient errors that withRetry will repeat", async () => {
    await expect(providerReturning(429, { error: "too many" }).run(baseInput)).rejects.toThrow(TransientProviderError);
    await expect(providerReturning(503, { error: "unavailable" }).run(baseInput)).rejects.toThrow(TransientProviderError);
  });

  it("maps 4xx to a permanent ProviderError — a bad model name never fixes itself", async () => {
    await expect(providerReturning(404, { error: "model not found" }).run(baseInput)).rejects.toThrow(ProviderError);
    await expect(providerReturning(404, { error: "model not found" }).run(baseInput)).rejects.not.toBeInstanceOf(TransientProviderError);
  });

  it("throws UsageUnavailableError when the response hides the counts", async () => {
    await expect(
      providerReturning(200, { message: { content: "sure!" }, done: true }).run(baseInput),
    ).rejects.toThrow(UsageUnavailableError);
  });

  it("survives a network drop as transient, and an error-body as permanent", async () => {
    const down = new OllamaProvider({
      baseUrl: "http://127.0.0.1:1",
      model: "m",
      fetchImpl: async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
    });
    await expect(down.run(baseInput)).rejects.toThrow(TransientProviderError);

    const errBody = providerReturning(200, { error: 'ollama check manifest: missing digest' });
    await expect(errBody.run(baseInput)).rejects.toThrow(/ollama error/);
  });

  it("keeps zero counts as zero — absent and zero are different facts", async () => {
    const zero = providerReturning(200, { message: { content: "" }, prompt_eval_count: 0, eval_count: 0, done: true });
    const out = await zero.run(baseInput);
    expect(out).toEqual({ content: "", inputTokens: 0, outputTokens: 0, stopReason: "stop" });
  });
});

describe("OllamaProvider tool calling", () => {
  const withTools = {
    ...baseInput,
    tools: [
      {
        name: "subagent",
        description: "Delegate a task.",
        parameters: { type: "object", properties: { role: { type: "string" } }, required: ["role"] },
      },
    ],
  };

  it("sends tools in ollama's function shape and replays prior tool rounds", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const provider = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma4:31b-cloud",
      fetchImpl: async (_url, init) => {
        seenBody = JSON.parse(String(init!.body));
        return new Response(
          JSON.stringify({ message: { role: "assistant", content: "done" }, prompt_eval_count: 30, eval_count: 4 }),
          { status: 200 },
        );
      },
    });
    await provider.run({
      ...withTools,
      messages: [
        { role: "user", content: "research this" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ name: "subagent", arguments: { role: "researcher", task: "dig" } }],
        },
        { role: "tool", content: "found it", toolName: "subagent" },
      ],
    });

    expect(seenBody?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "subagent",
          description: "Delegate a task.",
          parameters: { type: "object", properties: { role: { type: "string" } }, required: ["role"] },
        },
      },
    ]);
    const messages = (seenBody as { messages: Record<string, unknown>[] }).messages;
    expect(messages[1]).toEqual({ role: "user", content: "research this" });
    expect(messages[2]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "subagent", arguments: { role: "researcher", task: "dig" } } }],
    });
    expect(messages[3]).toEqual({ role: "tool", content: "found it", tool_name: "subagent" });
  });

  it("omits tools when none are offered, so a plain turn keeps its old body", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const provider = new OllamaProvider({
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma4:31b-cloud",
      fetchImpl: async (_url, init) => {
        seenBody = JSON.parse(String(init!.body));
        return new Response(
          JSON.stringify({ message: { content: "hi" }, prompt_eval_count: 3, eval_count: 1 }),
          { status: 200 },
        );
      },
    });
    await provider.run(baseInput);
    expect(seenBody).not.toHaveProperty("tools");
  });

  it("parses tool_calls with object and JSON-string arguments into one shape", async () => {
    const provider = providerReturning(200, {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "subagent", arguments: { role: "researcher", task: "a" } } },
          { function: { name: "subagent", arguments: '{"role":"writer","task":"b"}' } },
        ],
      },
      prompt_eval_count: 40,
      eval_count: 12,
    });
    const out = await provider.run(withTools);
    expect(out.stopReason).toBe("tool_calls");
    expect(out.content).toBe("");
    expect(out.toolCalls).toEqual([
      { name: "subagent", arguments: { role: "researcher", task: "a" } },
      { name: "subagent", arguments: { role: "writer", task: "b" } },
    ]);
  });

  it("bills nothing silently: a tool round without usage counts is still a refusal", async () => {
    const provider = providerReturning(200, {
      message: { content: "", tool_calls: [{ function: { name: "subagent", arguments: {} } }] },
    });
    await expect(provider.run(withTools)).rejects.toThrow(UsageUnavailableError);
  });

  it("refuses malformed arguments and nameless calls as permanent errors", async () => {
    const badJson = providerReturning(200, {
      message: { content: "", tool_calls: [{ function: { name: "subagent", arguments: "{not json" } }] },
      prompt_eval_count: 5,
      eval_count: 5,
    });
    await expect(badJson.run(withTools)).rejects.toThrow(ProviderError);
    await expect(badJson.run(withTools)).rejects.not.toBeInstanceOf(TransientProviderError);

    const nameless = providerReturning(200, {
      message: { content: "", tool_calls: [{ function: { arguments: {} } }] },
      prompt_eval_count: 5,
      eval_count: 5,
    });
    await expect(nameless.run(withTools)).rejects.toThrow(/without a function name/);
  });
});

describe("OllamaProvider.supportsTools", () => {
  function probe(baseUrl: string, body: unknown, status = 200) {
    const seen: string[] = [];
    const provider = new OllamaProvider({
      baseUrl,
      model: "gemma4:31b-cloud",
      fetchImpl: async (url) => {
        seen.push(url);
        return new Response(JSON.stringify(body), { status });
      },
    });
    return { provider, seen };
  }

  it("is true only for an explicit tools capability", async () => {
    const yes = probe("http://probe-yes:1", { capabilities: ["completion", "tools", "vision"] });
    expect(await yes.provider.supportsTools()).toBe(true);
    expect(yes.seen[0]).toBe("http://probe-yes:1/api/show");

    const no = probe("http://probe-no:1", { capabilities: ["completion", "thinking"] });
    expect(await no.provider.supportsTools()).toBe(false);

    const missing = probe("http://probe-missing:1", {});
    expect(await missing.provider.supportsTools()).toBe(false);
  });

  it("caches the verdict per process so activation does not probe per click", async () => {
    const { provider, seen } = probe("http://probe-cache:1", { capabilities: ["tools"] });
    expect(await provider.supportsTools()).toBe(true);
    expect(await provider.supportsTools()).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("surfaces an unreachable or failing probe instead of guessing", async () => {
    const transient = probe("http://probe-503:1", {}, 503);
    await expect(transient.provider.supportsTools()).rejects.toThrow(TransientProviderError);

    const down = new OllamaProvider({
      baseUrl: "http://probe-down:1",
      model: "m",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(down.supportsTools()).rejects.toThrow(TransientProviderError);
  });
});

describe("OllamaProvider.embed", () => {
  function embedProvider(baseUrl: string, status: number, body: unknown) {
    const seen: { url: string; body: unknown }[] = [];
    const provider = new OllamaProvider({
      baseUrl,
      model: "gemma4:31b-cloud",
      fetchImpl: async (url, init) => {
        seen.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
        return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
      },
    });
    return { provider, seen };
  }

  it("posts /api/embed with the model and the inputs, and returns one vector per input", async () => {
    const { provider, seen } = embedProvider("http://embed-ok:1", 200, {
      embeddings: [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ],
    });
    const out = await provider.embed(["refund policy", "shipping"]);
    expect(out).toEqual({ vectors: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]], model: "nomic-embed-text", dim: 3 });
    expect(seen[0]!.url).toBe("http://embed-ok:1/api/embed");
    expect(seen[0]!.body).toEqual({ model: "nomic-embed-text", input: ["refund policy", "shipping"] });
  });

  it("does not call the daemon for an empty list — nothing to embed is not an error", async () => {
    const { provider, seen } = embedProvider("http://embed-empty:1", 200, {});
    expect(await provider.embed([])).toEqual({ vectors: [], model: "nomic-embed-text", dim: 0 });
    expect(seen).toHaveLength(0);
  });

  it("names the exact pull command when the model is missing, at 404 and in an error body", async () => {
    const missing = embedProvider("http://embed-404:1", 404, { error: "model not found" });
    await expect(missing.provider.embed(["x"])).rejects.toThrow(/`ollama pull nomic-embed-text`/);
    await expect(missing.provider.embed(["x"])).rejects.not.toBeInstanceOf(TransientProviderError);

    const slow = embedProvider("http://embed-body:1", 200, { error: 'model "mxbai": not found, try pulling it' });
    await expect(slow.provider.embed(["x"], "mxbai")).rejects.toThrow(/`ollama pull mxbai`/);
  });

  it("maps 429 and 5xx to transient errors so a queued embed can retry", async () => {
    await expect(embedProvider("http://embed-429:1", 429, {}).provider.embed(["x"])).rejects.toThrow(TransientProviderError);
    await expect(embedProvider("http://embed-503:1", 503, {}).provider.embed(["x"])).rejects.toThrow(TransientProviderError);
  });

  it("refuses ragged or non-numeric vectors before a row of the wrong dim is written", async () => {
    const ragged = embedProvider("http://embed-ragged:1", 200, { embeddings: [[0.1, 0.2], [0.3]] });
    await expect(ragged.provider.embed(["a", "b"])).rejects.toThrow(/different lengths/);

    const nan = embedProvider("http://embed-nan:1", 200, { embeddings: [[0.1, "x"]] });
    await expect(nan.provider.embed(["a"])).rejects.toThrow(/finite numbers/);

    const short = embedProvider("http://embed-short:1", 200, { embeddings: [[0.1]] });
    await expect(short.provider.embed(["a", "b"])).rejects.toThrow(/1 embedding\(s\) for 2 input\(s\)/);
  });

  it("refuses a blank input rather than embedding the empty document", async () => {
    const { provider, seen } = embedProvider("http://embed-blank:1", 200, { embeddings: [[0.1]] });
    await expect(provider.embed(["  "])).rejects.toThrow(ProviderError);
    expect(seen).toHaveLength(0);
  });
});

describe("OllamaProvider.listEmbedModels", () => {
  it("keeps only the models whose /api/show declares an embedding capability", async () => {
    const seen: string[] = [];
    const provider = new OllamaProvider({
      baseUrl: "http://list-embed:1",
      model: "gemma4:31b-cloud",
      fetchImpl: async (url, init) => {
        seen.push(url);
        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({ models: [{ name: "nomic-embed-text" }, { name: "gemma4:31b-cloud" }, { name: "broken" }] }),
            { status: 200 },
          );
        }
        const asked = JSON.parse(String(init?.body)).model as string;
        if (asked === "broken") return new Response("boom", { status: 500 });
        const capabilities = asked === "nomic-embed-text" ? ["embedding"] : ["completion", "tools"];
        return new Response(JSON.stringify({ capabilities }), { status: 200 });
      },
    });
    expect(await provider.listEmbedModels()).toEqual(["nomic-embed-text"]);
    // A failing probe for one tag must not hide the working one, and the list is cached.
    expect(seen.filter((url) => url.endsWith("/api/show"))).toHaveLength(3);
    expect(await provider.listEmbedModels()).toEqual(["nomic-embed-text"]);
    expect(seen.filter((url) => url.endsWith("/api/show"))).toHaveLength(3);
  });
});
