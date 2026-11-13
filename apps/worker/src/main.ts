import { randomUUID } from "node:crypto";
import {
  CLASSIFY_LANE,
  EMBED_LANE,
  EMBED_TURN_LANE,
  GRAPH_LANE,
  KNOWLEDGE_LANE,
  PgQueue,
  SITE_CRAWL_LANE,
  executeGraph,
  type Embedder,
  type QueryEmbedder,
  type QueueJob,
  type RunnerFactory,
} from "@saas/core";
import { makeDb } from "@saas/db";
import { resolveProvider } from "@saas/providers";
import { Keyring, createLogger, loadConfigFromEnv } from "@saas/shared";
import { handleEmbedJob, handleKnowledgeJob } from "./knowledge-handler.ts";
import { handleEmbedTurnJob } from "./embed-handler.ts";
import { handleSiteCrawlJob } from "./site-handler.ts";
import { handleClassifyJob } from "./classify-handler.ts";

/**
 * The worker: claim a job, run the graph, write nothing it did not do.
 *
 * It is a separate process because a model call is slow and a webhook is not
 * allowed to wait for one (docs/plan-architecture.md invariant 1). Everything
 * about the queue itself — the claim, the lease, the backoff — lives in
 * `@saas/core`, so this file is only the loop, the wiring and the shutdown.
 *
 * It pumps six lanes. `graph.run` answers people; `knowledge.index` turns files into
 * rows; `knowledge.embed` gives those rows a vector; `embed.turn` answers the public
 * widget; `site.crawl` fills the routing table; `feedback.classify` reads how the
 * visitor felt after the answer is durable. A 300-page document must not hold a
 * reply behind it, and a classification must not hold the next public answer — a
 * claim is per lane and neither waits on the other.
 */

const LANES = [GRAPH_LANE, KNOWLEDGE_LANE, EMBED_LANE, EMBED_TURN_LANE, SITE_CRAWL_LANE, CLASSIFY_LANE] as const;

const config = loadConfigFromEnv();
const log = createLogger(config);
const db = makeDb(config);
const queue = new PgQueue(db);
const keyring = Keyring.fromEnv(config);

/** Named per process so two workers on one host cannot claim each other's lease. */
const workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

const providerConfig = {
  ollamaBaseUrl: config.OLLAMA_BASE_URL,
  ollamaModel: config.OLLAMA_MODEL,
  ollamaTimeoutMs: config.OLLAMA_TIMEOUT_MS,
  ollamaEmbedModel: config.OLLAMA_EMBED_MODEL,
};

const runners: RunnerFactory = (selection) =>
  resolveProvider(selection.provider, {
    config: { ...providerConfig, ollamaModel: selection.model },
  });

/**
 * The document embedder and the query embedder share one adapter because they share
 * one model: an index written by one model must never be searched by another, and
 * naming it once makes that mismatch impossible in this process.
 */
const embedder: Embedder = {
  model: config.OLLAMA_EMBED_MODEL,
  embed: async (texts) => {
    const provider = resolveProvider("ollama", { config: providerConfig });
    if (provider.embed === undefined) throw new Error("the ollama adapter has no embedding endpoint");
    return provider.embed(texts);
  },
};

