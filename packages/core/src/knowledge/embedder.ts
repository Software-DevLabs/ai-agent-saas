import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * The embedding half of the knowledge lane.
 *
 * It is a separate lane and a separate function from `indexDocument` on purpose.
 * Indexing is what makes a document *findable*; embedding is what makes it
 * findable by meaning. A daemon with no embedding model pulled must not stop a
 * document from being indexed — the keyword index is the shipping retrieval path
 * — so the failure mode here is "the vectors are missing and the console says so",
 * never "the upload failed".
 *
 * Vectors are written to `KnowledgeChunkEmbedding`, keyed by `(chunkId, model)`, so
 * re-embedding under a new model adds rows rather than overwriting the old space.
 * Nothing in here writes a `UsageEvent`: Ollama does not bill embedding tokens, and
 * a ledger row would be a number nobody measured.
 */

/** Its own lane, so a slow embedding round never holds a reply behind it. */
export const EMBED_LANE = "knowledge.embed";

/** What the worker can give this function. `model` is the space the rows belong to. */
export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<{ vectors: number[][]; model: string; dim: number }>;
}

export interface EmbedOutcome {
  /** Chunks written this run. Zero means they were all already in this model's space. */
  embedded: number;
  /** Chunks the document has, embedding or not. */
  total: number;
  model: string;
  dim: number;
}

/** Small enough that one failed call loses little work, large enough not to chat per chunk. */
const EMBED_BATCH = 16;

interface ChunkRow {
  id: string;
  text: string;
}

interface DocRow {
  id: string;
  tenantId: string;
  status: string;
  meta: unknown;
}

export async function embedDocument(db: PrismaClient, docId: string, embedder: Embedder): Promise<EmbedOutcome> {
  const found = await db.$queryRaw<DocRow[]>`
    SELECT "id", "tenantId", "status", "meta" FROM "KnowledgeDoc" WHERE "id" = ${docId} LIMIT 1`;
  const doc = found[0];
  if (doc === undefined) throw new Error(`knowledge document ${docId} does not exist`);
  if (doc.status !== "INDEXED") {
    throw new Error(`knowledge document ${docId} is ${doc.status}; a document is embedded after its chunks exist`);
  }

  const chunks = await db.$queryRaw<ChunkRow[]>`
    SELECT "id", "text" FROM "KnowledgeChunk" WHERE "docId" = ${docId} ORDER BY "seq" ASC`;
  if (chunks.length === 0) throw new Error(`knowledge document ${docId} has no chunks to embed`);

  const done = await db.$queryRaw<{ chunkId: string }[]>`
    SELECT e."chunkId" FROM "KnowledgeChunkEmbedding" e
    JOIN "KnowledgeChunk" c ON c."id" = e."chunkId"
    WHERE c."docId" = ${docId} AND e."model" = ${embedder.model}`;
  const have = new Set(done.map((row) => row.chunkId));
  const pending = chunks.filter((chunk) => !have.has(chunk.id));

  let dim = await existingDim(db, docId, embedder.model);
  let embedded = 0;

  try {
    for (let at = 0; at < pending.length; at += EMBED_BATCH) {
      const batch = pending.slice(at, at + EMBED_BATCH);
      const result = await embedder.embed(batch.map((chunk) => chunk.text));
      if (result.vectors.length !== batch.length) {
        throw new Error(`the embedder returned ${result.vectors.length} vector(s) for ${batch.length} chunk(s)`);
      }
      dim = result.dim;
      await writeVectors(db, embedder.model, dim, batch, result.vectors);
      embedded += batch.length;
    }
  } catch (error) {
    // A failed round leaves the document INDEXED and says why in its meta: the
    // keyword index still works, and the console shows the semantic half as failed
    // rather than pretending either way.
    const message = error instanceof Error ? error.message : String(error);
    await db.knowledgeDoc
      .update({
        where: { id: docId },
        data: { meta: mergeMeta(doc.meta, { embeddingError: message.slice(0, 800), embeddingErrorAt: new Date().toISOString() }) },
      })
      .catch(() => undefined);
    throw error;
  }

  const meta = mergeMeta(doc.meta, {
    embedding: { model: embedder.model, dim, chunks: chunks.length, embedded, at: new Date().toISOString() },
    embeddingError: null,
  });
  await db.knowledgeDoc.update({ where: { id: docId }, data: { meta } });

  return { embedded, total: chunks.length, model: embedder.model, dim };
}

async function existingDim(db: PrismaClient, docId: string, model: string): Promise<number> {
  const rows = await db.$queryRaw<{ dim: number }[]>`
    SELECT e."dim" FROM "KnowledgeChunkEmbedding" e
    JOIN "KnowledgeChunk" c ON c."id" = e."chunkId"
    WHERE c."docId" = ${docId} AND e."model" = ${model}
    LIMIT 1`;
  return rows[0]?.dim ?? 0;
}

/**
 * One statement per batch, with the vector literal cast by Postgres.
 *
 * The cast is where the dimension becomes real: `$n::vector` of a 768-float text
 * literal is a 768-dimension vector, and a row of the wrong length would be
 * rejected here rather than at the comparison months later.
 */
async function writeVectors(
  db: PrismaClient,
  model: string,
  dim: number,
  batch: ChunkRow[],
  vectors: number[][],
): Promise<void> {
  const rows: string[] = [];
  const values: unknown[] = [];
  for (const [index, chunk] of batch.entries()) {
    const vector = vectors[index];
    if (vector === undefined || vector.length !== dim) {
      throw new Error(`the embedder returned a vector of ${vector?.length ?? 0} dimensions where ${dim} were expected`);
    }
    const base = values.length;
    rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::vector)`);
    values.push(chunk.id, model, dim, `[${vector.join(",")}]`);
  }
  await db.$executeRawUnsafe(
    `INSERT INTO "KnowledgeChunkEmbedding" ("chunkId", "model", "dim", "embedding")
     VALUES ${rows.join(", ")}
     ON CONFLICT ("chunkId", "model") DO UPDATE SET "dim" = EXCLUDED."dim", "embedding" = EXCLUDED."embedding"`,
    ...values,
  );
}

/** Meta is a small JSON bag; a write must not drop the keys another feature put there. */
function mergeMeta(meta: unknown, patch: Record<string, unknown>): Prisma.InputJsonValue {
  const base = typeof meta === "object" && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
  return { ...base, ...patch } as Prisma.InputJsonValue;
}
