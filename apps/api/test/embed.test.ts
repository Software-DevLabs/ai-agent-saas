import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { FORBIDDEN_PROJECTION_KEYS, type NewJob, type Queue } from "@saas/core";
import { Keyring, createLogger } from "@saas/shared";
import { createApp } from "../src/app.ts";
import type { RouteDeps } from "../src/routes.ts";
import { createPgRateLimiter } from "../src/embed/rate-limit.ts";
import { hashEmbedKey } from "../src/embed/resolve.ts";

/**
 * The public surface over HTTP, against a fake that behaves like the tables.
 *
 * What is asserted here is the part a comment cannot promise: an origin that is
 * not on the row leaves with no `access-control-allow-origin` at all, a message
 * is filed under the embed's own tenant no matter what the body says, a refused
 * bucket is observable as `EmbedRate.rejected` and the 429 count matches it, and
 * the projection a visitor reads carries none of the operator's fields.
 */

const log = createLogger({ LOG_LEVEL: "fatal", LOG_PRETTY: "0" });
const keyring = new Keyring({ id: "k1", key: Buffer.alloc(32, 7) });

const KEY = "emb_publicidentifierfortests";
const ALLOWED = "https://shop.example";
const EMBED_ID = "emb_1";
const TENANT = "tnt_one";

type Row = Record<string, unknown>;

interface EmbedSeed {
  status?: "ACTIVE" | "PAUSED";
  agentStatus?: "DRAFT" | "ACTIVE" | "PAUSED" | "ERROR";
  origins?: string[];
}

function fakeEmbed(seed: EmbedSeed = {}) {
  return {
    id: EMBED_ID,
    tenantId: TENANT,
    projectId: "prj_1",
    agentId: "agt_1",
    name: "Website widget",
    keyHash: hashEmbedKey(KEY),
    keyHint: "emb_public…",
    origins: seed.origins ?? [ALLOWED],
    status: seed.status ?? "ACTIVE",
    agent: { name: "Support", status: seed.agentStatus ?? "ACTIVE" },
  };
}

function fakeDb(seed: EmbedSeed = {}) {
  const embed = fakeEmbed(seed);
  const messages: Row[] = [];
  let nextId = 1;

  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, value]) => row[key] === value);

  const db = {
    embed: {
      findFirst: async ({ where }: { where: Row }) => (matches(embed, where) ? embed : null),
    },
    embedMessage: {
      create: async ({ data }: { data: Row }) => {
        const row: Row = { id: `msg_${nextId++}`, actions: [], citations: [], answer: null, error: null, ...data };
        messages.push(row);
        return { id: row.id };
      },
      findFirst: async ({ where, select }: { where: Row; select?: Row }) => {
        const row = messages.find((candidate) => matches(candidate, where));
        if (row === undefined) return null;
        if (select === undefined) return row;
        return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = messages.find((candidate) => candidate.id === where.id);
        if (row === undefined) throw new Error("missing message");
        Object.assign(row, data);
        return row;
      },
    },
  };
  return { db: db as unknown as PrismaClient, embed, messages };
}

function fakeQueue() {
  const jobs: NewJob[] = [];
  const queue: Queue = {
    enqueue: async (job) => {
      jobs.push(job);
      return { id: `job_${jobs.length}`, duplicate: false };
    },
    claim: async () => null,
    heartbeat: async () => true,
    attachRun: async () => {},
    succeed: async () => {},
    retry: async () => {},
    dead: async () => {},
    release: async () => {},
    counts: async () => ({ queued: 0, claimed: 0, failed: 0, dead: 0 }),
  };
  return { queue, jobs };
}

function appWith(db: PrismaClient, queue: Queue, limiter: { take: (embedId: string, ipHash: string) => Promise<boolean> }) {
  const routes = {
    db,
    keyring,
    tenantId: TENANT,
    providerConfig: { ollamaBaseUrl: "http://127.0.0.1:11434", ollamaModel: "test-model", ollamaTimeoutMs: 1000 },
    queue,
    workerStaleMs: 30_000,
  } as unknown as RouteDeps;
  return createApp({
    config: { NODE_ENV: "test" },
    log,
    db: { ping: async () => true },
    routes,
    embed: { db, queue, limiter, ipSalt: "test-salt" },
  });
}

const allowAll = { take: async () => true };

const MESSAGE = { sessionId: "session-aaaa", message: "Where do I log in?" };

