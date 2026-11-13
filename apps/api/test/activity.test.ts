import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "@saas/core";
import { Keyring, createLogger } from "@saas/shared";
import { createApp } from "../src/app.ts";
import type { RouteDeps } from "../src/routes.ts";

const log = createLogger({ LOG_LEVEL: "fatal", LOG_PRETTY: "0" });
const keyring = new Keyring({ id: "k1", key: Buffer.alloc(32, 7) });

const queue = {
  enqueue: async () => ({ id: "job_1", duplicate: false }),
  claim: async () => null,
  heartbeat: async () => true,
  attachRun: async () => {},
  succeed: async () => {},
  retry: async () => {},
  dead: async () => {},
  release: async () => {},
  counts: async () => ({ queued: 0, claimed: 0, failed: 0, dead: 0 }),
} satisfies Queue;

type Row = Record<string, unknown>;

const T = {
  a: new Date("2026-10-05T10:00:00Z"),
  b: new Date("2026-10-05T11:00:00Z"),
  c: new Date("2026-10-05T12:00:00Z"),
  d: new Date("2026-10-05T13:00:00Z"),
};

/** Direct turns. One belongs to another tenant: the feed must never see it. */
const AGENT_RUNS: Row[] = [
  {
    tenantId: "tnt_one",
    id: "arun_1",
    projectId: "prj_one",
    agentId: "agt_1",
    agentName: "Triage",
    triggerSource: "console-playground",
    status: "RUNNING",
    conversationId: null,
    externalChatId: null,
    input: "hello there",
    output: null,
    error: null,
    tokensUsed: 0,
    stepCount: 1,
    toolCallCount: 0,
    durationMs: null,
    startedAt: T.d,
    finishedAt: null,
  },
  {
    tenantId: "tnt_one",
    id: "arun_2",
    projectId: "prj_one",
    agentId: "agt_2",
    agentName: "Writer",
    triggerSource: "telegram",
    status: "SUCCEEDED",
    conversationId: "cnv_1",
    externalChatId: "bot-1",
    input: "  rewrite   this\n please  ",
    output: "done",
    error: null,
    tokensUsed: 420,
    stepCount: 3,
    toolCallCount: 1,
    durationMs: 2_100,
    startedAt: T.b,
    finishedAt: T.c,
  },
  {
    tenantId: "tnt_VICTIM",
    id: "arun_victim",
    projectId: "prj_other",
    agentId: "agt_9",
    agentName: "Someone else's agent",
    triggerSource: "telegram",
    status: "SUCCEEDED",
    conversationId: null,
    externalChatId: null,
    input: "a secret question",
    output: "a secret answer",
    error: null,
    tokensUsed: 999,
    stepCount: 1,
    toolCallCount: 0,
    durationMs: 100,
    startedAt: T.d,
    finishedAt: T.d,
  },
];

/** Graph nodes. Only AGENT and ORCHESTRATOR kinds belong in the feed. */
const NODE_RUNS: Row[] = [
  {
    tenantId: "tnt_one",
    id: "node_1",
    runId: "wfrun_1",
    nodeKey: "agent",
    kind: "AGENT",
    label: "Writer node",
    refId: "agt_2",
    status: "SUCCEEDED",
    input: "draft",
    output: "final",
    tokensUsed: 300,
    durationMs: 1_500,
    startedAt: T.c,
    finishedAt: T.c,
    run: { workflowId: "wf_1", workflowName: "Inbound triage" },
  },
  {
    tenantId: "tnt_one",
    id: "node_2",
    runId: "wfrun_1",
    nodeKey: "sink",
    kind: "OUTBOUND",
    label: "Reply",
    refId: null,
    status: "SUCCEEDED",
    input: "final",
    output: null,
    tokensUsed: 0,
    durationMs: 10,
    startedAt: T.d,
    finishedAt: T.d,
    run: { workflowId: "wf_1", workflowName: "Inbound triage" },
  },
  {
    tenantId: "tnt_one",
    id: "node_3",
    runId: "wfrun_2",
    nodeKey: "orch",
    kind: "ORCHESTRATOR",
    label: "Router",
    refId: "agt_1",
    status: "PENDING",
    input: null,
    output: null,
    tokensUsed: 0,
    durationMs: null,
    startedAt: T.a,
    finishedAt: null,
    run: { workflowId: "wf_gone", workflowName: "Deleted graph" },
  },
];

