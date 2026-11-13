import type { PrismaClient } from "@prisma/client";
import {
  attemptDelay,
  classifySentiment,
  describeError,
  type Queue,
  type QueueJob,
  type RunnerFactory,
  type Sentiment,
} from "@saas/core";
import { HttpError } from "@saas/shared";

/**
 * The listener: one public question in, one labelled `EmbedFeedback` row out.
 *
 * It is a lane of its own because a classification is a second model call that a
 * visitor must never wait on — the answer was already delivered by `embed.turn`.
 * The row is written once per message (`messageId` is unique), and it records the
 * model that judged it and the tokens the judgement cost, because a number on the
 * Insights page that cannot be traced back to a call is not evidence.
 *
 * Failure policy: a provider error is retried twice, then recorded honestly as
 * UNKNOWN with `source: "provider_failed"` and the reason. A message that was
 * never answered is still classified on the question alone — the visitor's tone
 * does not depend on whether we managed to reply.
 */

export interface ClassifyDeps {
  db: PrismaClient;
  queue: Queue;
  job: QueueJob;
  workerId: string;
  runners: RunnerFactory;
}

export interface ClassifyJobResult {
  outcome: "classified" | "unknown" | "failed" | "retried" | "rejected" | "skipped";
  jobId: string;
  messageId?: string;
  detail: string;
}

function payloadMessageId(job: QueueJob): string | null {
  const payload = job.payload as { messageId?: unknown } | null;
  const messageId = payload?.messageId;
  return typeof messageId === "string" && messageId !== "" ? messageId : null;
}

function retryable(error: unknown): boolean {
  return !(error instanceof HttpError) || error.code === "provider_failed";
}