describe("the origin gate", () => {
  it("answers an allowed origin with exactly that origin in the CORS header", async () => {
    const { db } = fakeDb();
    const { queue } = fakeQueue();
    const app = appWith(db, queue, allowAll);
    const res = await app.inject({ method: "GET", url: `/embed/v1/config?key=${KEY}`, headers: { origin: ALLOWED } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(res.headers.vary).toBe("origin");
    expect(res.json()).toMatchObject({ agent: "Support", widget: "Website widget", ready: true });
    await app.close();
  });

  it("refuses a disallowed origin and never sends it an allow-origin header", async () => {
    const { db } = fakeDb();
    const { queue } = fakeQueue();
    const app = appWith(db, queue, allowAll);
    const res = await app.inject({
      method: "GET",
      url: `/embed/v1/config?key=${KEY}`,
      headers: { origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("embed_origin_denied");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("refuses a request with no Origin at all — a script is what the allowlist exists to stop", async () => {
    const { db } = fakeDb();
    const { queue } = fakeQueue();
    const app = appWith(db, queue, allowAll);
    const res = await app.inject({ method: "GET", url: `/embed/v1/config?key=${KEY}` });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("answers the preflight only for an allowed origin", async () => {
    const { db } = fakeDb();
    const { queue } = fakeQueue();
    const app = appWith(db, queue, allowAll);
    const ok = await app.inject({
      method: "OPTIONS",
      url: `/embed/v1/message?key=${KEY}`,
      headers: { origin: ALLOWED, "access-control-request-method": "POST" },
    });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(ok.headers["access-control-allow-methods"]).toContain("POST");

    const denied = await app.inject({
      method: "OPTIONS",
      url: `/embed/v1/message?key=${KEY}`,
      headers: { origin: "https://evil.example" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});

describe("taking a question", () => {
  it("files the message under the embed's own tenant and queues the turn", async () => {
    const { db, messages } = fakeDb();
    const { queue, jobs } = fakeQueue();
    const app = appWith(db, queue, allowAll);
    const res = await app.inject({
      method: "POST",
      url: `/embed/v1/message?key=${KEY}`,
      headers: { origin: ALLOWED },
      // A body that tries to name a tenant is ignored by the schema; the row is
      // still filed under the scope the key resolved to.
      payload: { ...MESSAGE, tenantId: "tnt_evil", agentId: "agt_evil" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { messageId: string; status: string };
    expect(body.status).toBe("PENDING");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: body.messageId,
      tenantId: TENANT,
      embedId: EMBED_ID,
      sessionId: MESSAGE.sessionId,
      question: MESSAGE.message,
      status: "PENDING",
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      lane: "embed.turn",
      tenantId: TENANT,
      source: "embed",
      payload: { messageId: body.messageId },
    });
    await app.close();
  });

  it("answers 429 when the bucket refuses, and writes no message row", async () => {
    const { db, messages } = fakeDb();
    const { queue, jobs } = fakeQueue();
    const app = appWith(db, queue, { take: async () => false });
    const res = await app.inject({
      method: "POST",
      url: `/embed/v1/message?key=${KEY}`,
      headers: { origin: ALLOWED },
      payload: MESSAGE,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("embed_rate_limited");
    expect(messages).toHaveLength(0);
    expect(jobs).toHaveLength(0);
    await app.close();
  });

  it("refuses a paused widget and a draft agent before anything is written", async () => {
    for (const seed of [{ status: "PAUSED" as const }, { agentStatus: "DRAFT" as const }]) {
      const { db, messages } = fakeDb(seed);
      const { queue } = fakeQueue();
      const app = appWith(db, queue, allowAll);
      const res = await app.inject({
        method: "POST",
        url: `/embed/v1/message?key=${KEY}`,
        headers: { origin: ALLOWED },
        payload: MESSAGE,
      });
      expect(res.statusCode).toBe(409);
      expect(messages).toHaveLength(0);
      await app.close();
    }
  });

  it("says ready:false for a draft agent without saying why", async () => {
    const { db } = fakeDb({ agentStatus: "DRAFT" });
    const { queue } = fakeQueue();
    const app = appWith(db, queue, allowAll);
    const res = await app.inject({ method: "GET", url: `/embed/v1/config?key=${KEY}`, headers: { origin: ALLOWED } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ready).toBe(false);
    await app.close();
  });
});

describe("the conversation token", () => {
  it("returns the same message to the session that asked, and 404 to any other", async () => {
    const { db, messages } = fakeDb();
    const { queue } = fakeQueue();
    const app = appWith(db, queue, allowAll);
    const accepted = await app.inject({
      method: "POST",
      url: `/embed/v1/message?key=${KEY}`,
      headers: { origin: ALLOWED },
      payload: MESSAGE,
    });
    const { messageId } = accepted.json() as { messageId: string };
    const stored = messages[0];
    if (stored === undefined) throw new Error("the message row was not written");
    stored.status = "ANSWERED";
    stored.answer = "The login page is /login.";

    const mine = await app.inject({
      method: "GET",
      url: `/embed/v1/message/${messageId}?key=${KEY}&session=${MESSAGE.sessionId}`,
      headers: { origin: ALLOWED },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ messageId, status: "ANSWERED", reply: "The login page is /login." });

    const other = await app.inject({
      method: "GET",
      url: `/embed/v1/message/${messageId}?key=${KEY}&session=someone-elses`,
      headers: { origin: ALLOWED },
    });
    expect(other.statusCode).toBe(404);
    await app.close();
  });
});

describe("the projection", () => {
  it("carries no operator field even when the row holds them", async () => {
    const { db, messages } = fakeDb();
    const { queue } = fakeQueue();
    const app = appWith(db, queue, allowAll);
    const accepted = await app.inject({
      method: "POST",
      url: `/embed/v1/message?key=${KEY}`,
      headers: { origin: ALLOWED },
      payload: MESSAGE,
    });
    const { messageId } = accepted.json() as { messageId: string };
    const stored = messages[0];
    if (stored === undefined) throw new Error("the message row was not written");
    Object.assign(stored, {
      status: "ANSWERED",
      answer: "Yes — within 14 days.",
      actions: [{ kind: "goto", label: "Refund policy", url: "https://shop.example/refund" }],
      citations: [{ docId: "doc_1", title: "Refund policy", chunkId: "chunk_1", url: "https://shop.example/refund" }],
      systemPrompt: "SECRET SYSTEM PROMPT",
      tokensUsed: 1234,
      tenantId: TENANT,
      conversationId: "cnv_1",
    });
    const res = await app.inject({
      method: "GET",
      url: `/embed/v1/message/${messageId}?key=${KEY}&session=${MESSAGE.sessionId}`,
      headers: { origin: ALLOWED },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["actions", "citations", "error", "messageId", "reply", "status"]);
    for (const key of FORBIDDEN_PROJECTION_KEYS) {
      expect(body).not.toHaveProperty(key);
    }
    expect(res.body).not.toContain("SECRET SYSTEM PROMPT");
    expect(res.body).not.toContain(TENANT);
    expect(body.actions).toEqual([{ kind: "goto", label: "Refund policy", url: "https://shop.example/refund" }]);
    await app.close();
  });

  it("shows a failed turn's public reason, and nothing else", async () => {
    const { db, messages } = fakeDb();
    const { queue } = fakeQueue();
    const app = appWith(db, queue, allowAll);
    const accepted = await app.inject({
      method: "POST",
      url: `/embed/v1/message?key=${KEY}`,
      headers: { origin: ALLOWED },
      payload: MESSAGE,
    });
    const { messageId } = accepted.json() as { messageId: string };
    const stored = messages[0];
    if (stored === undefined) throw new Error("the message row was not written");
    Object.assign(stored, { status: "FAILED", error: "This assistant is not available right now." });
    const res = await app.inject({
      method: "GET",
      url: `/embed/v1/message/${messageId}?key=${KEY}&session=${MESSAGE.sessionId}`,
      headers: { origin: ALLOWED },
    });
    expect(res.json()).toMatchObject({
      status: "FAILED",
      reply: null,
      error: "This assistant is not available right now.",
    });
    await app.close();
  });
});

describe("the Postgres bucket", () => {
  it("counts every refusal it hands back, so the console's rejected column is the 429s themselves", async () => {
    // A faithful in-memory stand-in for the two statements: the upsert spends a
    // token when the balance allows it, and the second statement increments
    // `rejected` only on a refusal.
    const buckets = new Map<string, { tokens: number; rejected: number }>();
    const raw = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      // The insert's placeholders are (embedId, ipHash, tokens, …); the conflict
      // branch reuses capacity and refill, so only the first three are read here.
      const [embedId, ipHash, initial] = values as [string, string, number];
      const key = `${embedId}:${ipHash}`;
      const bucket = buckets.get(key);
      if (bucket === undefined) {
        buckets.set(key, { tokens: initial, rejected: 0 });
        return [{ tokens: initial }];
      }
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return [{ tokens: bucket.tokens }];
      }
      return [];
    };
    const execute = async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const key = `${String(values[0])}:${String(values[1])}`;
      const bucket = buckets.get(key);
      if (bucket !== undefined) bucket.rejected += 1;
      return 1;
    };
    const db = { $queryRaw: raw, $executeRaw: execute } as unknown as PrismaClient;
    const limiter = createPgRateLimiter(db, { capacity: 2, refillPerMinute: 0.0001 });

    const results: boolean[] = [];
    for (let i = 0; i < 5; i += 1) results.push(await limiter.take(EMBED_ID, "ip-hash"));
    expect(results).toEqual([true, true, false, false, false]);
    const bucket = buckets.get(`${EMBED_ID}:ip-hash`);
    expect(bucket?.rejected).toBe(results.filter((allowed) => !allowed).length);
  });
});
