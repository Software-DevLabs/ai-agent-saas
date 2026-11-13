import type { PrismaClient } from "@prisma/client";

/**
 * Keyword retrieval — the search that works with no embedding model installed.
 *
 * It is Postgres full-text search over `KnowledgeChunk.textTsv` and nothing else:
 * `websearch_to_tsquery` parses the operator's or the visitor's words, `@@` matches
 * them against the GIN index, `ts_rank` orders the result. No model is called, no
 * tokens are spent, and the answer is the same for the same words twice, which is
 * more than can be said for a semantic search over a daemon that may not be up.
 *
 * Two rules hold everywhere in this file:
 *
 * 1. **A scope of no documents is no results, not all results.** Every query carries
 *    the tenant clause and the document list the turn was assembled with. Forgetting
 *    either one is how a support agent reads another tenant's price list.
 * 2. **The engine that answered is part of the answer.** `backend` travels to the
 *    console and the widget, so nobody has to guess whether a miss was "the model
 *    found nothing" or "there is nothing to find yet".
 */

export type SearchBackend = "keyword" | "vector" | "none";

export interface SearchHit {
  chunkId: string;
  docId: string;
  seq: number;
  title: string;
  /** The chunk's own text, capped: this is what the model is handed back as an answer. */
  text: string;
  /** A window of `text` around the first matched word, for a person to read. */
  snippet: string;
  score: number;
  /** Only a crawled page has one, and only from the phase that crawls. */
  pageUrl?: string;
  backend: SearchBackend;
}

export interface SearchScope {
  tenantId: string;
  /** The documents this turn may read — from its capability assembly, never from a request body. */
  docIds: string[];
  limit?: number;
}

/** A query vector, tagged with the space it belongs to so a comparison never mixes two. */
export interface VectorQuery {
  vector: number[];
  model: string;
  dim: number;
}

/**
 * How a caller supplies the query embedding. It lives in the tool context rather
 * than being imported, because the provider that can embed is the entrypoint's
 * business — `core` only names the shape. `null` means "this build cannot embed
 * this turn", which degrades to keyword rather than failing.
 */
export type QueryEmbedder = (text: string) => Promise<VectorQuery | null>;

/**
 * Cosine similarity below which a passage is noise. A scan without a floor would
 * answer every question with *something*, which is exactly the behaviour the
 * `NO_MATCHES` contract exists to prevent. Measured against `nomic-embed-text`:
 * an unrelated sentence scores ~0.55, a real question about the chunk ~0.90, so
 * 0.6 is the lowest round value that keeps "no matches" truthful for this model;
 * a 0.3 floor let gibberish through as a hit.
 */
export const MIN_VECTOR_SIMILARITY = 0.6;

/** A tool result is a prompt cost like any other, so the chunk an agent sees is bounded. */
export const MAX_CHUNK_CHARS_RETURNED = 1_600;
export const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 12;

interface ChunkRow {
  chunkId: string;
  docId: string;
  seq: number;
  title: string;
  text: string;
  score: string | number;
}

/**
 * Full-text search over the indexed chunks of exactly the documents in scope.
 *
 * Written as one statement rather than a `findMany` because the ranking is
 * Postgres's job: `ts_rank` needs the tsquery, and the tsquery needs the index.
 * The document list is bound as an array parameter, never interpolated.
 */
export async function keywordSearch(
  db: PrismaClient,
  scope: SearchScope,
  query: string,
): Promise<SearchHit[]> {
  const wanted = scope.docIds.filter((id) => id !== "");
  const text = query.trim();
  if (wanted.length === 0 || text === "") return [];
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, scope.limit ?? DEFAULT_SEARCH_LIMIT));

  const rows = await db.$queryRaw<ChunkRow[]>`
    SELECT c."id" AS "chunkId",
           c."docId",
           c."seq",
           d."title",
           left(c."text", ${MAX_CHUNK_CHARS_RETURNED + 200}::int) AS "text",
           ts_rank(c."textTsv", websearch_to_tsquery('english', ${text})) AS "score"
    FROM "KnowledgeChunk" c
    JOIN "KnowledgeDoc" d ON d."id" = c."docId"
    WHERE c."tenantId" = ${scope.tenantId}
      AND c."docId" = ANY(${wanted}::text[])
      AND d."status" = 'INDEXED'
      AND c."textTsv" @@ websearch_to_tsquery('english', ${text})
    ORDER BY "score" DESC, c."docId" ASC, c."seq" ASC
    LIMIT ${limit}`;

  return rows.map((row) => ({
    chunkId: row.chunkId,
    docId: row.docId,
    seq: row.seq,
    title: row.title,
    text: row.text.slice(0, MAX_CHUNK_CHARS_RETURNED),
    snippet: snippetOf(row.text, text),
    score: typeof row.score === "number" ? row.score : Number(row.score),
    backend: "keyword" as const,
  }));
}

