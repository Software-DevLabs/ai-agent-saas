import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  ACCEPTED_MIMES,
  KNOWLEDGE_LANE,
  loadCapabilities,
  searchKnowledge,
  toPlainText,
  type IndexPayload,
  type QueryEmbedder,
  type Queue,
  type SearchBackend,
  type SearchHit,
} from "@saas/core";
import { tenantWhere } from "@saas/db";
import { badRequest, conflict, notFound } from "../http-error.ts";

/**
 * Knowledge documents, from the console's side.
 *
 * Three rules hold here, and each one exists because the alternative is a feature
 * that lies:
 *
 * 1. **A stored document is only searchable once a worker has said so.** Writing the
 *    row is not indexing it; the row goes in as `PENDING` and a queue job moves it
 *    through `INDEXING` to `INDEXED` or `FAILED`. The console reads that column, so
 *    "my file is not answering" is a status, not a mystery.
 * 2. **Access is a grant, never a copy.** A document belongs to a project; which
 *    agent may search it is an `AgentCapability` row of kind `KNOWLEDGE`. Uploading
 *    from an agent's own tab writes both, in that agent's project, and nothing else.
 * 3. **The bytes decide the duplicate.** Same tenant, same project, same sha-256
 *    returns the row that already exists instead of a second copy of one document
 *    answering twice.
 */

export interface KnowledgeDocDto {
  id: string;
  projectId: string | null;
  kind: "FILE" | "PAGE" | "NOTE";
  title: string;
  mime: string;
  status: "PENDING" | "INDEXING" | "INDEXED" | "FAILED";
  error: string | null;
  charCount: number;
  byteSize: number;
  chunkCount: number;
  /** First eight of the content hash — enough to see that two uploads were the same file. */
  sha8: string;
  /** Whether the agent this list was read through is granted it. */
  granted: boolean;
  /**
   * The vector half, written by the embed lane into the document's own meta. Null
   * until a job succeeds — the keyword index is usable before this exists, and the
   * console says which half it has rather than implying both.
   */
  embedding: { model: string; dim: number; chunks: number; at: string } | null;
  /** Why the semantic half failed, when it did. Never hides a keyword-indexed document. */
  embeddingError: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on the single-document read only; a list never carries 400 kB of text. */
  excerpt?: string;
}

export interface KnowledgeWriteDto {
  doc: KnowledgeDocDto;
  duplicate: boolean;
  /** False when the grant already existed, so the console can say what it changed. */
  granted: boolean;
  queued: boolean;
  /** What the queue answered: `new`, `already queued`, or the reason nothing was queued. */
  queue: string;
}

export interface KnowledgeSearchDto {
  query: string;
  backend: SearchBackend;
  hits: SearchHit[];
  /** How many documents the agent is granted, so an empty result says *why*. */
  searched: number;
  note: string;
}

const MAX_TITLE = 200;
const EXCERPT_CHARS = 1_200;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const docSelect = {
  id: true,
  projectId: true,
  kind: true,
  title: true,
  mime: true,
  status: true,
  error: true,
  charCount: true,
  byteSize: true,
  chunkCount: true,
  sha256: true,
  meta: true,
  createdAt: true,
  updatedAt: true,
} as const;

type DocRow = {
  id: string;
  projectId: string | null;
  kind: string;
  title: string;
  mime: string;
  status: string;
  error: string | null;
  charCount: number;
  byteSize: number;
  chunkCount: number;
  sha256: string;
  meta: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function metaObject(meta: unknown): Record<string, unknown> {
  return typeof meta === "object" && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
}

function embeddingOf(meta: unknown): KnowledgeDocDto["embedding"] {
  const value = metaObject(meta).embedding;
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.model !== "string" || typeof entry.dim !== "number" || typeof entry.chunks !== "number") return null;
  return { model: entry.model, dim: entry.dim, chunks: entry.chunks, at: typeof entry.at === "string" ? entry.at : "" };
}

function toDto(row: DocRow, granted: boolean, content?: string): KnowledgeDocDto {
  const meta = metaObject(row.meta);
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as KnowledgeDocDto["kind"],
    title: row.title,
    mime: row.mime,
    status: row.status as KnowledgeDocDto["status"],
    error: row.error,
    charCount: row.charCount,
    byteSize: row.byteSize,
    chunkCount: row.chunkCount,
    sha8: row.sha256.slice(0, 8),
    granted,
    embedding: embeddingOf(row.meta),
    embeddingError: typeof meta.embeddingError === "string" ? meta.embeddingError : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(content === undefined ? {} : { excerpt: content.slice(0, EXCERPT_CHARS) }),
  };
}

