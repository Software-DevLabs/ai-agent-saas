import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  runAgentTurn,
  type AgentTool,
  type ModelCallResult,
  type ModelRunner,
  type RunnerFactory,
} from "../src/agent-run.ts";

const agent = {
  id: "agt_1",
  name: "Triage",
  status: "ACTIVE",
  systemPrompt: "Be terse.",
  modelProvider: "ollama",
  modelName: "test-model",
  temperature: 0.4,
  maxOutputTokens: 512,
};

/**
 * The slice of Prisma one turn touches. Ledger rows and decrements are recorded
 * separately so a test can count what was billed, not only what was returned.
 * `agentOver` restates the row, because which statuses may run is itself under
 * test.
 */
function fakeDb(agentOver: Record<string, unknown> = {}) {
  const usage: Record<string, unknown>[] = [];
  const decrements: bigint[] = [];
  const thread: Record<string, unknown>[] = [];
  let messageSeq = 0;
  const tx = {
    usageEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        usage.push(data);
        return { id: `ue_${usage.length}` };
      },
    },
    tenant: {
      update: async ({ data }: { data: { tokenBalance: { decrement: bigint } } }) => {
        decrements.push(data.tokenBalance.decrement);
        return {};
      },
    },
    conversationMessage: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        thread.push(data);
        messageSeq += 1;
        return { id: `msg_${messageSeq}` };
      },
    },
    webhookEventLog: {
      create: async () => ({ id: "evt_new" }),
      update: async () => ({}),
    },
    conversation: { update: async () => ({}) },
  };
  const db = {
    agent: { findFirst: async () => ({ ...agent, ...agentOver }) },
    // A running balance, not a constant: the point of the pre-round check is
    // that it sees what the previous rounds already spent.
    tenant: { findFirstOrThrow: async () => ({ tokenBalance: 10_000n - decrements.reduce((a, b) => a + b, 0n) }) },
    conversation: { upsert: async () => ({ id: "cnv_1", externalChatId: "console-playground" }) },
    conversationMessage: { findMany: async () => [] },
    $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
  };
  return { db: db as unknown as PrismaClient, usage, decrements, thread };
}

