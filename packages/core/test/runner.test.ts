import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Keyring } from "@saas/shared";
import type { ModelCallResult, ModelMessage, RunnerFactory, ToolDefinition } from "../src/agent-run.ts";
import { executeGraph } from "../src/runner.ts";
import type { Queue, QueueJob } from "../src/queue.ts";

const keyring = new Keyring({ id: "k1", key: Buffer.alloc(32, 7) });
const sinkUrl = "http://sink.test/hook";

const agents = [
  {
    id: "agt_orch",
    name: "Boss",
    projectId: "prj_one",
    status: "READY",
    systemPrompt: "Delegate what you cannot do.",
    modelProvider: "ollama",
    modelName: "orch-model",
    temperature: 0.2,
    maxOutputTokens: 512,
  },
  {
    id: "agt_sub",
    name: "Writer",
    projectId: "prj_one",
    status: "READY",
    systemPrompt: "Write.",
    modelProvider: "ollama",
    modelName: "sub-model",
    temperature: 0.2,
    maxOutputTokens: 512,
  },
];

const integrations = [
  { id: "int_in", type: "TELEGRAM_IN", externalId: "bot", projectId: "prj_one", status: "CONNECTED", credentialsEncrypted: "" },
  {
    id: "int_out",
    type: "WEBHOOK_OUT",
    externalId: "sink",
    projectId: "prj_one",
    status: "CONNECTED",
    credentialsEncrypted: keyring.encrypt(sinkUrl),
  },
];

const definition = {
  nodes: [
    { key: "in", kind: "INBOUND", position: { x: 0, y: 0 }, config: { integrationId: "int_in" } },
    {
      key: "orch",
      kind: "ORCHESTRATOR",
      position: { x: 200, y: 0 },
      config: { agentId: "agt_orch", subagents: [{ agentId: "agt_sub", role: "writer" }] },
    },
    { key: "out", kind: "OUTBOUND", position: { x: 400, y: 0 }, config: { integrationId: "int_out" } },
  ],
  edges: [
    { from: "in", to: "orch" },
    { from: "orch", to: "out" },
  ],
};

const dependencies = [
  { kind: "AGENT", refId: "agt_orch" },
  { kind: "AGENT", refId: "agt_sub" },
  { kind: "INTEGRATION", refId: "int_in" },
  { kind: "INTEGRATION", refId: "int_out" },
];