/** The agent, and the project its documents live in. */
async function requireKnowledgeAgent(db: PrismaClient, tenantId: string, agentId: string): Promise<{ id: string; projectId: string }> {
  const row = await db.agent.findFirst({ where: tenantWhere(tenantId, { id: agentId }), select: { id: true, projectId: true } });
  if (row === null) throw notFound("agent_not_found", `agent ${agentId} is not in this tenant`);
  return row;
}

async function grantedDocIds(db: PrismaClient, tenantId: string, agentId: string): Promise<Set<string>> {
  const rows = await db.agentCapability.findMany({
    where: tenantWhere(tenantId, { agentId, kind: "KNOWLEDGE" }),
    select: { ref: true, enabled: true },
  });
  return new Set(rows.filter((row) => row.enabled).map((row) => row.ref));
}

/**
 * Everything in the agent's project, each row flagged with whether *this* agent may
 * search it. Listing the project's documents rather than only the granted ones is
 * the point: the operator sees what is available before ticking it.
 */
export async function listAgentKnowledge(db: PrismaClient, tenantId: string, agentId: string): Promise<KnowledgeDocDto[]> {
  const agent = await requireKnowledgeAgent(db, tenantId, agentId);
  const [rows, granted] = await Promise.all([
    db.knowledgeDoc.findMany({
      where: tenantWhere(tenantId, { projectId: agent.projectId }),
      orderBy: { updatedAt: "desc" },
      select: docSelect,
    }),
    grantedDocIds(db, tenantId, agentId),
  ]);
  return rows.map((row) => toDto(row, granted.has(row.id)));
}

export async function getKnowledgeDoc(db: PrismaClient, tenantId: string, docId: string): Promise<KnowledgeDocDto & { content: string }> {
  const row = await db.knowledgeDoc.findFirst({
    where: tenantWhere(tenantId, { id: docId }),
    select: { ...docSelect, content: true },
  });
  if (row === null) throw notFound("knowledge_not_found", `knowledge document ${docId} is not in this tenant`);
  const { content, ...rest } = row;
  return { ...toDto(rest, true, content), content };
}

/**
 * A title the operator did not supply is the document's own first line, cleaned: a
 * file called "terms" and a heading "Terms of service" should not both be labelled
 * "terms.md", and a title is what the model is told it is reading.
 */