const queryEmbedder: QueryEmbedder = async (text) => {
  const provider = resolveProvider("ollama", { config: providerConfig });
  if (provider.embed === undefined) return null;
  const result = await provider.embed([text]);
  const vector = result.vectors[0];
  return vector === undefined ? null : { vector, model: result.model, dim: result.dim };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// A beat the API has already forgotten is a worker that is not running as far as
// the console can know: the interval has to land at least twice inside
// WORKER_STALE_MS, not merely stay inside the lease.
const heartbeatMs = Math.min(
  Math.max(1_000, Math.floor(config.WORKER_LEASE_MS / 3)),
  Math.floor(config.WORKER_STALE_MS / 2),
);

/**
 * "I am here, and I wrote this at this moment."
 *
 * The API refuses to activate a graph while no such row is younger than
 * WORKER_STALE_MS, so this beat is not decoration — it is the only evidence the
 * console has that saying "active" is true. A worker that stops beating makes the
 * console stop promising, on its own, with nothing to remember.
 */
async function beat(): Promise<void> {
  await db.workerHeartbeat
    .upsert({
      where: { workerId },
      update: { lastSeenAt: new Date() },
      // The row is per process, not per lane, so it names every lane this worker
      // pumps: a console that says "alive" has to be able to say what it is alive for.
      create: { workerId, lane: LANES.join(","), lastSeenAt: new Date() },
    })
    .catch((error: unknown) => log.warn({ workerId, error: String(error) }, "heartbeat write failed"));
}

await beat();
const beatTimer = setInterval(() => void beat(), heartbeatMs);
beatTimer.unref?.();

let stopping = false;

async function runGraph(job: QueueJob): Promise<void> {
  try {
    const result = await executeGraph({
      db,
      queue,
      keyring,
      job,
      workerId,
      leaseMs: config.WORKER_LEASE_MS,
      heartbeatMs,
      deadlineMs: config.WORKFLOW_RUN_DEADLINE_MS,
      runners,
      maxToolSteps: config.AGENT_MAX_TOOL_STEPS,
      maxSubagentCalls: config.ORCHESTRATOR_MAX_SUBAGENT_CALLS,
      embedQuery: queryEmbedder,
    });
    log.info({ workerId, jobId: job.id, ...result }, "graph run finished");
  } catch (error) {
    // `executeGraph` classifies and settles its own failures. Anything reaching
    // here is this process falling over, so the lease goes back untouched and the
    // attempt is not charged against the job's budget.
    log.error({ workerId, jobId: job.id, error: error instanceof Error ? error.message : String(error) }, "worker fault");
    await queue.release(job.id, workerId).catch(() => undefined);
  }
}

async function runIndex(job: QueueJob): Promise<void> {
  try {
    const result = await handleKnowledgeJob({ db, queue, job, workerId });
    log.info({ workerId, ...result }, "knowledge job settled");
  } catch (error) {
    log.error({ workerId, jobId: job.id, error: error instanceof Error ? error.message : String(error) }, "indexer fault");
    await queue.release(job.id, workerId).catch(() => undefined);
  }
}

async function runEmbed(job: QueueJob): Promise<void> {
  try {
    const result = await handleEmbedJob({ db, queue, job, workerId, embedder });
    log.info({ workerId, ...result }, "embed job settled");
  } catch (error) {
    log.error({ workerId, jobId: job.id, error: error instanceof Error ? error.message : String(error) }, "embedder fault");
    await queue.release(job.id, workerId).catch(() => undefined);
  }
}

/**
 * A public widget turn. It runs with the same assembler and the same turn loop as
 * the console, so what a visitor is told is produced by exactly what the operator
 * tested in the Playground — the difference is only what is allowed back out.
 */
async function runEmbedTurn(job: QueueJob): Promise<void> {
  try {
    const result = await handleEmbedTurnJob({
      db,
      queue,
      job,
      workerId,
      runners,
      embedQuery: queryEmbedder,
      deadlineMs: config.EMBED_TURN_DEADLINE_MS,
    });
    log.info({ workerId, ...result }, "embed turn settled");
  } catch (error) {
    log.error({ workerId, jobId: job.id, error: error instanceof Error ? error.message : String(error) }, "embed turn fault");
    await queue.release(job.id, workerId).catch(() => undefined);
  }
}

/**
 * A crawl. The guard settings travel with the job rather than being read here, so
 * this process is not the place that decides whether private addresses are allowed
 * — the config is, and it says so once at boot.
 */
async function runCrawl(job: QueueJob): Promise<void> {
  try {
    const result = await handleSiteCrawlJob({
      db,
      queue,
      job,
      workerId,
      settings: {
        allowPrivate: config.SITE_ALLOW_PRIVATE_IPS === "1",
        timeoutMs: config.SITE_CRAWL_TIMEOUT_MS,
        maxPages: config.SITE_CRAWL_MAX_PAGES,
        maxDepth: config.SITE_CRAWL_MAX_DEPTH,
      },
    });
    log.info({ workerId, ...result }, "site crawl settled");
  } catch (error) {
    log.error({ workerId, jobId: job.id, error: error instanceof Error ? error.message : String(error) }, "crawler fault");
    await queue.release(job.id, workerId).catch(() => undefined);
  }
}

/**
 * Sentiment, after the answer is on the row. Its own lane so a second model call
 * per question is never ahead of the next visitor's answer in the queue.
 */
async function runClassify(job: QueueJob): Promise<void> {
  try {
    const result = await handleClassifyJob({ db, queue, job, workerId, runners });
    log.info({ workerId, ...result }, "classify job settled");
  } catch (error) {
    log.error({ workerId, jobId: job.id, error: error instanceof Error ? error.message : String(error) }, "classifier fault");
    await queue.release(job.id, workerId).catch(() => undefined);
  }
}

/**
 * One entry per lane, each with its own in-flight set. The sets are separate because
 * the concurrency budget is per lane: ten indexing jobs already claimed must not make
 * this process stop claiming replies, and a lane is only ever polled by its own loop.
 */
const lanes = [
  { lane: GRAPH_LANE, onJob: runGraph, inFlight: new Set<Promise<void>>() },
  { lane: KNOWLEDGE_LANE, onJob: runIndex, inFlight: new Set<Promise<void>>() },
  { lane: EMBED_LANE, onJob: runEmbed, inFlight: new Set<Promise<void>>() },
  { lane: EMBED_TURN_LANE, onJob: runEmbedTurn, inFlight: new Set<Promise<void>>() },
  { lane: SITE_CRAWL_LANE, onJob: runCrawl, inFlight: new Set<Promise<void>>() },
  { lane: CLASSIFY_LANE, onJob: runClassify, inFlight: new Set<Promise<void>>() },
];

async function pump(lane: string, onJob: (job: QueueJob) => Promise<void>, inFlight: Set<Promise<void>>): Promise<void> {
  for (;;) {
    if (stopping) return;
    if (inFlight.size >= config.WORKER_CONCURRENCY) {
      await Promise.race(inFlight);
      continue;
    }
    const job = await queue.claim(lane, workerId, config.WORKER_LEASE_MS);
    if (job === null) {
      await sleep(config.WORKER_POLL_MS);
      continue;
    }
    log.info({ workerId, lane, jobId: job.id, attempts: job.attempts }, "job claimed");
    const task: Promise<void> = onJob(job).finally(() => {
      inFlight.delete(task);
    });
    inFlight.add(task);
  }
}

const counts = Object.fromEntries(await Promise.all(lanes.map(async ({ lane }) => [lane, await queue.counts(lane)])));
log.info({ workerId, concurrency: config.WORKER_CONCURRENCY, leaseMs: config.WORKER_LEASE_MS, counts }, "worker running");

const loops = Promise.all(
  lanes.map(({ lane, onJob, inFlight }) =>
    pump(lane, onJob, inFlight).catch((error: unknown) => {
      log.error({ workerId, lane, error: error instanceof Error ? error.message : String(error) }, "worker loop died");
      process.exitCode = 1;
      stopping = true;
    }),
  ),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const busy = lanes.reduce((total, entry) => total + entry.inFlight.size, 0);
    log.info({ workerId, inFlight: busy }, "worker stopping — finishing claimed jobs");
    // A job interrupted mid-run is not a failure: the lease is given back and the
    // next worker resumes from the nodes that already succeeded.
    void Promise.allSettled(lanes.flatMap((entry) => [...entry.inFlight]))
      .then(async () => {
        await loops;
        // Take the row out rather than let it age: the console then reads "no
        // worker" at once instead of believing this process for another stale window.
        await db.workerHeartbeat.delete({ where: { workerId } }).catch(() => undefined);
        clearInterval(beatTimer);
        await db.$disconnect();
        process.exit(0);
      });
  });
}
