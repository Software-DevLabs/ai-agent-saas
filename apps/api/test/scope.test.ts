import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "@saas/core";
import { Keyring, createLogger } from "@saas/shared";
import { createApp } from "../src/app.ts";
import type { RouteDeps } from "../src/routes.ts";

/**
 * P0 — the project a row is filed into is decided by the API, from an id it
 * resolved itself. These tests are the guard for the two holes that made the
 * "create an agent inside a project" flow a lie: every agent and connection
 * went to the default project whatever the caller asked for, and a client could
 * not name a project at all.
 */

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

const tenantRow = {
  id: "tnt_one",
  name: "Acme",
  planId: "pln_free",
  tokenBalance: 5_000n,
  cycleResetAt: new Date("2026-11-01T00:00:00Z"),
  createdAt: new Date("2026-10-01T00:00:00Z"),
  plan: { id: "pln_free", name: "Free", monthlyPriceUsd: 0, tokenQuota: 1_000_000n, maxIntegrations: 8, features: {} },
};

function agentRow(over: Record<string, unknown> = {}) {
  return {
    id: "agt_1",
    tenantId: "tnt_one",
    projectId: "prj_two",
    name: "Support",
    status: "DRAFT",
    systemPrompt: "You answer questions about the site.",
    modelProvider: "ollama",
    modelName: "test-model",
    temperature: 0.7,
    maxOutputTokens: 1024,
    createdAt: new Date("2026-10-30T00:00:00Z"),
    _count: { conversations: 0, integrations: 0 },
    ...over,
  };
}

function integrationRow(over: Record<string, unknown> = {}) {
  return {
    id: "int_1",
    tenantId: "tnt_one",
    projectId: "prj_two",
    type: "WEBHOOK_OUT",
    externalId: null,
    status: "CONNECTED",
    createdAt: new Date("2026-10-30T00:00:00Z"),
    credentialsEncrypted: keyring.encrypt("secret-token"),
    agents: [],
    ...over,
  };
}

/** A fake that records every create so a test can assert where the row landed. */
function fakeDb(seed: Record<string, unknown> = {}) {
  const created = { agent: [] as Record<string, unknown>[], integration: [] as Record<string, unknown>[] };
  const db = {
    tenant: { findFirstOrThrow: async () => tenantRow },
    plan: { findFirstOrThrow: async () => ({ maxIntegrations: 8 }) },
    project: {
      findFirst: async (args: { where: unknown }) =>
        // `projectOf` is the tenant-visible set; anything else resolves to
        // nothing, which is what a foreign id must look like.
        (args.where as { AND?: { id?: string }[] }).AND?.[0]?.id === "prj_two"
          ? { id: "prj_two", tenantId: "tnt_one", name: "Support", isDefault: false }
          : null,
      upsert: async () => ({ id: "prj_default" }),
    },
    agent: {
      findFirst: async () => agentRow(seed.agent as Record<string, unknown>),
      create: async (args: { data: Record<string, unknown> }) => {
        created.agent!.push(args.data);
        return { id: "agt_1" };
      },
    },
    integration: {
      count: async () => 0,
      findMany: async () => [integrationRow(seed.integration as Record<string, unknown>)],
      create: async (args: { data: Record<string, unknown> }) => {
        created.integration!.push(args.data);
        return { id: "int_1" };
      },
    },
    agentIntegration: { upsert: async () => ({ id: "bind_1" }) },
    usageEvent: { groupBy: async () => [] },
  };
  return { db: db as unknown as PrismaClient, created };
}

function appWith(db: PrismaClient) {
  const routes: RouteDeps = {
    db,
    keyring,
    tenantId: "tnt_one",
    providerConfig: { ollamaBaseUrl: "http://127.0.0.1:11434", ollamaModel: "test-model", ollamaTimeoutMs: 1000 },
    queue,
    workerStaleMs: 30_000,
  };
  return createApp({ config: { NODE_ENV: "test" }, log, db: { ping: async () => true }, routes });
}

const AGENT_BODY = {
  name: "Support",
  systemPrompt: "You answer questions about the site.",
  modelProvider: "ollama",
  modelName: "test-model",
  temperature: 0.7,
  maxOutputTokens: 1024,
};

describe("project ownership on create", () => {
  it("files an agent created from a project inside that project, as a draft", async () => {
    const { db, created } = fakeDb();
    const app = appWith(db);
    const res = await app.inject({ method: "POST", url: "/projects/prj_two/agents", payload: AGENT_BODY });

    expect(res.statusCode).toBe(201);
    expect(created.agent[0]).toMatchObject({ projectId: "prj_two", tenantId: "tnt_one", status: "DRAFT" });
    expect(res.json()).toMatchObject({ projectId: "prj_two", status: "DRAFT" });
    await app.close();
  });

  it("answers 404 for a project that is not this tenant's, and creates nothing", async () => {
    const { db, created } = fakeDb();
    const app = appWith(db);
    const res = await app.inject({ method: "POST", url: "/projects/prj_VICTIM/agents", payload: AGENT_BODY });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("project_not_found");
    expect(created.agent).toEqual([]);
    await app.close();
  });

  it("puts a connection in the project the caller named", async () => {
    const { db, created } = fakeDb();
    const app = appWith(db);
    const res = await app.inject({
      method: "POST",
      url: "/integrations",
      payload: { type: "WEBHOOK_OUT", credentials: "secret-token", projectId: "prj_two" },
    });

    expect(res.statusCode).toBe(201);
    expect(created.integration[0]).toMatchObject({ projectId: "prj_two" });
    await app.close();
  });

  it("inherits the bound agent's project when the caller names none", async () => {
    const { db, created } = fakeDb({ agent: { projectId: "prj_two" } });
    const app = appWith(db);
    const res = await app.inject({
      method: "POST",
      url: "/integrations",
      payload: { type: "WEBHOOK_OUT", credentials: "secret-token", agentId: "agt_1" },
    });

    expect(res.statusCode).toBe(201);
    expect(created.integration[0]?.projectId).toBe("prj_two");
    await app.close();
  });

  it("refuses to bind an agent in one project to a connection filed in another", async () => {
    const { db, created } = fakeDb({ agent: { projectId: "prj_two" } });
    const app = appWith(db);
    const res = await app.inject({
      method: "POST",
      url: "/integrations",
      payload: {
        type: "WEBHOOK_OUT",
        credentials: "secret-token",
        agentId: "agt_1",
        projectId: "prj_three",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("project_agent_mismatch");
    expect(created.integration).toEqual([]);
    await app.close();
  });
});

describe("agent status", () => {
  it("accepts DRAFT, so an unconfigured agent can be parked", async () => {
    const { db } = fakeDb();
    const app = appWith(db);
    (db as unknown as { agent: { update: (args: unknown) => Promise<unknown> } }).agent.update = async () =>
      agentRow({ status: "DRAFT" });

    const res = await app.inject({ method: "PATCH", url: "/agents/agt_1/status", payload: { status: "DRAFT" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("DRAFT");
    await app.close();
  });
});
