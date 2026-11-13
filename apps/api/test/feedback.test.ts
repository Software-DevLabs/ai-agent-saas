import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Keyring, createLogger } from "@saas/shared";
import { createApp } from "../src/app.ts";
import type { RouteDeps } from "../src/routes.ts";

/**
 * Insights over HTTP against a fake that behaves like the two tables it reads.
 *
 * The invariants under test are the ones a chart can hide: a project's counters
 * include every widget the project owns and no one else's, a sentiment filter
 * narrows only the listed questions, and asking for a widget or project outside
 * the tenant is a 404 before any row is read.
 */

const log = createLogger({ LOG_LEVEL: "fatal", LOG_PRETTY: "0" });
const keyring = new Keyring({ id: "k1", key: Buffer.alloc(32, 7) });

type Row = Record<string, unknown>;

function matches(row: Row, where: unknown): boolean {
  if (where === undefined || where === null) return true;
  const clause = where as Record<string, unknown>;
  return Object.entries(clause).every(([key, value]) => {
    if (key === "AND") return (value as unknown[]).every((entry) => matches(row, entry));
    if (key === "OR") return (value as unknown[]).some((entry) => matches(row, entry));
    if (value !== null && typeof value === "object" && "in" in value) {
      return ((value as { in: unknown[] }).in ?? []).includes(row[key]);
    }
    return row[key] === value;
  });
}

function pick<T extends Row>(row: T, select: unknown): Row {
  if (select === undefined || select === null || typeof select !== "object") return { ...row };
  return Object.fromEntries(Object.keys(select as Record<string, boolean>).map((key) => [key, row[key]]));
}

function fakeDb(seed: { embeds?: Row[]; feedback?: Row[]; projects?: Row[] } = {}) {
  const embeds = seed.embeds ?? [];
  const feedback = seed.feedback ?? [];
  const projects = seed.projects ?? [{ id: "prj_one", tenantId: "tnt_one", name: "Shop", isDefault: true }];

  const counted = (where: unknown) => feedback.filter((row) => matches(row, where)).length;

  const db = {
    project: {
      findFirst: async ({ where, select }: { where: unknown; select?: unknown }) => {
        const row = projects.find((entry) => matches(entry, where));
        return row === undefined ? null : pick(row, select);
      },
    },
    embed: {
      findFirst: async ({ where, select }: { where: unknown; select?: unknown }) => {
        const row = embeds.find((entry) => matches(entry, where));
        return row === undefined ? null : pick(row, select);
      },
      findMany: async ({ where, select }: { where: unknown; select?: unknown }) =>
        embeds.filter((entry) => matches(entry, where)).map((entry) => pick(entry, select)),
    },
    embedFeedback: {
      count: async ({ where }: { where: unknown }) => counted(where),
      findMany: async ({ where, take, select }: { where: unknown; take?: number; select?: unknown }) => {
        const rows = feedback
          .filter((entry) => matches(entry, where))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return rows.slice(0, take ?? rows.length).map((entry) => pick(entry, select));
      },
    },
  };
  return { db: db as unknown as PrismaClient, embeds, feedback };
}

function appWith(db: PrismaClient) {
  const routes: RouteDeps = {
    db,
    keyring,
    tenantId: "tnt_one",
    providerConfig: { ollamaBaseUrl: "http://127.0.0.1:11434", ollamaModel: "test-model", ollamaTimeoutMs: 1000 },
    queue: {
      enqueue: async () => ({ id: "job_1", duplicate: false }),
      claim: async () => null,
      heartbeat: async () => true,
      attachRun: async () => {},
      succeed: async () => {},
      retry: async () => {},
      dead: async () => {},
      release: async () => {},
      counts: async () => ({ queued: 0, claimed: 0, failed: 0, dead: 0 }),
    },
    workerStaleMs: 30_000,
  };
  return createApp({ config: { NODE_ENV: "test" }, log, db: { ping: async () => true }, routes });
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 31, 10, minute));

const embedRow = (id: string, over: Row = {}): Row => ({
  id,
  tenantId: "tnt_one",
  projectId: "prj_one",
  agentId: "agt_1",
  name: `Widget ${id}`,
  ...over,
});

const feedbackRow = (id: string, over: Row = {}): Row => ({
  id,
  tenantId: "tnt_one",
  embedId: "emb_1",
  messageId: `msg_${id}`,
  question: "How do I reset my password?",
  answer: "Use the link on the login page.",
  sentiment: "NEUTRAL",
  score: 0.7,
  source: "model",
  model: "test-model",
  error: null,
  tokensUsed: 130,
  createdAt: at(0),
  ...over,
});

