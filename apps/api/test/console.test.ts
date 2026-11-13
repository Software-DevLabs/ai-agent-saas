import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "@saas/core";
import { Keyring, createLogger } from "@saas/shared";
import { createApp } from "../src/app.ts";
import { cycleStart, maskSecret } from "../src/services/reads.ts";
import type { RouteDeps } from "../src/routes.ts";

const log = createLogger({ LOG_LEVEL: "fatal", LOG_PRETTY: "0" });
const keyring = new Keyring({ id: "k1", key: Buffer.alloc(32, 7) });
const blob = keyring.encrypt("123456:AAHfakeTelegramTokenZz9");

/** These probes never enqueue; a stub keeps the app constructible without a database. */
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

function appWith(db: Partial<PrismaClient>, probeTools?: (provider: string, model: string) => Promise<boolean>) {
  const routes: RouteDeps = {
    db: db as unknown as PrismaClient,
    keyring,
    tenantId: "tnt_one",
    providerConfig: { ollamaBaseUrl: "http://127.0.0.1:11434", ollamaModel: "test-model", ollamaTimeoutMs: 1000 },
    queue,
    workerStaleMs: 30_000,
    ...(probeTools === undefined ? {} : { probeTools }),
  };
  return createApp({ config: { NODE_ENV: "test" }, log, db: { ping: async () => true }, routes });
}

describe("credential masking", () => {
  it("keeps only the trailing characters of a secret", () => {
    expect(maskSecret("123456:AAHzzZz9")).toBe("****zZz9");
    expect(maskSecret("...")).toBe("****");
  });

  it("never returns the ciphertext or the plaintext to the browser", async () => {
    const app = appWith({
      integration: {
        findMany: async () => [
          {
            id: "int_1",
            tenantId: "tnt_one",
            type: "TELEGRAM_IN",
            externalId: "bot-1",
            status: "CONNECTED",
            createdAt: new Date("2026-10-01T00:00:00Z"),
            credentialsEncrypted: blob,
            agents: [],
          },
        ],
      },
    } as never);

    const res = await app.inject({ method: "GET", url: "/integrations" });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]?.credentialPreview).toMatch(/^\*\*\*\*/);
    expect(res.body).not.toContain("v1:k1:");
    expect(res.body).not.toContain("AAHfakeTelegramToken");
    await app.close();
  });

  it("reports no preview when a blob cannot be authenticated", async () => {
    const app = appWith({
      integration: {
        findMany: async () => [
          {
            id: "int_2",
            tenantId: "tnt_one",
            type: "WEBHOOK_OUT",
            externalId: null,
            status: "ERROR",
            createdAt: new Date("2026-10-01T00:00:00Z"),
            credentialsEncrypted: "v1:kX:cGxhaW4=:cGxhaW4=",
            agents: [],
          },
        ],
      },
    } as never);

    const res = await app.inject({ method: "GET", url: "/integrations" });
    expect(res.json()[0]?.credentialPreview).toBeNull();
    await app.close();
  });
});

describe("cycle window", () => {
  it("starts exactly one month before the reset", () => {
    expect(cycleStart(new Date("2026-11-01T09:30:00Z")).toISOString()).toBe("2026-10-01T09:30:00.000Z");
  });
});