function fakeDb(options: { missingSubagent?: boolean } = {}) {
  const usage: Record<string, unknown>[] = [];
  const decrements: bigint[] = [];
  const nodes = new Map<string, Record<string, unknown>>();
  const run: Record<string, unknown> = { id: "run_1", startedAt: new Date() };

  const tx = {
    workflowRun: {
      findFirst: async () => null,
      create: async () => ({ id: run.id, startedAt: run.startedAt }),
    },
    workflowNodeRun: {
      upsert: async ({ create }: { create: Record<string, unknown> & { nodeKey: string } }) => {
        const key = `${create.runId}:${create.nodeKey}`;
        if (!nodes.has(key)) nodes.set(key, { ...create, status: "PENDING" });
        return nodes.get(key);
      },
      findFirst: async ({ where }: { where: { AND: { runId?: string; nodeKey?: string }[] } }) =>
        nodes.get(`${where.AND[0]?.runId}:${where.AND[1]?.nodeKey}`) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { AND: { runId?: string; nodeKey?: string; status?: string }[] };
        data: Record<string, unknown> & { attempt?: { increment: number } };
      }) => {
        if (where.AND[1]?.nodeKey === undefined) {
          // markUnreached: every node still PENDING in this run.
          for (const [key, row] of nodes) {
            if (key.startsWith(`${where.AND[0]?.runId}:`) && row.status === "PENDING") Object.assign(row, data);
          }
          return { count: 0 };
        }
        const row = nodes.get(`${where.AND[0]?.runId}:${where.AND[1].nodeKey}`);
        if (row) {
          Object.assign(row, data);
          if (data.attempt) row.attempt = ((row.attempt as number | undefined) ?? 0) + data.attempt.increment;
        }
        return { count: row ? 1 : 0 };
      },
    },
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
    conversationMessage: { create: async () => ({ id: "msg_x" }) },
    webhookEventLog: { update: async () => ({}) },
    conversation: { update: async () => ({}) },
  };

  const db = {
    workflow: {
      findFirst: async () => ({
        id: "wf_1",
        projectId: "prj_one",
        name: "Delegation",
        version: 2,
        status: "ACTIVE",
        definition,
      }),
    },
    agent: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const clause = (where.AND as { id?: { in?: string[] } }[] | undefined)?.[1];
        const wanted = clause?.id?.in;
        return agents.filter((row) => wanted === undefined || wanted.includes(row.id));
      },
      findFirst: async ({ where }: { where: { AND: { id?: string }[] } }) => {
        const id = where.AND[0]?.id;
        if (options.missingSubagent && id === "agt_sub") return null;
        return agents.find((row) => row.id === id) ?? null;
      },
    },
    integration: {
      findMany: async () => integrations,
      findFirst: async ({ where }: { where: { AND: { id?: string }[] } }) =>
        integrations.find((row) => row.id === where.AND[0]?.id) ?? null,
    },
    workflowDependency: { findMany: async () => dependencies },
    // Every turn now assembles its capabilities, so the double needs the grant
    // side. Empty means "this agent was granted nothing", which is what these
    // tests were always running: prompt as written, no catalogue, no tools.
    agentCapability: { findMany: async () => [] },
    skill: { findMany: async () => [] },
    skillVersion: { findMany: async () => [] },
    // The world probe asks whether anything is searchable on every assembly.
    knowledgeDoc: { count: async () => 0, findMany: async () => [] },
    workflowRun: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return run;
      },
    },
    workflowNodeRun: tx.workflowNodeRun,
    tenant: { findFirstOrThrow: async () => ({ tokenBalance: 1_000_000n }) },
    conversation: { upsert: async ({ where }: { where: { agentId_externalChatId: { externalChatId: string } } }) => ({
      id: `cnv_${where.agentId_externalChatId.externalChatId}`,
      externalChatId: where.agentId_externalChatId.externalChatId,
    }) },
    conversationMessage: { findMany: async () => [] },
    $transaction: async (fn: (client: unknown) => Promise<unknown>) => fn(tx),
  };

  return {
    db: db as unknown as PrismaClient,
    usage,
    decrements,
    nodes,
    run,
  };
}

