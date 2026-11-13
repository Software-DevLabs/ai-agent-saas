import { Prisma, type PrismaClient } from "@prisma/client";
import { describeError } from "./queue-policy.ts";
import type { NewJob, Queue, QueueCounts, QueueJob } from "./queue.ts";

/**
 * Postgres as the queue: no Redis, no second service, no second source of truth
 * about what a message cost.
 *
 * The claim is ONE statement — `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP
 * LOCKED LIMIT 1) RETURNING …` — so the row lock is held for microseconds and
 * never across a model call. `FOR UPDATE SKIP LOCKED` is what lets two workers
 * poll the same table without either waiting on the other or taking the same
 * job, and it holds no session state, which is what makes it safe behind Neon's
 * transaction-mode pooler.
 *
 * This file is the only one allowed to touch the lease columns of
 * `WebhookEventLog` (docs/decisions.md D7). The dual role — idempotency log and
 * mutable lease — holds because the KEY `(source, externalMessageId)` is never
 * re-keyed and only state mutates. If that ever rots, a dedicated `QueueJob`
 * table is a one-file swap behind the `Queue` interface.
 */

interface JobRow {
  id: string;
  tenantId: string | null;
  source: string;
  externalMessageId: string;
  payload: unknown;
  workflowId: string | null;
  runId: string | null;
  attempts: number;
  maxAttempts: number;
}

const jobColumns = Prisma.sql`
  job.id, job."tenantId", job."source", job."externalMessageId", job."payload",
  job."workflowId", job."runId", job."attempts", job."maxAttempts"`;

const lease = (ms: number) => Prisma.sql`${ms}::bigint * interval '1 millisecond'`;

export class PgQueue implements Queue {
  constructor(private readonly db: PrismaClient) {}

  async enqueue(job: NewJob): Promise<{ id: string; duplicate: boolean }> {
    try {
      const row = await this.db.webhookEventLog.create({
        data: {
          tenantId: job.tenantId,
          source: job.source,
          externalMessageId: job.externalMessageId,
          status: "QUEUED",
          lane: job.lane,
          payload: job.payload as Prisma.InputJsonValue | undefined,
          workflowId: job.workflowId,
          runId: job.runId,
          maxAttempts: job.maxAttempts,
        },
        select: { id: true },
      });
      return { id: row.id, duplicate: false };
    } catch (error) {
      // The unique key is the whole idempotency story: whoever holds the row
      // first owns the delivery. The loser returns that row and queues nothing.
      if ((error as { code?: string }).code === "P2002") {
        const holder = await this.db.webhookEventLog.findUnique({
          where: { source_externalMessageId: { source: job.source, externalMessageId: job.externalMessageId } },
          select: { id: true },
        });
        if (holder) return { id: holder.id, duplicate: true };
      }
      throw error;
    }
  }

  async claim(lane: string, workerId: string, leaseMs: number): Promise<QueueJob | null> {
    const rows = await this.db.$queryRaw<JobRow[]>(Prisma.sql`
      UPDATE "WebhookEventLog" AS job
         SET "attempts" = job."attempts" + 1,
             "lockedAt" = now(),
             "lockedBy" = ${workerId},
             "lockedUntil" = now() + ${lease(leaseMs)},
             "status" = 'QUEUED'::"WebhookStatus"
       WHERE job.id = (
         SELECT candidate.id
           FROM "WebhookEventLog" AS candidate
          WHERE candidate."lane" = ${lane}
            AND candidate."status" IN ('QUEUED'::"WebhookStatus", 'FAILED'::"WebhookStatus")
            AND (candidate."lockedUntil" IS NULL OR candidate."lockedUntil" <= now())
          ORDER BY candidate."receivedAt"
             FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       RETURNING ${jobColumns}`);
    const row = rows[0];
    return row === undefined ? null : toJob(row, lane);
  }

  async heartbeat(id: string, workerId: string, leaseMs: number): Promise<boolean> {
    // The `lockedBy` test is the whole protocol: a row this worker no longer
    // owns cannot be extended by it, so a stalled process cannot keep a live
    // replacement from finishing the job.
    const kept = await this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE "WebhookEventLog"
         SET "lockedUntil" = now() + ${lease(leaseMs)}
       WHERE id = ${id} AND "lockedBy" = ${workerId} AND "lockedUntil" > now()
       RETURNING id`;
    return kept.length > 0;
  }

  async attachRun(id: string, workerId: string, runId: string, workflowId: string): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "WebhookEventLog"
         SET "runId" = ${runId},
             "workflowId" = ${workflowId}
       WHERE id = ${id} AND "lockedBy" = ${workerId}`;
  }

  async succeed(id: string, workerId: string): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "WebhookEventLog"
         SET "status" = 'PROCESSED'::"WebhookStatus",
             "processedAt" = now(),
             "lastError" = NULL,
             "lockedBy" = NULL,
             "lockedUntil" = NULL
       WHERE id = ${id} AND "lockedBy" = ${workerId}`;
  }

  async retry(id: string, workerId: string, error: string, delayMs: number): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "WebhookEventLog"
         SET "status" = 'FAILED'::"WebhookStatus",
             "lastError" = ${describeError(error)},
             "lockedBy" = NULL,
             -- The backoff is the lock: invisible to claim until this passes.
             "lockedUntil" = now() + ${lease(delayMs)}
       WHERE id = ${id} AND "lockedBy" = ${workerId}`;
  }

  async dead(id: string, workerId: string, error: string): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "WebhookEventLog"
         SET "status" = 'DEAD'::"WebhookStatus",
             "lastError" = ${describeError(error)},
             "lockedBy" = NULL,
             "lockedUntil" = NULL
       WHERE id = ${id} AND "lockedBy" = ${workerId}`;
  }

  async release(id: string, workerId: string): Promise<void> {
    // A shutdown is not a failure: the attempt this process spent is given back,
    // or three restarts would silently burn a job's whole retry budget.
    await this.db.$executeRaw`
      UPDATE "WebhookEventLog"
         SET "attempts" = GREATEST("attempts" - 1, 0),
             "lockedBy" = NULL,
             "lockedUntil" = NULL
       WHERE id = ${id} AND "lockedBy" = ${workerId}`;
  }

  async counts(lane: string): Promise<QueueCounts> {
    const [row] = await this.db.$queryRaw<Array<QueueCounts>>`
      SELECT
        COUNT(*) FILTER (WHERE "status" = 'QUEUED'::"WebhookStatus" AND ("lockedUntil" IS NULL OR "lockedUntil" <= now()))::int AS queued,
        COUNT(*) FILTER (WHERE "lockedUntil" > now())::int AS claimed,
        COUNT(*) FILTER (WHERE "status" = 'FAILED'::"WebhookStatus")::int AS failed,
        COUNT(*) FILTER (WHERE "status" = 'DEAD'::"WebhookStatus")::int AS dead
      FROM "WebhookEventLog"
      WHERE "lane" = ${lane}`;
    return row ?? { queued: 0, claimed: 0, failed: 0, dead: 0 };
  }
}

function toJob(row: JobRow, lane: string): QueueJob {
  return {
    id: row.id,
    tenantId: row.tenantId,
    lane,
    source: row.source,
    externalMessageId: row.externalMessageId,
    payload: row.payload,
    workflowId: row.workflowId,
    runId: row.runId,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
  };
}