describe("agent writes", () => {
  it("rejects a provider that is not registered, before touching the database", async () => {
    let touched = false;
    const app = appWith({
      tenant: { findFirstOrThrow: async () => ((touched = true), {}) } as never,
    });
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: {
        name: "Sales triage",
        systemPrompt: "You triage inbound leads.",
        modelProvider: "openai",
        modelName: "gpt-4",
        temperature: 0.7,
        maxOutputTokens: 1024,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "unknown_provider" });
    expect(touched).toBe(false);
    await app.close();
  });

  it("rejects an out-of-range body with a field path instead of a stack trace", async () => {
    const app = appWith({});
    const res = await app.inject({
      method: "POST",
      url: "/agents",
      payload: { name: "", systemPrompt: "x", modelProvider: "ollama", modelName: "m", temperature: 9, maxOutputTokens: 1024 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_failed");
    expect(res.body).not.toContain("    at ");
    expect(res.body).not.toMatch(/TypeError|PrismaClient/);
    await app.close();
  });
});

describe("project scoping", () => {
  const row = {
    id: "prj_one",
    tenantId: "tnt_one",
    name: "Support",
    description: null,
    isDefault: true,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    _count: { agents: 3, integrations: 1, workflows: 0 },
  };

  it("will not resolve a project id whose tenant clause does not match", async () => {
    let seen = "";
    const app = appWith({
      project: {
        findFirst: async (args: { where: unknown }) => {
          seen = JSON.stringify(args.where);
          return null;
        },
      },
    } as never);

    const res = await app.inject({ method: "GET", url: "/projects/prj_two" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "project_not_found", message: "project prj_two is not in this tenant" });
    // The guard carries the session tenant, never the bare id from the URL.
    expect(seen).toContain("tnt_one");
    expect(seen).toContain("prj_two");
    await app.close();
  });

  it("lists real counts and stamps the session tenant on create", async () => {
    const created: Record<string, unknown>[] = [];
    const app = appWith({
      project: {
        findMany: async () => [row],
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: "prj_new" };
        },
        findFirst: async () => ({ ...row, id: "prj_new", name: "Sales", isDefault: false, _count: { agents: 0, integrations: 0, workflows: 0 } }),
      },
    } as never);

    const list = await app.inject({ method: "GET", url: "/projects" });
    expect(list.statusCode).toBe(200);
    expect(list.json()[0]).toMatchObject({ id: "prj_one", counts: { agents: 3, integrations: 1, workflows: 0 } });

    // `tenantId` and `isDefault` in the body are dropped by the schema and
    // never reach the row: only the session tenant may own a new project, and
    // only the backfill may mint a default one.
    const made = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Sales", tenantId: "tnt_VICTIM", isDefault: true },
    });
    expect(made.statusCode).toBe(201);
    expect(created[0]).toEqual({ tenantId: "tnt_one", name: "Sales", description: null });
    await app.close();
  });

  it("refuses to delete a project that still holds rows", async () => {
    const app = appWith({
      project: {
        findFirst: async () => ({ id: "prj_one", tenantId: "tnt_one", name: "Support", isDefault: true }),
        findFirstOrThrow: async () => ({ _count: { agents: 2, integrations: 0, workflows: 1 } }),
      },
    } as never);

    const res = await app.inject({ method: "DELETE", url: "/projects/prj_one" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("project_not_empty");
    expect(res.json().message).toContain("2 agent(s)");
    expect(res.json().message).toContain("1 workflow(s)");
    await app.close();
  });

  it("rejects a blank project name with a field path instead of a stack", async () => {
    const app = appWith({});
    const res = await app.inject({ method: "POST", url: "/projects", payload: { name: "" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_failed");
    expect(res.json().message).toContain("name");
    expect(res.body).not.toContain("    at ");
    await app.close();
  });
});

const PROJECT = "prj_one";
const OTHER_PROJECT = "prj_two";

/** A graph the server should accept: one inbound, one agent, one sink. */
const GOOD_GRAPH = {
  nodes: [
    { key: "in", kind: "INBOUND", position: { x: 0, y: 0 }, config: { integrationId: "int_in" } },
    { key: "agent", kind: "AGENT", position: { x: 220, y: 0 }, config: { agentId: "agt_1" } },
    { key: "out", kind: "OUTBOUND", position: { x: 440, y: 0 }, config: { integrationId: "int_out" } },
  ],
  edges: [
    { from: "in", to: "agent" },
    { from: "agent", to: "out" },
  ],
};

const GOOD_REFS = [
  { kind: "AGENT", refId: "agt_1" },
  { kind: "INTEGRATION", refId: "int_in" },
  { kind: "INTEGRATION", refId: "int_out" },
];

interface GraphFixture {
  stored: Record<string, unknown>;
  calls: {
    updateMany: number;
    update: Record<string, unknown>[];
    deleteMany: number;
    created: Record<string, unknown>[];
    deletedWorkflows: number;
    deletedAgents: number;
    transactional: boolean;
  };
}

/**
 * The slice of Prisma a graph write touches, backed by one mutable row so a test
 * can read what actually landed. `updateMany` honours the version clause it was
 * given: if the stub ignored it, the concurrency test would pass whether the
 * compare-and-swap existed or not.
 */
function graphApp(
  options: {
    status?: "DRAFT" | "ACTIVE" | "PAUSED";
    version?: number;
    definition?: unknown;
    dependencies?: { kind: string; refId: string }[];
    agents?: Record<string, unknown>[];
    channels?: Record<string, unknown>[];
    claimer?: { id: string; name: string } | null;
    workerAlive?: boolean;
    probeTools?: (provider: string, model: string) => Promise<boolean>;
  } = {},
): { app: ReturnType<typeof appWith>; fixture: GraphFixture } {
  const stored: Record<string, unknown> = {
    id: "wf_1",
    tenantId: "tnt_one",
    projectId: PROJECT,
    name: "Inbound triage",
    description: null,
    status: options.status ?? "DRAFT",
    version: options.version ?? 3,
    definition: options.definition ?? { nodes: [], edges: [] },
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    project: { name: "Support" },
    dependencies: options.dependencies ?? [],
  };
  const calls = {
    updateMany: 0,
    update: [] as Record<string, unknown>[],
    deleteMany: 0,
    created: [] as Record<string, unknown>[],
    deletedWorkflows: 0,
    deletedAgents: 0,
    transactional: false,
  };
  const agents = options.agents ?? [{ id: "agt_1", name: "Triage", projectId: PROJECT }];
  const channels = options.channels ?? [
    { id: "int_in", type: "TELEGRAM_IN", externalId: "bot-1", projectId: PROJECT, status: "CONNECTED" },
    { id: "int_out", type: "WEBHOOK_OUT", externalId: null, projectId: PROJECT, status: "CONNECTED" },
  ];

  const writeInterface = {
    workflow: {
      findFirst: async () => ({ ...stored }),
      updateMany: async (args: {
        where: { AND: Array<{ id?: string; version?: number; tenantId?: string }> };
        data: { definition?: unknown; version?: { increment: number } };
      }) => {
        calls.updateMany += 1;
        const clause = args.where.AND[0];
        const tenant = args.where.AND[1];
        if (!clause || clause.id !== stored.id || tenant?.tenantId !== "tnt_one") return { count: 0 };
        if (clause.version !== stored.version) return { count: 0 };
        stored.definition = args.data.definition;
        stored.version = (stored.version as number) + (args.data.version?.increment ?? 0);
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        calls.update.push(data);
        Object.assign(stored, data);
        return stored;
      },
      delete: async () => {
        calls.deletedWorkflows += 1;
        return stored;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.created.push(data);
        return { id: "wf_new" };
      },
    },
    workflowDependency: {
      findFirst: async () => (options.claimer ? { workflow: options.claimer } : null),
      findMany: async () => (stored.dependencies as { kind: string; refId: string }[]).map((row) => ({ ...row })),
      deleteMany: async () => {
        calls.deleteMany += 1;
        stored.dependencies = [];
        return { count: 0 };
      },
      createMany: async ({ data }: { data: { kind: string; refId: string }[] }) => {
        stored.dependencies = data.map((row) => ({ kind: row.kind, refId: row.refId }));
        return { count: data.length };
      },
    },
    agent: {
      findMany: async () => agents.map((row) => ({ ...row })),
      findFirst: async () => ({ id: "agt_1" }),
      delete: async () => {
        calls.deletedAgents += 1;
        return { id: "agt_1" };
      },
    },
    integration: {
      findMany: async () => channels.map((row) => ({ ...row })),
    },
    // No worker process has checked in unless a test says one has, which is
    // exactly what the activation guard must see.
    workerHeartbeat: {
      findFirst: async () =>
        options.workerAlive === true ? { workerId: "w1", lastSeenAt: new Date() } : null,
    },
    project: {
      findFirst: async () => ({
        id: PROJECT,
        tenantId: "tnt_one",
        name: "Support",
        description: null,
        isDefault: true,
        createdAt: new Date("2026-10-01T00:00:00Z"),
        updatedAt: new Date("2026-10-01T00:00:00Z"),
        _count: { agents: 1, integrations: 2, workflows: 1 },
      }),
    },
    $transaction: async (fn: (tx: unknown) => Promise<boolean>) => {
      calls.transactional = true;
      return fn(writeInterface);
    },
  };

  const app = appWith(writeInterface as never, options.probeTools);
  return { app, fixture: { stored, calls } };
}

/** An orchestrator wired between the same inbound and sink as GOOD_GRAPH. */
const ORCH_GRAPH = {
  nodes: [
    { key: "in", kind: "INBOUND", position: { x: 0, y: 0 }, config: { integrationId: "int_in" } },
    {
      key: "orch",
      kind: "ORCHESTRATOR",
      position: { x: 220, y: 0 },
      config: { agentId: "agt_1", subagents: [{ agentId: "agt_2", role: "writer" }] },
    },
    { key: "out", kind: "OUTBOUND", position: { x: 440, y: 0 }, config: { integrationId: "int_out" } },
  ],
  edges: [
    { from: "in", to: "orch" },
    { from: "orch", to: "out" },
  ],
};

const ORCH_REFS = [
  { kind: "AGENT", refId: "agt_1" },
  { kind: "AGENT", refId: "agt_2" },
  { kind: "INTEGRATION", refId: "int_in" },
  { kind: "INTEGRATION", refId: "int_out" },
];

const ORCH_AGENTS = [
  { id: "agt_1", name: "Triage", projectId: PROJECT, modelProvider: "ollama", modelName: "orch-model" },
  { id: "agt_2", name: "Writer", projectId: PROJECT, modelProvider: "ollama", modelName: "sub-model" },
];

describe("workflow graphs", () => {
  it("refuses a node it cannot read, naming the field path", async () => {
    const { app } = graphApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/workflows/wf_1/graph",
      payload: {
        expectedVersion: 3,
        definition: { nodes: [{ key: "agent", kind: "AGENT", position: { x: 0, y: 0 }, config: {} }], edges: [] },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_failed");
    expect(res.json().message).toContain("nodes.0.config.agentId");
    expect(res.body).not.toContain("    at ");
    await app.close();
  });

  it("refuses a stale autosave with 409 and rebuilds nothing", async () => {
    const { app, fixture } = graphApp({ version: 5 });
    const res = await app.inject({
      method: "PATCH",
      url: "/workflows/wf_1/graph",
      payload: { expectedVersion: 4, definition: GOOD_GRAPH },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("graph_version");
    expect(res.json().message).toContain("version 5");
    // The loser of a concurrent edit reloads; it does not half-write an index.
    expect(fixture.calls.deleteMany).toBe(0);
    expect(fixture.stored.version).toBe(5);
    await app.close();
  });

  it("saves a good graph, bumps the version and rebuilds the reference index", async () => {
    const { app, fixture } = graphApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/workflows/wf_1/graph",
      payload: { expectedVersion: 3, definition: GOOD_GRAPH },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: 4, status: "DRAFT" });
    expect(res.json().definition.nodes).toHaveLength(3);
    expect(res.json().dependencies).toEqual([
      { kind: "AGENT", refId: "agt_1", name: "Triage" },
      { kind: "INTEGRATION", refId: "int_in", name: "TELEGRAM_IN · bot-1" },
      { kind: "INTEGRATION", refId: "int_out", name: "WEBHOOK_OUT" },
    ]);
    expect(fixture.calls.transactional).toBe(true);
    expect(fixture.calls.deleteMany).toBe(1);
    await app.close();
  });

  it("refuses to activate even a valid graph while no worker consumes the queue", async () => {
    const { app, fixture } = graphApp({ definition: GOOD_GRAPH, dependencies: GOOD_REFS });
    const res = await app.inject({ method: "PATCH", url: "/workflows/wf_1/status", payload: { status: "ACTIVE" } });
    // Every rule above the guard passes — which is the point: this refusal is
    // about the missing runner, not about the drawing. When the worker ships,
    // this test flips to `200` and the guard comes out of `setWorkflowStatus`.
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("worker_not_running");
    expect(fixture.calls.update).toHaveLength(0);
    expect(fixture.stored.status).toBe("DRAFT");
    await app.close();
  });

  it("pauses and un-pauses a graph without the runner", async () => {
    const { app, fixture } = graphApp({ definition: GOOD_GRAPH, dependencies: GOOD_REFS, status: "ACTIVE" });
    const paused = await app.inject({ method: "PATCH", url: "/workflows/wf_1/status", payload: { status: "PAUSED" } });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().status).toBe("PAUSED");
    expect(fixture.calls.update).toEqual([{ status: "PAUSED" }]);
    await app.close();
  });

  it("refuses to activate a graph that reaches into another project", async () => {
    const { app, fixture } = graphApp({
      definition: GOOD_GRAPH,
      dependencies: GOOD_REFS,
      agents: [{ id: "agt_1", name: "Triage", projectId: OTHER_PROJECT }],
    });
    const res = await app.inject({ method: "PATCH", url: "/workflows/wf_1/status", payload: { status: "ACTIVE" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("graph_invalid");
    const issues = res.json().details.issues as { code: string }[];
    expect(issues.map((issue) => issue.code)).toContain("agent_outside_project");
    // The refusal happens before the row is touched, not by undoing it after.
    expect(fixture.calls.update).toHaveLength(0);
    expect(fixture.stored.status).toBe("DRAFT");
    await app.close();
  });

  it("refuses a second active workflow on the same inbound channel", async () => {
    const { app, fixture } = graphApp({
      definition: GOOD_GRAPH,
      dependencies: GOOD_REFS,
      claimer: { id: "wf_other", name: "Night shift" },
    });
    const res = await app.inject({ method: "PATCH", url: "/workflows/wf_1/status", payload: { status: "ACTIVE" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("channel_claimed");
    expect(res.json().message).toContain("Night shift");
    expect(fixture.calls.update).toHaveLength(0);
    await app.close();
  });

  it("answers a foreign workflow id with the id it was given and nothing more", async () => {
    const app = appWith({ workflow: { findFirst: async () => null } } as never);
    const res = await app.inject({ method: "GET", url: "/workflows/wf_belongs_to_victim" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: "workflow_not_found",
      message: "workflow wf_belongs_to_victim is not in this tenant",
    });
    await app.close();
  });

  it("stamps the session tenant and the path project on a new workflow", async () => {
    const { app, fixture } = graphApp();
    const res = await app.inject({
      method: "POST",
      url: `/projects/${PROJECT}/workflows`,
      payload: { name: "Inbound triage", tenantId: "tnt_VICTIM", projectId: OTHER_PROJECT },
    });
    expect(res.statusCode).toBe(201);
    expect(fixture.calls.created[0]).toMatchObject({
      tenantId: "tnt_one",
      projectId: PROJECT,
      name: "Inbound triage",
      description: null,
    });
    await app.close();
  });

  it("will not delete an agent an active graph is wired to", async () => {
    const { app, fixture } = graphApp({ claimer: { id: "wf_1", name: "Inbound triage" } });
    const res = await app.inject({ method: "DELETE", url: "/agents/agt_1" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("agent_in_active_workflow");
    expect(res.json().message).toContain("Inbound triage is active");
    expect(fixture.calls.deletedAgents).toBe(0);
    await app.close();
  });

  it("will not delete a workflow that is running", async () => {
    const { app, fixture } = graphApp({ status: "ACTIVE" });
    const res = await app.inject({ method: "DELETE", url: "/workflows/wf_1" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("workflow_active");
    expect(fixture.calls.deletedWorkflows).toBe(0);
    await app.close();
  });

  it("refuses a graph over the node cap before parsing it", async () => {
    const { app } = graphApp();
    const nodes = Array.from({ length: 61 }, (_, index) => ({
      key: `n${index}`,
      kind: "AGENT",
      position: { x: index, y: 0 },
      config: { agentId: "agt_1" },
    }));
    const res = await app.inject({
      method: "PATCH",
      url: "/workflows/wf_1/graph",
      payload: { expectedVersion: 3, definition: { nodes, edges: [] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_failed");
    expect(res.json().message).toContain("nodes");
    expect(res.body).not.toContain("    at ");
    await app.close();
  });

  it("saves an orchestrator graph and indexes every agent it can reach", async () => {
    const { app, fixture } = graphApp({ agents: ORCH_AGENTS });
    const res = await app.inject({
      method: "PATCH",
      url: "/workflows/wf_1/graph",
      payload: { expectedVersion: 3, definition: ORCH_GRAPH },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dependencies).toContainEqual({ kind: "AGENT", refId: "agt_2", name: "Writer" });
    expect(fixture.calls.deleteMany).toBe(1);
    await app.close();
  });

  it("validates an orchestrator graph through the same judge the worker uses", async () => {
    const good = graphApp({ definition: ORCH_GRAPH, dependencies: ORCH_REFS, agents: ORCH_AGENTS });
    const res = await good.app.inject({ method: "POST", url: "/workflows/wf_1/validate" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await good.app.close();

    const badRole = {
      ...ORCH_GRAPH,
      nodes: ORCH_GRAPH.nodes.map((node) =>
        node.key === "orch" ? { ...node, config: { agentId: "agt_1", subagents: [{ agentId: "agt_2", role: "Writer!" }] } } : node,
      ),
    };
    const bad = graphApp({ definition: badRole, dependencies: ORCH_REFS, agents: ORCH_AGENTS });
    const rejected = await bad.app.inject({ method: "POST", url: "/workflows/wf_1/validate" });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().ok).toBe(false);
    expect((rejected.json().issues as { code: string }[]).map((issue) => issue.code)).toContain("subagent_role_invalid");
    await bad.app.close();
  });

  it("refuses activation when an involved model does not declare tools", async () => {
    const { app, fixture } = graphApp({
      definition: ORCH_GRAPH,
      dependencies: ORCH_REFS,
      agents: ORCH_AGENTS,
      workerAlive: true,
      probeTools: async (_provider, model) => model !== "sub-model",
    });
    const res = await app.inject({ method: "PATCH", url: "/workflows/wf_1/status", payload: { status: "ACTIVE" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("tools_unsupported");
    expect(res.json().message).toContain("Writer");
    expect(res.json().message).toContain("sub-model");
    expect(fixture.calls.update).toHaveLength(0);
    await app.close();
  });

  it("refuses activation honestly when no capability probe is wired or it fails", async () => {
    const unwired = graphApp({ definition: ORCH_GRAPH, dependencies: ORCH_REFS, agents: ORCH_AGENTS, workerAlive: true });
    const noProbe = await unwired.app.inject({ method: "PATCH", url: "/workflows/wf_1/status", payload: { status: "ACTIVE" } });
    expect(noProbe.statusCode).toBe(409);
    expect(noProbe.json().error).toBe("tools_probe_failed");
    expect(noProbe.json().message).toContain("no provider probe");
    await unwired.app.close();

    const broken = graphApp({
      definition: ORCH_GRAPH,
      dependencies: ORCH_REFS,
      agents: ORCH_AGENTS,
      workerAlive: true,
      probeTools: async () => {
        throw new Error("ollama is offline");
      },
    });
    const failed = await broken.app.inject({ method: "PATCH", url: "/workflows/wf_1/status", payload: { status: "ACTIVE" } });
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error).toBe("tools_probe_failed");
    expect(failed.json().message).toContain("ollama is offline");
    await broken.app.close();
  });

  it("activates an orchestrator graph once every involved model reports tools", async () => {
    const { app, fixture } = graphApp({
      definition: ORCH_GRAPH,
      dependencies: ORCH_REFS,
      agents: ORCH_AGENTS,
      workerAlive: true,
      probeTools: async () => true,
    });
    const res = await app.inject({ method: "PATCH", url: "/workflows/wf_1/status", payload: { status: "ACTIVE" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ACTIVE");
    expect(fixture.calls.update).toEqual([{ status: "ACTIVE" }]);
    await app.close();
  });
});
