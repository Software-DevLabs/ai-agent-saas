import type { PrismaClient } from "@prisma/client";
import { chunkDocument, type ChunkFormat } from "./chunk.ts";

/**
 * The indexer: a stored document's text becomes searchable rows.
 *
 * It runs in the worker, never in the request that uploaded the file, for the same
 * reason the model call does not happen in a request: a long job held open by a
 * browser is a job nobody can see. The document's own status column is the whole
 * protocol — `PENDING` when the row is written, `INDEXING` while this runs,
 * `INDEXED` with a chunk count, or `FAILED` with the message that says why. The
 * console reads that column and never has to trust a promise.
 *
 * Re-indexing deletes the document's chunks and writes them again, so editing a
 * document cannot leave two versions of one sentence searchable. Chunk rows are
 * written with one parameterised statement rather than a `createMany` per chunk
 * because `textTsv` is a column the Prisma client cannot author: it is a `tsvector`,
 * and the only way to fill it with something Postgres can index is to let Postgres
 * compute it in the insert.
 */

/** The queue lane this runs on. Its own lane so an indexing job never blocks a reply. */
export const KNOWLEDGE_LANE = "knowledge.index";

export interface IndexPayload {
  docId: string;
  tenantId: string;
  /** Set by the producer so a re-crawl of the same bytes is the same job key. */
  sha8?: string;
}

/** The `@@` index is built on this exact expression; changing it silently costs the index. */
export const TSVECTOR_DICTIONARY = "english";

const INSERT_BATCH = 50;

interface DocRow {
  id: string;
  tenantId: string;
  title: string;
  content: string;
  mime: string;
  status: string;
}

export async function indexDocument(db: PrismaClient, docId: string): Promise<{ chunks: number }> {
  const found = await db.$queryRaw<DocRow[]>`
    SELECT "id", "tenantId", "title", "content", "mime", "status"
    FROM "KnowledgeDoc"
    WHERE "id" = ${docId}
    LIMIT 1`;
  const doc = found[0];
  if (doc === undefined) throw new Error(`knowledge document ${docId} does not exist`);

  await db.knowledgeDoc.update({ where: { id: doc.id }, data: { status: "INDEXING", error: null } });

  try {
    const drafts = chunkDocument(doc.content, { format: formatFor(doc.mime) });
    if (drafts.length === 0) throw new Error("the document has no text left after chunking");

    await db.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM "KnowledgeChunk" WHERE "docId" = ${doc.id}`;
      for (let at = 0; at < drafts.length; at += INSERT_BATCH) {
        const batch = drafts.slice(at, at + INSERT_BATCH);
        const columns = ['"id"', '"docId"', '"tenantId"', '"seq"', '"text"', '"charCount"', '"textTsv"'];
        const rows: string[] = [];
        const values: unknown[] = [];
        for (const draft of batch) {
          const base = values.length;
          rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, to_tsvector('${TSVECTOR_DICTIONARY}', $${base + 7}))`);
          values.push(cuid(), doc.id, doc.tenantId, draft.seq, draft.text, draft.charCount, draft.text);
        }
        await tx.$executeRawUnsafe(
          `INSERT INTO "KnowledgeChunk" (${columns.join(", ")}) VALUES ${rows.join(", ")} ON CONFLICT ("docId", "seq") DO NOTHING`,
          ...values,
        );
      }
    });

    await db.knowledgeDoc.update({
      where: { id: doc.id },
      data: { status: "INDEXED", chunkCount: drafts.length, error: null },
    });
    return { chunks: drafts.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The failure is written before it is thrown: a `FAILED` row with a reason is a
    // console that can say what happened, and the throw is what requeues or kills.
    await db.knowledgeDoc
      .update({ where: { id: doc.id }, data: { status: "FAILED", error: message.slice(0, 2_000) } })
      .catch(() => undefined);
    throw error;
  }
}

/**
 * The document's MIME picks the splitter; a wrong guess only costs boundaries, since
 * `chunkDocument` also probes for headings inside whatever it is given.
 */
function formatFor(mime: string): ChunkFormat {
  if (mime === "text/markdown") return "markdown";
  if (mime === "text/csv") return "rows";
  return "plain";
}

/** Prisma's cuid is a client-side generator; a uuid is the same thing without the import. */
function cuid(): string {
  return globalThis.crypto.randomUUID();
}