const WORKFLOW_RUNS: Row[] = [
  {
    tenantId: "tnt_one",
    id: "wfrun_1",
    workflowId: "wf_1",
    workflowName: "Inbound triage",
    workflowVersion: 4,
    status: "SUCCEEDED",
    triggerSource: "telegram",
    input: "hi",
    output: "ok",
    error: null,
    tokensUsed: 500,
    durationMs: 900,
    startedAt: T.c,
    finishedAt: T.d,
  },
  {
    tenantId: "tnt_one",
    id: "wfrun_2",
    workflowId: "wf_gone",
    workflowName: "Deleted graph",
    workflowVersion: 1,
    status: "FAILED",
    triggerSource: "console-test",
    input: "hi",
    output: null,
    error: "node blew up",
    tokensUsed: 0,
    durationMs: 50,
    startedAt: T.b,
    finishedAt: T.c,
  },
];

const WORKFLOWS: Row[] = [
  { id: "wf_1", tenantId: "tnt_one", projectId: "prj_one", name: "Inbound triage" },
  { id: "wf_other", tenantId: "tnt_VICTIM", projectId: "prj_other", name: "Their graph" },
];

const AGENTS: Row[] = [
  agent("agt_1", "Triage"),
  agent("agt_2", "Writer"),
];

/** The full read shape: `/agents/:id/runs` resolves the agent before it lists. */
function agent(id: string, name: string): Row {
  return {
    id,
    tenantId: "tnt_one",
    projectId: "prj_one",
    name,
    status: "ACTIVE",
    systemPrompt: "You answer briefly.",
    modelProvider: "ollama",
    modelName: "test-model",
    temperature: 0.2,
    maxOutputTokens: 512,
    createdAt: T.a,
    _count: { conversations: 1, integrations: 0 },
  };
}

const STEPS: Row[] = [
  step(1, 1, "MODEL", null),
  step(2, 2, "TOOL", "search_crm"),
  step(3, 3, "MODEL", null),
];

function step(seq: number, round: number, kind: "MODEL" | "TOOL", tool: string | null): Row {
  return {
    id: `astep_${seq}`,
    runId: "arun_2",
    seq,
    round,
    kind,
    tool,
    argsPreview: tool ? `{\"q\":\"acme\"}` : null,
    resultPreview: tool ? "3 rows" : null,
    ok: tool ? true : null,
    inputTokens: 100,
    outputTokens: 40,
    durationMs: 300,
    createdAt: T.b,
  };
}

/**
 * `scoped()` nests filters under `AND`, so the stub walks the same shape Prisma
 * gets. An unrecognised filter throws rather than matching quietly: a test that
 * silently ignored a new clause would pass whether the clause worked or not.
 */
function matches(where: unknown, row: Row): boolean {
  const clause = where as Row;
  if (Array.isArray(clause.AND)) return clause.AND.every((part) => matches(part, row));
  return Object.entries(clause).every(([key, want]) => {
    const value = row[key];
    if (want instanceof Date || typeof want === "string" || typeof want === "number" || want === null) {
      return value === want;
    }
    const filter = want as Row;
    if ("in" in filter) return (filter.in as unknown[]).includes(value);
    if ("lt" in filter) return (value as Date) < (filter.lt as Date);
    throw new Error(`activity stub does not understand the "${key}" filter`);
  });
}

function selectRows(source: Row[], args: { where: unknown; take?: number; orderBy?: Row } | undefined): Row[] {
  const rows = source.filter((row) => matches(args?.where, row));
  const orderBy = args?.orderBy as { startedAt?: "asc" | "desc"; seq?: "asc" | "desc" } | undefined;
  if (orderBy?.startedAt) {
    const dir = orderBy.startedAt === "asc" ? 1 : -1;
    rows.sort((a, b) => dir * (new Date(a.startedAt as Date).getTime() - new Date(b.startedAt as Date).getTime()));
  }
  if (orderBy?.seq) {
    const dir = orderBy.seq === "asc" ? 1 : -1;
    rows.sort((a, b) => dir * ((a.seq as number) - (b.seq as number)));
  }
  return args?.take === undefined ? rows.map((row) => ({ ...row })) : rows.slice(0, args.take).map((row) => ({ ...row }));
}

interface Probe {
  app: ReturnType<typeof createApp>;
  /** Every where clause the read layer actually sent, so isolation is a fact rather than a hope. */
  clauses: string[];
  /** `take` per source query, to prove the limit travels instead of being re-guessed downstream. */
  takes: number[];
  /** How many times the bulk name lookups ran: a feed is one lookup per model, not one per row. */
  lookups: { workflow: number; agent: number; node: number };
}