/** A runner that plays back scripted rounds and records each call it received. */
function scripted(rounds: (ModelCallResult | Error)[]): {
  runners: RunnerFactory;
  seen: { messages: unknown[]; tools?: unknown[] }[];
} {
  const queue = [...rounds];
  const seen: { messages: unknown[]; tools?: unknown[] }[] = [];
  const runner: ModelRunner = {
    name: "ollama",
    model: "test-model",
    run: async (input) => {
      // Snapshot: the loop keeps mutating one array, and a test wants to know
      // what each round actually saw.
      seen.push({ messages: [...input.messages], tools: input.tools });
      const next = queue.shift();
      if (next === undefined) throw new Error("the script ran out of rounds");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { runners: () => runner, seen };
}

const lookup: AgentTool = {
  name: "lookup",
  description: "Look a word up.",
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  execute: async (values) => `found ${String(values.q)}`,
};

const toolRound = (q: string, inputTokens: number, outputTokens: number): ModelCallResult => ({
  content: "",
  inputTokens,
  outputTokens,
  toolCalls: [{ name: "lookup", arguments: { q } }],
  stopReason: "tool_calls",
});

const finalRound = (content: string, inputTokens: number, outputTokens: number): ModelCallResult => ({
  content,
  inputTokens,
  outputTokens,
  stopReason: "stop",
});

describe("runAgentTurn tool loop", () => {
  it("bills every model round and writes one final message pair", async () => {
    const { db, usage, decrements, thread } = fakeDb();
    const { runners, seen } = scripted([
      toolRound("one", 10, 2),
      toolRound("two", 11, 3),
      finalRound("final", 20, 5),
    ]);

    const out = await runAgentTurn(db, "tnt_one", agent.id, { message: "hi", tools: [lookup] }, runners);

    expect(out.reply).toBe("final");
    expect(out.steps).toBe(3);
    expect(out.tokensUsed).toBe(51);
    expect(out.trace).toHaveLength(2);
    expect(out.trace.map((step) => step.resultPreview)).toEqual(["found one", "found two"]);
    expect(out.trace.every((step) => step.ok)).toBe(true);

    // Three rounds happened, so three ledger rows and three decrements — a tool
    // round is not free just because it produced no user-visible text.
    expect(usage).toHaveLength(3);
    expect(usage.map((row) => (row.metadata as { callIndex: number }).callIndex)).toEqual([1, 2, 3]);
    expect(usage.map((row) => (row.metadata as { stopReason: string }).stopReason)).toEqual([
      "tool_calls",
      "tool_calls",
      "stop",
    ]);
    expect(usage.map((row) => row.tokensUsed)).toEqual([12, 14, 25]);
    expect(decrements).toEqual([12n, 14n, 25n]);

    // Tool rounds are ephemeral: only the user message and the final reply land
    // in the thread, and the assistant row carries the whole turn's totals.
    expect(thread).toHaveLength(2);
    expect(thread[0]).toMatchObject({ role: "USER", content: "hi" });
    expect(thread[1]).toMatchObject({ role: "ASSISTANT", content: "final", inputTokens: 41, outputTokens: 10 });

    // Every round saw the tools, and the later rounds saw the tool results.
    expect(seen.every((call) => Array.isArray(call.tools))).toBe(true);
    expect(seen[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: "found one", toolName: "lookup" });
  });

  it("stops at the step cap with the cap named, after billing the round that hit it", async () => {
    const { db, usage } = fakeDb();
    const { runners } = scripted([toolRound("a", 5, 1), toolRound("b", 5, 1)]);
    await expect(
      runAgentTurn(db, "tnt_one", agent.id, { message: "hi", tools: [lookup], maxSteps: 2 }, runners),
    ).rejects.toMatchObject({ code: "tool_step_limit", status: 422 });
    expect(usage).toHaveLength(2);
  });

  it("refuses to start a round past the deadline, writing nothing", async () => {
    const { db, usage } = fakeDb();
    const { runners } = scripted([finalRound("never", 1, 1)]);
    await expect(
      runAgentTurn(db, "tnt_one", agent.id, { message: "hi", deadlineAt: Date.now() - 1 }, runners),
    ).rejects.toMatchObject({ code: "run_deadline", status: 504 });
    expect(usage).toHaveLength(0);
  });

  it("keeps earlier rounds billed when a later round fails", async () => {
    const { db, usage, decrements, thread } = fakeDb();
    const { runners } = scripted([toolRound("a", 7, 3), new Error("connection reset")]);
    await expect(
      runAgentTurn(db, "tnt_one", agent.id, { message: "hi", tools: [lookup] }, runners),
    ).rejects.toMatchObject({ code: "provider_failed", status: 502 });
    expect(usage).toHaveLength(1);
    expect(decrements).toEqual([10n]);
    // The failed round wrote no reply: a turn that did not finish says so by
    // leaving the thread untouched.
    expect(thread).toHaveLength(0);
  });

  it("turns an unknown tool call into a visible error result, not a silent success", async () => {
    const { db } = fakeDb();
    const { runners } = scripted([
      {
        content: "",
        inputTokens: 3,
        outputTokens: 1,
        toolCalls: [{ name: "teleport", arguments: {} }],
        stopReason: "tool_calls",
      },
      finalRound("ok", 3, 1),
    ]);
    const out = await runAgentTurn(db, "tnt_one", agent.id, { message: "hi", tools: [lookup] }, runners);
    expect(out.trace[0]).toMatchObject({ tool: "teleport", ok: false });
    expect(out.trace[0]?.resultPreview).toContain("TOOL_ERROR");
  });
});

describe("runAgentTurn refusals before a round", () => {
  it("stops a tool turn the moment the balance reaches zero, billing only the round that happened", async () => {
    const { db, usage, decrements, thread } = fakeDb();
    // Round one costs the whole cycle: 10,000 tokens, so the balance the fake
    // derives from the decrements is exactly zero for round two.
    const { runners } = scripted([toolRound("a", 10_000, 0), finalRound("never reached", 1, 1)]);
    await expect(
      runAgentTurn(db, "tnt_one", agent.id, { message: "hi", tools: [lookup] }, runners),
    ).rejects.toMatchObject({ code: "quota_exhausted", status: 402 });
    expect(usage).toHaveLength(1);
    expect(decrements).toEqual([10_000n]);
    expect(thread).toHaveLength(0);
  });

  it("refuses an agent the console already marked broken", async () => {
    const { db, usage } = fakeDb({ status: "ERROR" });
    const { runners } = scripted([finalRound("no", 1, 1)]);
    await expect(
      runAgentTurn(db, "tnt_one", agent.id, { message: "hi" }, runners),
    ).rejects.toMatchObject({ code: "agent_not_active", status: 409 });
    expect(usage).toHaveLength(0);
  });

  it("lets a draft answer the playground, because that is how it gets written", async () => {
    const { db, usage } = fakeDb({ status: "DRAFT" });
    const { runners } = scripted([finalRound("still working on it", 4, 2)]);
    const out = await runAgentTurn(db, "tnt_one", agent.id, { message: "hi" }, runners);
    expect(out.reply).toBe("still working on it");
    expect(usage).toHaveLength(1);
  });

  it("refuses a draft on a public surface, and writes nothing", async () => {
    const { db, usage, thread } = fakeDb({ status: "DRAFT" });
    const { runners } = scripted([finalRound("should never run", 4, 2)]);
    await expect(
      runAgentTurn(db, "tnt_one", agent.id, { message: "hi", requireActive: true }, runners),
    ).rejects.toMatchObject({ code: "agent_not_active", status: 409 });
    expect(usage).toHaveLength(0);
    expect(thread).toHaveLength(0);
  });
});
