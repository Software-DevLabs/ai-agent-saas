import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { NewJob, Queue } from "@saas/core";
import { Keyring, createLogger } from "@saas/shared";
import { createApp } from "../src/app.ts";
import type { RouteDeps } from "../src/routes.ts";

/**
 * The knowledge surface over HTTP, against a fake that behaves like the tables.
 *
 * These assert the properties that would otherwise be promises in a comment: the
 * document is filed in the agent's own project and granted in the same write, a
 * second upload of the same text writes nothing, the search box resolves its scope
 * from the grant rows (not from the request), an undecodable file is refused before
 * it is stored, and the 8 MiB upload cap did not become the body limit of the rest
 * of the API.
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
    if (value !== null && typeof value === "object" && "in" in (value as object)) {
      return ((value as { in: unknown[] }).in ?? []).includes(row[key]);
    }
    return row[key] === value;
  });
}

function pick<T extends Row>(row: T, select: unknown): Row {
  if (select === undefined || select === null || typeof select !== "object") return { ...row };
  const keys = Object.keys(select as Record<string, boolean>);
  return Object.fromEntries(keys.filter((key) => key !== "_count").map((key) => [key, row[key]]));
}

interface Seed {
  docs?: Row[];
  grants?: Row[];
}

function fakeDb(seed: Seed = {}) {
  const docs = seed.docs ?? [];
  const grants = seed.grants ?? [];
  const agent = { id: "agt_1", tenantId: "tnt_one", projectId: "prj_two", name: "Support" };
  const now = new Date("2026-10-31T10:00:00Z");

  const knowledgeDoc = {
    findFirst: async ({ where, select }: { where: unknown; select?: unknown }) => {
      const row = docs.find((doc) => matches(doc, where));
      return row === undefined ? null : pick(row, select);
    },
    findFirstOrThrow: async ({ where, select }: { where: unknown; select?: unknown }) => {
      const row = docs.find((doc) => matches(doc, where));
      if (row === undefined) throw new Error("not found");
      return pick(row, select);
    },
    findMany: async ({ where, select }: { where: unknown; select?: unknown }) =>
      docs.filter((doc) => matches(doc, where)).map((doc) => pick(doc, select)),
    count: async ({ where }: { where: unknown }) => docs.filter((doc) => matches(doc, where) && doc.status === "INDEXED").length,
    create: async ({ data }: { data: Row }) => {
      const row: Row = {
        id: `doc_${docs.length + 1}`,
        error: null,
        meta: {},
        chunkCount: 0,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      docs.push(row);
      return { id: row.id };
    },
    update: async ({ where, data }: { where: unknown; data: Row }) => {
      const row = docs.find((doc) => matches(doc, where));
      if (row !== undefined) Object.assign(row, data, { updatedAt: now });
      return row;
    },
    updateMany: async ({ where, data }: { where: unknown; data: Row }) => {
      const found = docs.filter((doc) => matches(doc, where));
      for (const row of found) Object.assign(row, data, { updatedAt: now });
      return { count: found.length };
    },
    delete: async ({ where }: { where: unknown }) => {
      const at = docs.findIndex((doc) => matches(doc, where));
      const [removed] = docs.splice(at, 1);
      return removed;
    },
  };

  const agentCapability = {
    findFirst: async ({ where, select }: { where: unknown; select?: unknown }) => {
      const row = grants.find((grant) => matches(grant, where));
      return row === undefined ? null : pick(row, select);
    },
    findMany: async ({ where, select }: { where: unknown; select?: unknown }) =>
      grants.filter((grant) => matches(grant, where)).map((grant) => pick(grant, select)),
    create: async ({ data }: { data: Row }) => {
      grants.push({ id: `cap_${grants.length + 1}`, tenantId: "tnt_one", enabled: true, config: {}, ...data });
      return { id: `cap_${grants.length}` };
    },
    updateMany: async ({ where, data }: { where: unknown; data: Row }) => {
      const found = grants.filter((grant) => matches(grant, where));
      for (const row of found) Object.assign(row, data);
      return { count: found.length };
    },
    deleteMany: async ({ where }: { where: unknown }) => {
      const before = grants.length;
      for (let at = grants.length - 1; at >= 0; at -= 1) {
        if (matches(grants[at] as Row, where)) grants.splice(at, 1);
      }
      return { count: before - grants.length };
    },
  };

  const tx = { agentCapability, knowledgeDoc };
  const db = {
    agent: { findFirst: async () => agent },
    skill: { findMany: async () => [] },
    skillVersion: { findMany: async () => [] },
    site: { findMany: async () => [] },
    agentCapability,
    knowledgeDoc,
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      rawQueries.push(values);
      return [
        { chunkId: "chunk_1", docId: "doc_1", seq: 0, title: "Refund policy", text: "Refunds are issued within 14 days.", score: 0.75 },
      ];
    },
  };
  const rawQueries: unknown[][] = [];
  return { db: db as unknown as PrismaClient, docs, grants, rawQueries };
}

function fakeQueue() {
  const jobs: NewJob[] = [];
  const keys = new Set<string>();
  const queue: Queue = {
    enqueue: async (job) => {
      const duplicate = keys.has(`${job.source}:${job.externalMessageId}`);
      if (!duplicate) {
        keys.add(`${job.source}:${job.externalMessageId}`);
        jobs.push(job);
      }
      return { id: `job_${jobs.length}`, duplicate };
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

function appWith(db: PrismaClient, queue: Queue) {
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

const NOTE = { title: "Refund policy", text: "Refunds are issued within 14 days of the return arriving." };

function multipart(filename: string, mime: string, body: string) {
  const boundary = "----saas-test-boundary";
  const payload = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${mime}`,
    "",
    body,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

describe("storing knowledge", () => {
  it("files the document in the agent's project, grants it, and queues the index job", async () => {
    const { db, docs, grants } = fakeDb();
    const { queue, jobs } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({ method: "POST", url: "/agents/agt_1/knowledge", payload: NOTE });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ duplicate: false, granted: true, queued: true, queue: "queued" });
    expect(body.doc).toMatchObject({ title: "Refund policy", kind: "NOTE", status: "PENDING", projectId: "prj_two", granted: true });

    expect(docs[0]).toMatchObject({ tenantId: "tnt_one", projectId: "prj_two", status: "PENDING" });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ kind: "KNOWLEDGE", ref: docs[0]!.id, enabled: true, agentId: "agt_1" });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ lane: "knowledge.index", tenantId: "tnt_one", source: "knowledge" });
    expect(jobs[0]!.externalMessageId).toMatch(/^doc_1:index:[0-9a-f]{8}$/);
    expect(jobs[0]!.payload).toMatchObject({ docId: "doc_1", tenantId: "tnt_one" });
    await app.close();
  });

  it("writes nothing for a second upload of the same text, and says so", async () => {
    const { db, docs, grants } = fakeDb();
    const { queue } = fakeQueue();
    const app = appWith(db, queue);

    await app.inject({ method: "POST", url: "/agents/agt_1/knowledge", payload: NOTE });
    const again = await app.inject({ method: "POST", url: "/agents/agt_1/knowledge", payload: NOTE });

    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ duplicate: true, granted: false });
    expect(docs).toHaveLength(1);
    expect(grants).toHaveLength(1);
    await app.close();
  });

  it("lists only the agent's project, with the grant state the server resolved", async () => {
    const { db } = fakeDb({
      docs: [
        {
          id: "doc_mine", tenantId: "tnt_one", projectId: "prj_two", kind: "NOTE", title: "Mine", mime: "text/plain",
          status: "INDEXED", error: null, charCount: 10, byteSize: 10, chunkCount: 1, sha256: "a".repeat(64),
          content: "hello", meta: {}, createdAt: new Date(), updatedAt: new Date(),
        },
        {
          id: "doc_other", tenantId: "tnt_one", projectId: "prj_other", kind: "NOTE", title: "Other project", mime: "text/plain",
          status: "INDEXED", error: null, charCount: 10, byteSize: 10, chunkCount: 1, sha256: "b".repeat(64),
          content: "hello", meta: {}, createdAt: new Date(), updatedAt: new Date(),
        },
      ],
      grants: [{ id: "cap_1", tenantId: "tnt_one", agentId: "agt_1", kind: "KNOWLEDGE", ref: "doc_mine", enabled: true }],
    });
    const { queue } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({ method: "GET", url: "/agents/agt_1/knowledge" });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ id: string; granted: boolean }>;
    expect(rows.map((row) => row.id)).toEqual(["doc_mine"]);
    expect(rows[0]!.granted).toBe(true);
    await app.close();
  });

  it("refuses a PDF at the door, naming the formats that work", async () => {
    const { db, docs } = fakeDb();
    const { queue, jobs } = fakeQueue();
    const app = appWith(db, queue);

    const form = multipart("terms.pdf", "application/pdf", "%PDF-1.7\n...");
    const res = await app.inject({ method: "POST", url: "/agents/agt_1/knowledge/upload", ...form });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("knowledge_undecodable");
    expect(res.json().message).toContain("text/plain");
    expect(docs).toHaveLength(0);
    expect(jobs).toHaveLength(0);
    await app.close();
  });
});

describe("uploads and limits", () => {
  it("accepts a file over 1 MiB through the child limit, while JSON stays capped at 1 MiB", async () => {
    const { db } = fakeDb();
    const { queue } = fakeQueue();
    const app = appWith(db, queue);

    // ~1.3 MB of markup that decodes to ~120 KB of text: the bytes clear the global
    // body limit, the decoded text clears the document limit.
    const paragraph = `<div data-pad="${"x".repeat(180)}"><p>Refunds take fourteen days.</p></div>\n`;
    const html = paragraph.repeat(6_000);
    expect(html.length).toBeGreaterThan(1_048_576);

    const form = multipart("refunds.html", "text/html", html);
    const uploaded = await app.inject({ method: "POST", url: "/agents/agt_1/knowledge/upload", ...form });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().doc).toMatchObject({ kind: "FILE", mime: "text/html" });
    expect(uploaded.json().doc.charCount).toBeLessThan(400_000);

    // The same size as JSON is still refused by the API-wide limit.
    const tooBig = await app.inject({
      method: "POST",
      url: "/agents/agt_1/knowledge",
      payload: { text: "a".repeat(1_400_000) },
    });
    expect(tooBig.statusCode).toBe(413);
    await app.close();
  });
});

describe("the search box", () => {
  const indexed = {
    id: "doc_1", tenantId: "tnt_one", projectId: "prj_two", kind: "NOTE", title: "Refund policy", mime: "text/plain",
    status: "INDEXED", error: null, charCount: 40, byteSize: 40, chunkCount: 1, sha256: "c".repeat(64),
    content: "Refunds are issued within 14 days.", meta: {}, createdAt: new Date(), updatedAt: new Date(),
  };

  it("searches exactly the documents the grant resolves, and reports the backend", async () => {
    const { db, rawQueries } = fakeDb({
      docs: [indexed],
      grants: [{ id: "cap_1", tenantId: "tnt_one", agentId: "agt_1", kind: "KNOWLEDGE", ref: "doc_1", enabled: true }],
    });
    const { queue } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({ method: "GET", url: "/agents/agt_1/knowledge/search?q=refund" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ backend: "keyword", searched: 1 });
    expect(body.hits[0]).toMatchObject({ docId: "doc_1", backend: "keyword" });
    // The first raw query of a search is the embeddings probe the assembler runs,
    // so the keyword statement is found by its array parameter rather than by order.
    const keyword = rawQueries.find((values) => values.some((value) => Array.isArray(value)));
    expect(keyword).toContain("tnt_one");
    expect(keyword).toContainEqual(["doc_1"]);
    expect(body.note).toContain("granted document");
    await app.close();
  });

  it("searches nothing when no document is granted, and says why", async () => {
    const { db } = fakeDb({ docs: [indexed] });
    const { queue } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({ method: "GET", url: "/agents/agt_1/knowledge/search?q=refund" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ backend: "none", searched: 0 });
    expect(res.json().note).toContain("no knowledge document");
    await app.close();
  });
});

describe("knowledge grants", () => {
  it("refuses a grant that names no document in this tenant", async () => {
    const { db } = fakeDb();
    const { queue } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({
      method: "PUT",
      url: "/agents/agt_1/capabilities",
      payload: { capabilities: [{ kind: "KNOWLEDGE", ref: "doc_missing" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("capability_knowledge_unknown");
    await app.close();
  });

  it("accepts a grant that names a document, and resolves its state", async () => {
    const doc = {
      id: "doc_1", tenantId: "tnt_one", projectId: "prj_two", kind: "NOTE", title: "Refund policy", mime: "text/plain",
      status: "INDEXED", error: null, charCount: 40, byteSize: 40, chunkCount: 2, sha256: "d".repeat(64),
      content: "Refunds…", meta: {}, createdAt: new Date(), updatedAt: new Date(),
    };
    const { db } = fakeDb({ docs: [doc] });
    const { queue } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({
      method: "PUT",
      url: "/agents/agt_1/capabilities",
      payload: { capabilities: [{ kind: "KNOWLEDGE", ref: "doc_1" }] },
    });
    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view.grants[0]).toMatchObject({ kind: "KNOWLEDGE", ref: "doc_1", state: "READY", label: "Refund policy" });
    expect(view.knowledge[0]).toMatchObject({ docId: "doc_1", state: "READY" });
    expect(view.available.knowledge[0]).toMatchObject({ docId: "doc_1", indexed: true });
    await app.close();
  });
});

describe("deleting a document", () => {
  it("removes its grants in the same transaction", async () => {
    const doc = {
      id: "doc_1", tenantId: "tnt_one", projectId: "prj_two", kind: "NOTE", title: "Old policy", mime: "text/plain",
      status: "INDEXED", error: null, charCount: 10, byteSize: 10, chunkCount: 1, sha256: "e".repeat(64),
      content: "old", meta: {}, createdAt: new Date(), updatedAt: new Date(),
    };
    const { db, docs, grants } = fakeDb({
      docs: [doc],
      grants: [{ id: "cap_1", tenantId: "tnt_one", agentId: "agt_1", kind: "KNOWLEDGE", ref: "doc_1", enabled: true }],
    });
    const { queue } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({ method: "DELETE", url: "/knowledge/doc_1" });
    expect(res.statusCode).toBe(204);
    expect(docs).toHaveLength(0);
    expect(grants).toHaveLength(0);
    await app.close();
  });
});