describe("project insights", () => {
  it("counts every widget the project owns, and lists the newest questions with their widget names", async () => {
    const { db } = fakeDb({
      embeds: [embedRow("emb_1"), embedRow("emb_2", { name: "Billing widget" }), embedRow("emb_3", { projectId: "prj_other" })],
      feedback: [
        feedbackRow("fb_1", { sentiment: "POSITIVE", createdAt: at(1) }),
        feedbackRow("fb_2", { embedId: "emb_2", sentiment: "NEGATIVE", score: null, question: "This is the third time I ask!", createdAt: at(2) }),
        feedbackRow("fb_3", { sentiment: "UNKNOWN", source: "unparseable", error: "no JSON", score: null, createdAt: at(3) }),
        feedbackRow("fb_4", { embedId: "emb_3", sentiment: "POSITIVE", createdAt: at(4) }),
      ],
    });
    const app = appWith(db);

    const res = await app.inject({ method: "GET", url: "/projects/prj_one/insights?limit=20" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scope).toBe("project");
    expect(body.embedCount).toBe(2);
    expect(body.totals).toEqual({ POSITIVE: 1, NEUTRAL: 0, NEGATIVE: 1, UNKNOWN: 1, total: 3 });
    expect(body.feedback.map((row: { id: string }) => row.id)).toEqual(["fb_3", "fb_2", "fb_1"]);
    expect(body.feedback[1]).toMatchObject({ embedName: "Billing widget", sentiment: "NEGATIVE", score: null });
    expect(body.feedback[0]).toMatchObject({ source: "unparseable", error: "no JSON", sentiment: "UNKNOWN" });
    await app.close();
  });

  it("filters the listed questions without changing the counters", async () => {
    const { db } = fakeDb({
      embeds: [embedRow("emb_1")],
      feedback: [
        feedbackRow("fb_1", { sentiment: "POSITIVE" }),
        feedbackRow("fb_2", { sentiment: "NEGATIVE" }),
        feedbackRow("fb_3", { sentiment: "NEGATIVE" }),
      ],
    });
    const app = appWith(db);

    const res = await app.inject({ method: "GET", url: "/projects/prj_one/insights?sentiment=NEGATIVE&limit=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.feedback).toHaveLength(1);
    expect(body.feedback[0].sentiment).toBe("NEGATIVE");
    expect(body.totals).toEqual({ POSITIVE: 1, NEUTRAL: 0, NEGATIVE: 2, UNKNOWN: 0, total: 3 });
    await app.close();
  });

  it("is an empty page — not an error — for a project with no widgets", async () => {
    const { db } = fakeDb({ embeds: [] });
    const app = appWith(db);

    const res = await app.inject({ method: "GET", url: "/projects/prj_one/insights" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ embedCount: 0, totals: { total: 0 }, feedback: [] });
    await app.close();
  });

  it("refuses a project that is not in this tenant", async () => {
    const { db } = fakeDb();
    const app = appWith(db);

    const res = await app.inject({ method: "GET", url: "/projects/prj_foreign/insights" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("project_not_found");
    await app.close();
  });

  it("refuses an unknown sentiment value and an oversized limit", async () => {
    const { db } = fakeDb({ embeds: [embedRow("emb_1")] });
    const app = appWith(db);

    const bad = await app.inject({ method: "GET", url: "/projects/prj_one/insights?sentiment=ANGRY" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("validation_failed");

    const tooMany = await app.inject({ method: "GET", url: "/projects/prj_one/insights?limit=500" });
    expect(tooMany.statusCode).toBe(400);
    await app.close();
  });
});

describe("widget insights", () => {
  it("counts one widget and 404s a foreign one", async () => {
    const { db } = fakeDb({
      embeds: [embedRow("emb_1"), embedRow("emb_2")],
      feedback: [feedbackRow("fb_1"), feedbackRow("fb_2", { embedId: "emb_2" })],
    });
    const app = appWith(db);

    const res = await app.inject({ method: "GET", url: "/embeds/emb_1/insights" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ scope: "embed", scopeId: "emb_1", embedCount: 1, totals: { total: 1 } });
    expect(res.json().feedback[0]).toMatchObject({ embedId: "emb_1", embedName: "Widget emb_1" });

    const foreign = await app.inject({ method: "GET", url: "/embeds/emb_foreign/insights" });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error).toBe("embed_not_found");
    await app.close();
  });
});