function activityApp(): Probe {
  const clauses: string[] = [];
  const takes: number[] = [];
  const lookups = { workflow: 0, agent: 0, node: 0 };
  const record = (label: string, args: { where: unknown; take?: number }) => {
    clauses.push(`${label}:${JSON.stringify(args.where)}`);
    if (args.take !== undefined) takes.push(args.take);
  };

  const db = {
    // `getAgent` reads the tenant for its cycle window and the ledger for the
    // agent counters, so the agent-runs routes need both present.
    tenant: {
      findFirstOrThrow: async () => ({
        id: "tnt_one",
        name: "Demo",
        plan: { name: "Free", tokenQuota: 100_000 },
        tokenBalance: 99_000,
        cycleResetAt: new Date("2026-11-01T00:00:00Z"),
        createdAt: T.a,
      }),
    },
    usageEvent: { groupBy: async () => [] },
    agentRun: {
      findMany: async (args: { where: unknown; take?: number; orderBy?: Row }) => {
        record("agentRun", args);
        return selectRows(AGENT_RUNS, args);
      },
      findFirst: async (args: { where: unknown }) => {
        record("agentRunOne", args);
        return AGENT_RUNS.filter((row) => matches(args.where, row))[0] ?? null;
      },
    },
    agentRunStep: {
      findMany: async (args: { where: unknown; orderBy?: Row }) => selectRows(STEPS, args),
    },
    workflowNodeRun: {
      findMany: async (args: { where: unknown; take?: number; orderBy?: Row }) => {
        lookups.node += 1;
        record("nodeRun", args);
        return selectRows(NODE_RUNS, args);
      },
    },
    workflowRun: {
      findMany: async (args: { where: unknown; take?: number; orderBy?: Row }) => {
        record("workflowRun", args);
        return selectRows(WORKFLOW_RUNS, args);
      },
      findFirst: async (args: { where: unknown }) => WORKFLOW_RUNS.filter((row) => matches(args.where, row))[0] ?? null,
    },
    workflow: {
      findMany: async (args: { where: unknown }) => {
        lookups.workflow += 1;
        record("workflow", args);
        return selectRows(WORKFLOWS, args);
      },
    },
    agent: {
      findMany: async (args: { where: unknown }) => {
        lookups.agent += 1;
        record("agent", args);
        return selectRows(AGENTS, args);
      },
      findFirst: async (args: { where: unknown }) => {
        record("agentOne", args);
        return AGENTS.filter((row) => matches(args.where, row))[0] ?? null;
      },
    },
  };

  const routes: RouteDeps = {
    db: db as unknown as PrismaClient,
    keyring,
    tenantId: "tnt_one",
    providerConfig: { ollamaBaseUrl: "http://127.0.0.1:11434", ollamaModel: "test-model", ollamaTimeoutMs: 1000 },
    queue,
    workerStaleMs: 30_000,
  };
  return {
    app: createApp({ config: { NODE_ENV: "test" }, log, db: { ping: async () => true }, routes }),
    clauses,
    takes,
    lookups,
  };
}