function scriptedRunners(scripts: Record<string, (ModelCallResult | Error)[]>) {
  const seen: { model: string; messages: ModelMessage[]; tools?: ToolDefinition[] }[] = [];
  const factory: RunnerFactory = ({ model }) => ({
    name: "ollama",
    model,
    run: async (input) => {
      seen.push({ model, messages: input.messages, tools: input.tools });
      const next = scripts[model]?.shift();
      if (next === undefined) throw new Error(`no scripted round for ${model}`);
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { factory, seen };
}

function queueStub() {
  const calls = { succeeded: 0, dead: 0 };
  const queue: Queue = {
    enqueue: async () => ({ id: "job_1", duplicate: false }),
    claim: async () => null,
    heartbeat: async () => true,
    attachRun: async () => {},
    succeed: async () => {
      calls.succeeded += 1;
    },
    retry: async () => {},
    dead: async () => {
      calls.dead += 1;
    },
    release: async () => {},
    counts: async () => ({ queued: 0, claimed: 0, failed: 0, dead: 0 }),
  };
  return { queue, calls };
}

const job: QueueJob = {
  id: "job_1",
  tenantId: "tnt_one",
  lane: "graph.run",
  source: "console-test",
  externalMessageId: "ext_1",
  payload: { workflowId: "wf_1", message: "please draft the update" },
  workflowId: null,
  runId: null,
  attempts: 0,
  maxAttempts: 3,
};

function run(db: PrismaClient, runners: RunnerFactory, queue: Queue) {
  return executeGraph({
    db,
    queue,
    keyring,
    job,
    workerId: "w1",
    leaseMs: 60_000,
    heartbeatMs: 60_000,
    deadlineMs: 60_000,
    runners,
    maxToolSteps: 6,
    maxSubagentCalls: 4,
  });
}

const subagentCall = (role: string, task: string): ModelCallResult => ({
  content: "",
  inputTokens: 10,
  outputTokens: 2,
  toolCalls: [{ name: "subagent", arguments: { role, task } }],
  stopReason: "tool_calls",
});

const finalRound = (content: string, inputTokens: number, outputTokens: number): ModelCallResult => ({
  content,
  inputTokens,
  outputTokens,
  stopReason: "stop",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("orchestrator node execution", () => {
  it("delegates through the subagent tool, bills every turn and stores tokens plus trace", async () => {
    const fetchStub = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);

    const fixture = fakeDb();
    const { queue, calls } = queueStub();
    const { factory, seen } = scriptedRunners({
      "orch-model": [subagentCall("writer", "draft the update"), finalRound("final answer", 8, 4)],
      "sub-model": [finalRound("draft text", 5, 3)],
    });

    const result = await run(fixture.db, factory, queue);

    expect(result).toMatchObject({ outcome: "succeeded", output: "final answer", tokensUsed: 32 });
    expect(calls.succeeded).toBe(1);

    // The orchestrator's two rounds plus the subagent turn: three model calls,
    // three ledger rows, and the subagent row names its role.
    expect(fixture.usage).toHaveLength(3);
    expect(fixture.usage.map((row) => (row.metadata as { origin: string }).origin)).toEqual([
      "workflow-orchestrator",
      "workflow-subagent",
      "workflow-orchestrator",
    ]);
    expect(fixture.usage[1]?.metadata).toMatchObject({ role: "writer", callIndex: 1, nodeKey: "orch" });
    expect(fixture.decrements.reduce((sum, value) => sum + value, 0n)).toBe(32n);

    const node = fixture.nodes.get("run_1:orch");
    expect(node).toMatchObject({ status: "SUCCEEDED", tokensUsed: 32, output: "final answer" });
    const trace = node?.trace as { tool: string; ok: boolean; resultPreview: string }[];
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ tool: "subagent", ok: true });
    expect(trace[0]?.resultPreview).toContain("draft text");

    expect(fixture.run).toMatchObject({ status: "SUCCEEDED", tokensUsed: 32 });

    // The sink really was called with the orchestrator's answer.
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]?.[0]).toBe(sinkUrl);
    expect(JSON.parse(String((fetchStub.mock.calls[0]?.[1] as { body: string } | undefined)?.body))).toEqual({
      text: "final answer",
    });

    // The second orchestrator round saw the subagent's words as the tool result.
    const secondOrch = seen.filter((call) => call.model === "orch-model")[1];
    expect(secondOrch?.tools?.[0]?.name).toBe("subagent");
    expect(secondOrch?.messages.at(-1)).toMatchObject({ role: "tool", content: "draft text", toolName: "subagent" });
  });

  it("hands an undeclared role back as SUBAGENT_ERROR instead of running anything", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const fixture = fakeDb();
    const { queue } = queueStub();
    const { factory, seen } = scriptedRunners({
      "orch-model": [subagentCall("ghost", "do something"), finalRound("I could not delegate", 6, 2)],
      // No script for sub-model: reaching it would throw and fail the run.
    });

    const result = await run(fixture.db, factory, queue);

    expect(result).toMatchObject({ outcome: "succeeded", output: "I could not delegate" });
    const secondOrch = seen.filter((call) => call.model === "orch-model")[1];
    expect(secondOrch?.messages.at(-1)).toMatchObject({ role: "tool", toolName: "subagent" });
    expect((secondOrch?.messages.at(-1) as { content: string }).content).toMatch(
      /^SUBAGENT_ERROR: no declared subagent has role "ghost"/,
    );
    // Only the orchestrator's own rounds were billed; nothing was delegated.
    expect(fixture.usage.map((row) => (row.metadata as { origin: string }).origin)).toEqual([
      "workflow-orchestrator",
      "workflow-orchestrator",
    ]);
    const trace = fixture.nodes.get("run_1:orch")?.trace as { resultPreview: string }[];
    expect(trace[0]?.resultPreview).toContain("SUBAGENT_ERROR");
  });

  it("surfaces a subagent that vanished as a tool error, never as a fabricated reply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const fixture = fakeDb({ missingSubagent: true });
    const { queue } = queueStub();
    const { factory, seen } = scriptedRunners({
      "orch-model": [subagentCall("writer", "draft the update"), finalRound("recovered without it", 4, 2)],
    });

    const result = await run(fixture.db, factory, queue);

    expect(result).toMatchObject({ outcome: "succeeded", output: "recovered without it" });
    const secondOrch = seen.filter((call) => call.model === "orch-model")[1];
    expect((secondOrch?.messages.at(-1) as { content: string }).content).toBe(
      'SUBAGENT_ERROR: subagent "writer" points at an agent that no longer exists',
    );
    expect(fixture.usage).toHaveLength(2);
  });
});