export async function handleClassifyJob(deps: ClassifyDeps): Promise<ClassifyJobResult> {
  const { db, queue, job, workerId } = deps;
  const messageId = payloadMessageId(job);
  if (messageId === null) {
    const detail = "the job payload has no messageId";
    await queue.dead(job.id, workerId, detail);
    return { outcome: "rejected", jobId: job.id, detail };
  }

  const message = await db.embedMessage.findFirst({
    where: { AND: [{ id: messageId }, { tenantId: job.tenantId ?? "__none__" }] },
    select: {
      id: true,
      tenantId: true,
      embedId: true,
      question: true,
      answer: true,
      status: true,
      embed: { select: { id: true, agentId: true } },
    },
  });
  if (message === null) {
    const detail = `message ${messageId} is not in this tenant`;
    await queue.dead(job.id, workerId, detail);
    return { outcome: "rejected", jobId: job.id, messageId, detail };
  }

  // A duplicate delivery must not overwrite a label the operator has already read.
  const existing = await db.embedFeedback.findFirst({
    where: { AND: [{ tenantId: message.tenantId }, { messageId: message.id }] },
    select: { id: true },
  });
  if (existing !== null) {
    await queue.succeed(job.id, workerId);
    return { outcome: "skipped", jobId: job.id, messageId, detail: "already classified" };
  }

  if (message.status !== "ANSWERED" && message.status !== "FAILED") {
    const detail = `message ${message.id} is ${message.status}, not answered — nothing to judge yet`;
    await queue.dead(job.id, workerId, detail);
    return { outcome: "rejected", jobId: job.id, messageId, detail };
  }

  const agent = await db.agent.findFirst({
    where: { AND: [{ id: message.embed.agentId }, { tenantId: message.tenantId }] },
    select: { id: true, modelProvider: true, modelName: true },
  });
  if (agent === null) {
    const detail = `agent ${message.embed.agentId} is not in this tenant`;
    await queue.dead(job.id, workerId, detail);
    return { outcome: "rejected", jobId: job.id, messageId, detail };
  }

  /**
   * The label row and its ledger row are one write: a classification that is
   * shown on a page must also be on the ledger, and a ledger row must have the
   * feedback row it paid for. Re-delivery trips the unique key and is a skip.
   */
  const write = async (input: {
    sentiment: Sentiment;
    score: number | null;
    source: string;
    model: string | null;
    error: string | null;
    tokensUsed: number;
    inputTokens?: number;
    outputTokens?: number;
    provider?: string;
  }): Promise<"written" | "duplicate"> => {
    try {
      await db.$transaction(async (tx) => {
        await tx.embedFeedback.create({
          data: {
            tenantId: message.tenantId,
            embedId: message.embedId,
            messageId: message.id,
            question: message.question,
            answer: message.answer,
            sentiment: input.sentiment,
            score: input.score,
            source: input.source,
            model: input.model,
            error: input.error,
            tokensUsed: input.tokensUsed,
          },
        });
        if (input.tokensUsed <= 0) return;
        await tx.usageEvent.create({
          data: {
            tenantId: message.tenantId,
            agentId: agent.id,
            kind: "CLASSIFY",
            tokensUsed: input.tokensUsed,
            costUsdEstimate: 0,
            metadata: {
              provider: input.provider ?? agent.modelProvider,
              model: input.model ?? agent.modelName,
              inputTokens: input.inputTokens ?? 0,
              outputTokens: input.outputTokens ?? 0,
              sentiment: input.sentiment,
              source: input.source,
              embedId: message.embedId,
              messageId: message.id,
              role: "classify",
              origin: "embed",
            },
          },
        });
        await tx.tenant.update({
          where: { id: message.tenantId },
          data: { tokenBalance: { decrement: BigInt(input.tokensUsed) } },
        });
      });
      return "written";
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") return "duplicate";
      throw error;
    }
  };

  // A tenant with nothing in the balance cannot pay for an automatic call. That
  // is recorded as its own reason rather than as "the model said nothing".
  const tenant = await db.tenant.findFirst({
    where: { id: message.tenantId },
    select: { tokenBalance: true },
  });
  if (tenant === null) {
    const detail = `tenant ${message.tenantId} is gone`;
    await queue.dead(job.id, workerId, detail);
    return { outcome: "rejected", jobId: job.id, messageId, detail };
  }
  if (tenant.tokenBalance <= 0n) {
    const written = await write({
      sentiment: "UNKNOWN",
      score: null,
      source: "balance_exhausted",
      model: null,
      error: "the tenant has no token balance; the question was not classified",
      tokensUsed: 0,
    });
    await queue.succeed(job.id, workerId);
    return {
      outcome: written === "duplicate" ? "skipped" : "unknown",
      jobId: job.id,
      messageId,
      detail: "no balance — recorded UNKNOWN without a model call",
    };
  }

  const runner = deps.runners({ provider: agent.modelProvider, model: agent.modelName });
  let result;
  try {
    result = await classifySentiment(runner, { question: message.question });
  } catch (error) {
    const detail = describeError(error);
    if (retryable(error) && job.attempts < job.maxAttempts) {
      await queue.retry(job.id, workerId, detail, attemptDelay(job.attempts));
      return { outcome: "retried", jobId: job.id, messageId, detail };
    }
    const written = await write({
      sentiment: "UNKNOWN",
      score: null,
      source: "provider_failed",
      model: agent.modelName,
      error: detail.slice(0, 500),
      tokensUsed: 0,
    });
    await queue.dead(job.id, workerId, detail);
    return {
      outcome: written === "duplicate" ? "skipped" : "failed",
      jobId: job.id,
      messageId,
      detail,
    };
  }

  const written = await write({
    sentiment: result.sentiment,
    score: result.score,
    source: result.source,
    model: result.model,
    error: result.reason,
    tokensUsed: result.tokensUsed,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    provider: result.provider,
  });
  await queue.succeed(job.id, workerId);
  return {
    outcome: written === "duplicate" ? "skipped" : result.source === "model" ? "classified" : "unknown",
    jobId: job.id,
    messageId,
    detail: result.source === "model"
      ? `${result.sentiment}${result.score === null ? "" : ` (${result.score})`}, ${result.tokensUsed} token(s)`
      : `UNKNOWN: ${result.reason ?? "unreadable reply"} — ${result.tokensUsed} token(s) billed`,
  };
}