/**
 * Cosine retrieval over the side table, filtered to one model and one dimension.
 *
 * The vector literal is built here and bound as a parameter and cast with `::vector`:
 * Prisma cannot author a `vector` column, so interpolating the array as `real[]` and
 * casting is the one path that works both in a tagged template and against pgvector.
 * Rows of another model or another dimension are excluded by the `WHERE`, because a
 * distance between two vector spaces is a number Postgres will happily compute and
 * that no one should ever read.
 */
export async function vectorSearch(
  db: PrismaClient,
  scope: SearchScope,
  query: VectorQuery,
): Promise<SearchHit[]> {
  const wanted = scope.docIds.filter((id) => id !== "");
  if (wanted.length === 0 || !isVector(query.vector) || query.dim !== query.vector.length) return [];
  const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, scope.limit ?? DEFAULT_SEARCH_LIMIT));
  const literal = `[${query.vector.join(",")}]`;

  const rows = await db.$queryRaw<ChunkRow[]>`
    SELECT c."id" AS "chunkId",
           c."docId",
           c."seq",
           d."title",
           left(c."text", ${MAX_CHUNK_CHARS_RETURNED + 200}::int) AS "text",
           1 - (e."embedding" <=> ${literal}::vector) AS "score"
    FROM "KnowledgeChunkEmbedding" e
    JOIN "KnowledgeChunk" c ON c."id" = e."chunkId"
    JOIN "KnowledgeDoc" d ON d."id" = c."docId"
    WHERE c."tenantId" = ${scope.tenantId}
      AND c."docId" = ANY(${wanted}::text[])
      AND d."status" = 'INDEXED'
      AND e."model" = ${query.model}
      AND e."dim" = ${query.dim}
    ORDER BY e."embedding" <=> ${literal}::vector
    LIMIT ${limit}`;

  return rows
    .map((row) => ({
      chunkId: row.chunkId,
      docId: row.docId,
      seq: row.seq,
      title: row.title,
      text: row.text.slice(0, MAX_CHUNK_CHARS_RETURNED),
      snippet: snippetOf(row.text, ""),
      score: typeof row.score === "number" ? row.score : Number(row.score),
      backend: "vector" as const,
    }))
    .filter((hit) => Number.isFinite(hit.score) && hit.score >= MIN_VECTOR_SIMILARITY);
}

function isVector(values: number[]): boolean {
  return values.length > 0 && values.every((value) => typeof value === "number" && Number.isFinite(value));
}

/**
 * Where retrieval is going: vector first when a query embedding is available,
 * keyword as the fallback that is always there.
 *
 * `none` is reported as `none` rather than dressed up as a search that found
 * nothing: the console shows the backend, so "the embedder returned nothing above
 * the floor" and "there is no keyword match" stay tellable apart by which engine
 * answered — and by `hits.length === 0` when neither did.
 */
export async function searchKnowledge(
  db: PrismaClient,
  scope: SearchScope,
  query: string,
  vector?: VectorQuery,
): Promise<{ hits: SearchHit[]; backend: SearchBackend }> {
  if (vector !== undefined) {
    const semantic = await vectorSearch(db, scope, vector);
    if (semantic.length > 0) return { hits: semantic, backend: "vector" };
  }
  const hits = await keywordSearch(db, scope, query);
  return { hits, backend: hits.length > 0 ? "keyword" : "none" };
}

/**
 * A window of the chunk around the first word the query and the text share.
 *
 * Deliberately not `ts_headline`: the tool already returns the chunk, so an
 * excerpt costs nothing but a slice, and a plain slice survives a re-read by a
 * person who has no idea what a tsquery is. Falls back to the opening of the
 * chunk when the words do not match (which happens for stems Postgres chose
 * differently than the naive term scan below).
 */
export function snippetOf(text: string, query: string, radius = 220): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3);
  const lowered = clean.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lowered.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) return truncate(clean, radius);
  const from = Math.max(0, at - Math.floor(radius / 3));
  const to = Math.min(clean.length, from + radius);
  const excerpt = clean.slice(from, to).trim();
  return `${from > 0 ? "…" : ""}${truncate(excerpt, radius)}${to < clean.length ? "…" : ""}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
