import { describe, expect, it } from "vitest";
import { HttpError } from "@saas/shared";
import {
  CLASSIFY_LANE,
  SENTIMENT_SYSTEM_PROMPT,
  classifySentiment,
  parseSentiment,
  type ModelCallResult,
  type ModelRunner,
} from "../src/index.ts";

/**
 * The classifier's deterministic half: what a reply means, and what a reply we
 * cannot read means. The model is scripted here — whether a local model picks a
 * good label is not something a unit test can assert, but "ANGRY" never becoming
 * NEGATIVE, and "I cannot tell" never becoming a guess, are.
 */

function runner(reply: string, over: Partial<ModelCallResult> = {}): { runner: ModelRunner; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    runner: {
      name: "ollama",
      model: "test-model",
      run: async (input) => {
        calls.push(input);
        return { content: reply, inputTokens: 120, outputTokens: 8, stopReason: "stop", ...over };
      },
    },
  };
}

describe("parsing a sentiment reply", () => {
  it("reads a plain JSON object", () => {
    expect(parseSentiment('{"sentiment":"NEGATIVE","score":0.82}')).toEqual({ sentiment: "NEGATIVE", score: 0.82, reason: null });
  });

  it("reads JSON wrapped in prose or a fence without coercing the label", () => {
    expect(parseSentiment('Here you go:\n```json\n{"sentiment":"positive","score":0.6}\n```').sentiment).toBe("POSITIVE");
    expect(parseSentiment('Result: {"sentiment":"NEUTRAL","score":0.5} — done').sentiment).toBe("NEUTRAL");
  });

  it("keeps a model's own UNKNOWN as a model judgement, not a parse failure", () => {
    const parsed = parseSentiment('{"sentiment":"UNKNOWN","score":0.4}');
    expect(parsed).toEqual({ sentiment: "UNKNOWN", score: 0.4, reason: null });
  });

  it("refuses a label outside the taxonomy and says what it saw", () => {
    const parsed = parseSentiment('{"sentiment":"ANGRY","score":0.9}');
    expect(parsed.sentiment).toBe("UNKNOWN");
    expect(parsed.score).toBeNull();
    expect(parsed.reason).toContain("ANGRY");
  });

  it("does not invent a score the model did not give", () => {
    expect(parseSentiment('{"sentiment":"POSITIVE"}').score).toBeNull();
    expect(parseSentiment('{"sentiment":"POSITIVE","score":1.4}').score).toBeNull();
    expect(parseSentiment('{"sentiment":"POSITIVE","score":"high"}').score).toBeNull();
    // …and an unusable score does not discard a label that was usable.
    expect(parseSentiment('{"sentiment":"POSITIVE","score":"high"}').sentiment).toBe("POSITIVE");
  });

  it("calls a reply with no JSON unparseable rather than neutral", () => {
    expect(parseSentiment("I think the customer seems annoyed.")).toMatchObject({ sentiment: "UNKNOWN", score: null });
    expect(parseSentiment("I think the customer seems annoyed.").reason).toContain("no JSON");
    expect(parseSentiment("{not json}").reason).toContain("did not parse");
  });
});

describe("classifying one question", () => {
  it("sends only the question, as delimited data, with no tools and JSON mode", async () => {
    const { runner: scripted, calls } = runner('{"sentiment":"NEUTRAL","score":0.7}');
    const result = await classifySentiment(scripted, { question: "How do I reset my password?" });

    expect(result).toMatchObject({ sentiment: "NEUTRAL", score: 0.7, source: "model", tokensUsed: 128, provider: "ollama", model: "test-model" });
    const call = calls[0] as { systemPrompt: string; messages: Array<{ role: string; content: string }>; tools?: unknown; temperature: number; responseFormat?: string };
    expect(call.systemPrompt).toBe(SENTIMENT_SYSTEM_PROMPT);
    expect(call.temperature).toBe(0);
    expect(call.tools).toBeUndefined();
    expect(call.responseFormat).toBe("json");
    expect(call.messages[0]?.content).toBe("<question>\nHow do I reset my password?\n</question>");
  });

  it("marks an unreadable reply UNKNOWN but still reports the tokens it cost", async () => {
    const { runner: scripted } = runner("the customer is angry!");
    const result = await classifySentiment(scripted, { question: "Ugh, again?" });
    expect(result.sentiment).toBe("UNKNOWN");
    expect(result.source).toBe("unparseable");
    expect(result.tokensUsed).toBe(128);
    expect(result.reason).not.toBeNull();
  });

  it("is unparseable — not an error — when the model invented a fourth label", async () => {
    const { runner: scripted } = runner('{"sentiment":"FURIOUS","score":0.99}');
    const result = await classifySentiment(scripted, { question: "Why is this broken?" });
    expect(result).toMatchObject({ sentiment: "UNKNOWN", source: "unparseable", tokensUsed: 128 });
  });

  it("turns a provider failure into provider_failed so the lane can retry it", async () => {
    const failing: ModelRunner = {
      name: "ollama",
      model: "test-model",
      run: async () => {
        throw new Error("connection refused");
      },
    };
    await expect(classifySentiment(failing, { question: "hi" })).rejects.toMatchObject({
      code: "provider_failed",
      status: 502,
    });
  });

  it("refuses a call that reported no usage instead of billing zero", async () => {
    const { runner: scripted } = runner('{"sentiment":"POSITIVE","score":0.5}', { inputTokens: 0, outputTokens: 0 });
    await expect(classifySentiment(scripted, { question: "thanks!" })).rejects.toBeInstanceOf(HttpError);
  });
});

describe("the lane name", () => {
  it("is its own lane, not a reuse of embed.turn", () => {
    expect(CLASSIFY_LANE).toBe("feedback.classify");
  });
});
