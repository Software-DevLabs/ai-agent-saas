import type { PrismaClient } from "@prisma/client";
import {
  attemptDelay,
  describeError,
  EMBED_LANE,
  embedDocument,
  indexDocument,
  type Embedder,
  type Queue,
  type QueueJob,
} from "@saas/core";

/**
 * The knowledge lanes: make a document searchable, then make it searchable by meaning.
 *
 * Two lanes rather than one job because the two halves fail independently. A daemon
 * with no embedding model pulled must not stop a document from being indexed — the
 * keyword index is the shipping retrieval path — so `knowledge.index` settles first,
 * succeeds, and queues `knowledge.embed` behind it. The embed job's failure leaves
 * the document INDEXED and records why in its meta, where the console can show it,
 * instead of turning a working upload into a failed one.
 *
 * Retrying is deliberately simpler than the graph's policy. An index job has no
 * provider to be rude to and no money to overspend: the failure is either a database
 * hiccup, which a second attempt fixes, or the document itself, which never will —
 * and the row already says which, so the job goes dead rather than circling.
 */

export interface KnowledgeJobResult {
  outcome: "indexed" | "embedded" | "retried" | "dead" | "rejected";
  jobId: string;
  docId?: string;
  detail: string;
}

interface Deps {
  db: PrismaClient;
  queue: Queue;
  job: QueueJob;
  workerId: string;
}

interface EmbedDeps extends Deps {
  /** Null means this process cannot embed at all; the job is dead, not retried. */
  embedder: Embedder | null;
}

export async function handleKnowledgeJob({ db, queue, job, workerId }: Deps): Promise<KnowledgeJobResult> {
  const docId = payloadDocId(job);
  if (docId === null) {
    const detail = "the job payload has no document id";
    await queue.dead(job.id, workerId, detail);
    return { outcome: "rejected", jobId: job.id, detail };
  }

  try {
    const { chunks } = await indexDocument(db, docId);
    await queue.succeed(job.id, workerId);
    // The vector half is queued after the keyword half has committed: an embed job
    // that read chunks before they existed would just have to be retried.
    await queue.enqueue({
      lane: EMBED_LANE,
      tenantId: job.tenantId,
      source: "knowledge",
      externalMessageId: `${docId}:embed:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      payload: { docId },
      maxAttempts: 2,
    });
    return { outcome: "indexed", jobId: job.id, docId, detail: `${chunks} chunk(s) indexed` };
  } catch (error) {
    return settleFailure({ db, queue, job, workerId, docId }, error);
  }
}

export async function handleEmbedJob({ db, queue, job, workerId, embedder }: EmbedDeps): Promise<KnowledgeJobResult> {
  const docId = payloadDocId(job);
  if (docId === null) {
    const detail = "the job payload has no document id";
    await queue.dead(job.id, workerId, detail);
    return { outcome: "rejected", jobId: job.id, detail };
  }
  if (embedder === null) {
    const detail = "this worker has no embedding model configured (OLLAMA_EMBED_MODEL)";
    await queue.dead(job.id, workerId, detail);
    return { outcome: "dead", jobId: job.id, docId, detail };
  }

  try {
    const result = await embedDocument(db, docId, embedder);
    await queue.succeed(job.id, workerId);
    return {
      outcome: "embedded",
      jobId: job.id,
      docId,
      detail: `${result.embedded}/${result.total} chunk(s) embedded with ${result.model} (${result.dim}d)`,
    };
  } catch (error) {
    return settleFailure({ db, queue, job, workerId, docId }, error);
  }
}

async function settleFailure(
  deps: Pick<Deps, "db" | "queue" | "job" | "workerId"> & { docId: string },
  error: unknown,
): Promise<KnowledgeJobResult> {
  const { queue, job, workerId, docId } = deps;
  const detail = describeError(error);
  if (job.attempts >= job.maxAttempts) {
    await queue.dead(job.id, workerId, detail);
    return { outcome: "dead", jobId: job.id, docId, detail };
  }
  await queue.retry(job.id, workerId, detail, attemptDelay(job.attempts));
  return { outcome: "retried", jobId: job.id, docId, detail };
}

/**
 * The payload is JSON from a queue row, so it is checked rather than trusted. A job
 * that names no document cannot be indexed, and guessing an id from the row would be
 * indexing something nobody asked for.
 */
function payloadDocId(job: QueueJob): string | null {
  const payload = job.payload as { docId?: unknown } | null;
  const docId = payload?.docId;
  return typeof docId === "string" && docId !== "" ? docId : null;
}