function deriveTitle(given: string | undefined, filename: string | undefined, text: string): string {
  const explicit = given?.trim();
  if (explicit && explicit !== "") return explicit.slice(0, MAX_TITLE);
  const name = filename?.trim();
  if (name && name !== "") return name.slice(0, MAX_TITLE);
  const firstLine = text.split("\n").map((line) => line.replace(/^#+\s*/, "").replace(/^-\s*/, "").trim()).find((line) => line !== "");
  return (firstLine ?? "untitled document").slice(0, MAX_TITLE);
}

async function queueIndex(queue: Queue, tenantId: string, docId: string, sha8: string, explicit: boolean): Promise<{ queued: boolean; queue: string }> {
  const payload: IndexPayload = { docId, tenantId, sha8 };
  // The automatic key is content-derived, so a re-upload of the same bytes finds the
  // job that already exists. An explicit "index it again" is a different intent — the
  // operator is asking for a second attempt — so it gets its own key rather than
  // being silently swallowed by the first one.
  const externalMessageId = explicit ? `${docId}:reindex:${new Date().toISOString()}` : `${docId}:index:${sha8}`;
  const enqueued = await queue.enqueue({ lane: KNOWLEDGE_LANE, tenantId, source: "knowledge", externalMessageId, payload });
  return enqueued.duplicate
    ? { queued: false, queue: "an index job for these bytes is already on the queue" }
    : { queued: true, queue: "queued" };
}

/**
 * One write path for a note, a pasted document and an uploaded file: the bytes are
 * decoded first, so nothing that cannot be read is ever stored, and the duplicate
 * check runs on the decoded text rather than the container.
 */
async function storeDocument(
  db: PrismaClient,
  queue: Queue,
  tenantId: string,
  agentId: string,
  input: { kind: "FILE" | "NOTE"; title?: string; filename?: string; mime: string; text: string; byteSize: number },
): Promise<KnowledgeWriteDto> {
  const agent = await requireKnowledgeAgent(db, tenantId, agentId);
  const text = input.text.trim();
  if (text === "") throw badRequest("knowledge_empty", "there is no text to index in what you sent");
  const hash = sha256(text);
  const existing = await db.knowledgeDoc.findFirst({
    where: tenantWhere(tenantId, { projectId: agent.projectId, sha256: hash }),
    select: docSelect,
  });

  if (existing !== null) {
    const wasGranted = (await grantedDocIds(db, tenantId, agentId)).has(existing.id);
    if (!wasGranted) await grantDoc(db, tenantId, agentId, existing.id);
    const needsIndex = existing.status === "PENDING" || existing.status === "FAILED";
    // A stored-but-failed duplicate still needs its second attempt, or "it is
    // already here" would be a dead end the operator cannot get out of.
    const tail = needsIndex
      ? await queueIndex(queue, tenantId, existing.id, hash.slice(0, 8), existing.status === "FAILED")
      : { queued: false, queue: "already indexed" };
    return { doc: toDto(existing, true), duplicate: true, granted: !wasGranted, ...tail };
  }

  const created = await db.knowledgeDoc.create({
    data: {
      tenantId,
      projectId: agent.projectId,
      kind: input.kind,
      title: deriveTitle(input.title, input.filename, text),
      mime: input.mime,
      content: text,
      charCount: text.length,
      byteSize: input.byteSize,
      sha256: hash,
      status: "PENDING",
      meta: { ...(input.filename ? { filename: input.filename } : {}) },
    },
    select: { id: true },
  });
  await grantDoc(db, tenantId, agentId, created.id);
  const row = await db.knowledgeDoc.findFirstOrThrow({ where: tenantWhere(tenantId, { id: created.id }), select: docSelect });
  const tail = await queueIndex(queue, tenantId, created.id, hash.slice(0, 8), false);
  return { doc: toDto(row, true), duplicate: false, granted: true, ...tail };
}

async function grantDoc(db: PrismaClient, tenantId: string, agentId: string, docId: string): Promise<void> {
  const existing = await db.agentCapability.findFirst({ where: tenantWhere(tenantId, { agentId, kind: "KNOWLEDGE", ref: docId }), select: { id: true } });
  if (existing !== null) {
    await db.agentCapability.updateMany({ where: { AND: [tenantWhere(tenantId, {}), { id: existing.id }] }, data: { enabled: true } });
    return;
  }
  await db.agentCapability.create({ data: { tenantId, agentId, kind: "KNOWLEDGE", ref: docId, enabled: true, config: {} } });
}

export async function addKnowledgeNote(
  db: PrismaClient,
  queue: Queue,
  tenantId: string,
  agentId: string,
  input: { title?: string; text: string },
): Promise<KnowledgeWriteDto> {
  return storeDocument(db, queue, tenantId, agentId, {
    kind: "NOTE",
    ...(input.title === undefined ? {} : { title: input.title }),
    mime: "text/plain",
    text: input.text,
    byteSize: Buffer.byteLength(input.text, "utf8"),
  });
}

/**
 * The upload path. Decoding happens before anything is written, so an undecodable
 * file is a refusal that names the formats that work rather than a document that
 * indexes as zero chunks and looks alive for months.
 */
export async function addKnowledgeFile(
  db: PrismaClient,
  queue: Queue,
  tenantId: string,
  agentId: string,
  input: { filename: string; mime: string; bytes: Uint8Array; title?: string },
): Promise<KnowledgeWriteDto> {
  const decoded = toPlainText(input.mime, input.bytes);
  if (!decoded.ok) {
    throw badRequest("knowledge_undecodable", decoded.reason, { accepted: [...ACCEPTED_MIMES], filename: input.filename });
  }
  return storeDocument(db, queue, tenantId, agentId, {
    kind: "FILE",
    filename: input.filename,
    ...(input.title === undefined ? {} : { title: input.title }),
    mime: decoded.mime,
    text: decoded.text,
    byteSize: input.bytes.byteLength,
  });
}

/**
 * Deleting a document takes its grants with it. Leaving them behind would put a ref
 * into the next turn that cannot resolve, and the plan's rule is that a console
 * never shows a capability the build cannot honour.
 */
export async function deleteKnowledgeDoc(db: PrismaClient, tenantId: string, docId: string): Promise<{ grantsRemoved: number }> {
  const row = await db.knowledgeDoc.findFirst({ where: tenantWhere(tenantId, { id: docId }), select: { id: true } });
  if (row === null) throw notFound("knowledge_not_found", `knowledge document ${docId} is not in this tenant`);
  const removed = await db.$transaction(async (tx) => {
    const grants = await tx.agentCapability.deleteMany({ where: tenantWhere(tenantId, { kind: "KNOWLEDGE", ref: row.id }) });
    await tx.knowledgeDoc.delete({ where: { id: row.id } });
    return grants.count;
  });
  return { grantsRemoved: removed };
}

/**
 * Re-index is an explicit retry, and it is refused while a job is in flight rather
 * than queued twice: two indexers on one document delete each other's chunks.
 */
export async function reindexKnowledgeDoc(
  db: PrismaClient,
  queue: Queue,
  tenantId: string,
  docId: string,
): Promise<{ doc: KnowledgeDocDto; queued: boolean; queue: string }> {
  const row = await db.knowledgeDoc.findFirst({ where: tenantWhere(tenantId, { id: docId }), select: docSelect });
  if (row === null) throw notFound("knowledge_not_found", `knowledge document ${docId} is not in this tenant`);
  if (row.status === "INDEXING") throw conflict("knowledge_indexing", `document ${row.title} is being indexed right now`);
  await db.knowledgeDoc.updateMany({
    where: tenantWhere(tenantId, { id: row.id }),
    data: { status: "PENDING", error: null, chunkCount: 0 },
  });
  const tail = await queueIndex(queue, tenantId, row.id, row.sha256.slice(0, 8), true);
  const fresh = await db.knowledgeDoc.findFirstOrThrow({ where: tenantWhere(tenantId, { id: row.id }), select: docSelect });
  return { doc: toDto(fresh, true), ...tail };
}

/**
 * The search box: the engine, the rows, and the scope the *agent* would be given.
 *
 * It resolves the scope through the same `loadCapabilities` a turn uses, which is
 * what makes it a test rather than a demo — if the grant list and the retriever
 * disagree, this says so in front of the operator instead of after a model call.
 * No provider is contacted and no token is spent, so asking it twice is free.
 */
export async function searchAgentKnowledge(
  db: PrismaClient,
  tenantId: string,
  agentId: string,
  query: string,
  limit: number,
  embed?: QueryEmbedder,
): Promise<KnowledgeSearchDto> {
  await requireKnowledgeAgent(db, tenantId, agentId);
  const loaded = await loadCapabilities(db, tenantId, agentId);
  const docIds = loaded.knowledgeDocs.map((doc) => doc.docId);
  // A daemon that is down or a model that is not pulled degrades to the keyword
  // index; `backend` in the answer says which engine actually ran, so the console
  // never has to guess and never presents a fallback as the semantic path.
  let vector: Awaited<ReturnType<QueryEmbedder>> = null;
  if (embed !== undefined && docIds.length > 0) {
    vector = await embed(query).catch(() => null);
  }
  const hits = await searchKnowledge(db, { tenantId, docIds, limit }, query, vector ?? undefined);
  const unreadable = loaded.knowledge.filter((doc) => doc.state === "UNAVAILABLE");
  const engines = vector === null ? "keyword only" : "vector, then keyword";
  const base =
    docIds.length === 0
      ? loaded.knowledge.length === 0
        ? "this agent is granted no knowledge document — upload or paste one, then tick it"
        : loaded.knowledge.map((doc) => `${doc.title}: ${doc.reason ?? "unavailable"}`).join("; ")
      : hits.backend === "none"
        ? `no passage matched those words in ${docIds.length} granted document(s) (tried ${engines})`
        : `${hits.hits.length} passage(s) from ${docIds.length} granted document(s), matched by ${hits.backend}`;
  const note =
    unreadable.length === 0 ? base : `${base}. Unreadable grants: ${unreadable.map((doc) => doc.title).join(", ")}`;
  return {
    query,
    backend: hits.backend,
    hits: hits.hits,
    searched: docIds.length,
    note,
  };
}