describe("activity feed", () => {
  it("merges direct turns and graph nodes newest first, resolving names in bulk", async () => {
    const { app, lookups } = activityApp();
    const res = await app.inject({ method: "GET", url: "/activity" });
    expect(res.statusCode).toBe(200);

    const items = res.json() as Record<string, unknown>[];
    // OUTBOUND nodes are not agent work, so they stay out of the feed.
    expect(items.map((item) => item.id)).toEqual(["arun_1", "node_1", "arun_2", "node_3"]);
    expect(items[0]).toMatchObject({ source: "AGENT_RUN", status: "RUNNING", agentName: "Triage", workflowId: null });
    expect(items[1]).toMatchObject({
      source: "WORKFLOW_NODE",
      agentId: "agt_2",
      agentName: "Writer",
      projectId: "prj_one",
      workflowId: "wf_1",
      workflowName: "Inbound triage",
      workflowRunId: "wfrun_1",
      nodeKey: "agent",
      nodeLabel: "Writer node",
    });
    // A node whose workflow row is gone still reports the run's own name snapshot.
    expect(items[3]).toMatchObject({ workflowId: "wf_gone", workflowName: "Deleted graph", projectId: null });
    // Previews are flattened so a feed row is one line, whatever the message held.
    expect(items[2]?.inputPreview).toBe("rewrite this please");
    expect(lookups.workflow).toBe(1);
    expect(lookups.agent).toBe(1);
    await app.close();
  });

  it("filters the merged feed by status without inventing a side that cannot hold it", async () => {
    const running = activityApp();
    const res = await running.app.inject({ method: "GET", url: "/activity?status=RUNNING" });
    expect(res.json().map((item: Record<string, unknown>) => item.id)).toEqual(["arun_1"]);
    expect(running.clauses.some((line) => line.includes('"status":"RUNNING"'))).toBe(true);
    await running.app.close();

    // PENDING and SKIPPED exist only on a node; BLOCKED only on a run. Asking for
    // one must not fire the query on the side that can never answer it.
    const pending = activityApp();
    const nodeOnly = await pending.app.inject({ method: "GET", url: "/activity?status=PENDING" });
    expect(nodeOnly.json().map((item: Record<string, unknown>) => item.id)).toEqual(["node_3"]);
    expect(pending.clauses.filter((line) => line.startsWith("agentRun"))).toHaveLength(0);
    await pending.app.close();

    const blocked = activityApp();
    const runOnly = await blocked.app.inject({ method: "GET", url: "/activity?status=BLOCKED" });
    expect(runOnly.json()).toEqual([]);
    expect(blocked.clauses.filter((line) => line.startsWith("nodeRun"))).toHaveLength(0);
    await blocked.app.close();
  });

  it("filters by agent across both sources", async () => {
    const { app } = activityApp();
    const res = await app.inject({ method: "GET", url: "/activity?agentId=agt_2" });
    expect(res.json().map((item: Record<string, unknown>) => item.id)).toEqual(["node_1", "arun_2"]);
    await app.close();
  });

  it("caps the feed at the limit and asks each source for one row more", async () => {
    const { app, takes } = activityApp();
    const res = await app.inject({ method: "GET", url: "/activity?limit=2" });
    expect(res.json()).toHaveLength(2);
    expect(res.json().map((item: Record<string, unknown>) => item.id)).toEqual(["arun_1", "node_1"]);
    // limit+1 on both sides: the extra row proves truncation, and never leaves the server.
    expect(takes).toEqual([3, 3]);
    await app.close();
  });

  it("rejects a limit outside the page it will serve", async () => {
    const { app } = activityApp();
    const res = await app.inject({ method: "GET", url: "/activity?limit=500" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_failed");
    await app.close();
  });

  it("never reads a run that belongs to another tenant, and says so with the id alone", async () => {
    const { app, clauses } = activityApp();
    const feed = await app.inject({ method: "GET", url: "/activity" });
    expect(feed.body).not.toContain("arun_victim");
    expect(feed.body).not.toContain("a secret question");
    const detail = await app.inject({ method: "GET", url: "/agent-runs/arun_victim" });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toEqual({ error: "run_not_found", message: "run arun_victim is not in this tenant" });
    // Every clause carries the session tenant; none of them trusts a body.
    expect(clauses.length).toBeGreaterThan(0);
    for (const line of clauses) expect(line).toContain("tnt_one");
    await app.close();
  });
});

describe("agent run detail", () => {
  it("returns the persisted rounds and tool calls in sequence order", async () => {
    const { app } = activityApp();
    const res = await app.inject({ method: "GET", url: "/agent-runs/arun_2" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: "arun_2",
      status: "SUCCEEDED",
      tokensUsed: 420,
      stepCount: 3,
      toolCallCount: 1,
      durationMs: 2_100,
      finishedAt: "2026-10-05T12:00:00.000Z",
    });
    const steps = res.json().steps as Record<string, unknown>[];
    expect(steps.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(steps[1]).toMatchObject({ kind: "TOOL", tool: "search_crm", ok: true, round: 2 });
    await app.close();
  });

  it("pages backwards from the row already shown", async () => {
    const { app, clauses } = activityApp();
    const res = await app.inject({ method: "GET", url: "/agent-runs?before=2026-10-05T12:00:00Z" });
    expect(res.json().map((row: Record<string, unknown>) => row.id)).toEqual(["arun_2"]);
    expect(clauses.join()).toContain('"startedAt":{"lt":"2026-10-05T12:00:00.000Z"}');
    await app.close();
  });

  it("lists an agent's runs only after the agent resolves inside the tenant", async () => {
    const { app, clauses } = activityApp();
    const missing = await app.inject({ method: "GET", url: "/agents/agt_404/runs" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("agent_not_found");

    const found = await app.inject({ method: "GET", url: "/agents/agt_2/runs?limit=1" });
    expect(found.statusCode).toBe(200);
    expect(found.json().map((row: Record<string, unknown>) => row.id)).toEqual(["arun_2"]);
    expect(clauses.some((line) => line.startsWith("agentOne") && line.includes("agt_404") && line.includes("tnt_one"))).toBe(true);
    await app.close();
  });
});

describe("tenant-wide workflow runs", () => {
  it("attaches the live project id in one lookup and null for a workflow that is gone", async () => {
    const { app, lookups } = activityApp();
    const res = await app.inject({ method: "GET", url: "/workflow-runs?limit=10" });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Record<string, unknown>[];
    expect(rows.map((row) => row.id)).toEqual(["wfrun_1", "wfrun_2"]);
    expect(rows[0]).toMatchObject({ projectId: "prj_one", workflowName: "Inbound triage" });
    // wf_gone has no workflow row: the console must not offer a link it cannot serve.
    expect(rows[1]).toMatchObject({ projectId: null, workflowName: "Deleted graph", status: "FAILED" });
    expect(lookups.workflow).toBe(1);
    await app.close();
  });
});
