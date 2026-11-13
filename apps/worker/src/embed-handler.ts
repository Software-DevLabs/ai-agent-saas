import type { PrismaClient } from "@prisma/client";
import {
  CLASSIFY_LANE,
  attemptDelay,
  createAgentRunObserver,
  describeError,
  embedChatId,
  prepareAgentTurn,
  runAgentTurn,
  type AgentAction,
  type AgentCitation,
  type QueryEmbedder,
  type Queue,
  type QueueJob,
  type RunnerFactory,
  type TurnRecord,
} from "@saas/core";
import { HttpError } from "@saas/shared";

/**
 * The public turn: a visitor asked the widget something, and this is the worker
 * half that answers it.
 *
 * It runs here, not in the API request, for the same reason a graph run does: a
 * model call is slow and the widget polls. The API wrote the `EmbedMessage` row
 * as PENDING before enqueuing, so the widget has a truth to poll from the first
 * millisecond — there is no state in which the browser waits on a turn with no
 * row behind it.
 *
 * What travels back to the widget is only what `projectEmbedMessage` allows:
 * the reply, buttons and sources recorded through the turn's `TurnRecord`. Token
 * counts, the prompt and the trace stay on the operator's side of the wall.
 */

export interface EmbedTurnDeps {
  db: PrismaClient;
  queue: Queue;
  job: QueueJob;
  workerId: string;
  runners: RunnerFactory;
  /** Null means this process cannot embed queries; retrieval is keyword-only. */
  embedQuery: QueryEmbedder | null;
  deadlineMs: number;
}

export interface EmbedTurnResult {
  outcome: "answered" | "failed" | "retried" | "rejected" | "skipped";
  jobId: string;
  messageId?: string;
  detail: string;
}

/**
 * The only error text a visitor ever reads. An internal message can name the
 * provider, the agent or the budget — none of that belongs on a public page, and
 * the operator can still see the true error on the run row and the queue row.
 */
function publicErrorText(error: unknown): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "agent_not_active":
        return "This assistant is not available right now.";
      case "quota_exhausted":
      case "agent_budget_exhausted":
        return "This assistant has reached its usage limit. Please try again later.";
      case "provider_failed":
        return "The assistant is temporarily unavailable. Please try again.";
      case "run_deadline":
        return "The assistant took too long to answer. Please try using a shorter question.";
      case "tool_step_limit":
        return "The assistant could not finish that request.";
      default:
        return "The assistant could not answer right now.";
    }
  }
  return "The assistant could not answer right now.";
}

/** Anything a second attempt could plausibly fix. Configuration errors cannot be. */
function retryable(error: unknown): boolean {
  if (!(error instanceof HttpError)) return true;
  return error.code === "provider_failed";
}

export async function handleEmbedTurnJob(deps: EmbedTurnDeps): Promise<EmbedTurnResult> {
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
      sessionId: true,
      question: true,
      status: true,
      embed: { select: { id: true, agentId: true, status: true } },
    },
  });
  if (message === null) {
    const detail = `message ${messageId} is not in this tenant`;
    await queue.dead(job.id, workerId, detail);
    return { outcome: "rejected", jobId: job.id, messageId, detail };
  }
  // A duplicate delivery of a turn that already answered must not answer twice.
  if (message.status === "ANSWERED") {
    await queue.succeed(job.id, workerId);
    return { outcome: "skipped", jobId: job.id, messageId, detail: "already answered" };
  }

  /**
   * Listening is queued in both terminal directions. A visitor whose question
   * failed still asked it, and the Insights page should be able to say how they
   * felt even when the answer went wrong — the classifier reads the stored
   * question and an absent answer. One classification per message, whatever the
   * number of deliveries.
   */
  const queueClassify = async (): Promise<boolean> => {
    try {
      await queue.enqueue({
        lane: CLASSIFY_LANE,
        tenantId: message.tenantId,
        source: "embed",
        externalMessageId: `${message.embed.id}:classify:${message.id}`,
        payload: { messageId: message.id },
        maxAttempts: 3,
      });
      return true;
    } catch {
      return false;
    }
  };

  const terminal = async (error: unknown, detail: string): Promise<EmbedTurnResult> => {
    await db.embedMessage.update({
      where: { id: message.id },
      data: { status: "FAILED", error: publicErrorText(error) },
    }).catch(() => undefined);
    await queueClassify();
    await queue.dead(job.id, workerId, detail);
    return { outcome: "failed", jobId: job.id, messageId, detail };
  };

  if (message.embed.status !== "ACTIVE") {
    return terminal(
      new HttpError(409, "embed_paused", "the widget is paused"),
      `widget ${message.embed.id} is ${message.embed.status}`,
    );
  }

  await db.embedMessage.update({ where: { id: message.id }, data: { status: "RUNNING" } });

  // Sources and buttons accumulate through the turn; the last write wins on a retry.
  let citations: AgentCitation[] = [];
  let actions: AgentAction[] = [];
  const record: TurnRecord = {
    citations(next) {
      citations = next;
    },
    actions(next) {
      actions = next;
    },
  };

  const store = createAgentRunObserver(db, message.tenantId);
  let agentRunId: string | null = null;

  try {
    const assembly = await prepareAgentTurn(db, message.tenantId, message.embed.agentId, {
      publicSurface: true,
      ...(deps.embedQuery === null ? {} : { embedQuery: deps.embedQuery }),
      record,
    });
    const turn = await runAgentTurn(
      db,
      message.tenantId,
      message.embed.agentId,
      {
        message: message.question,
        assembly,
        externalChatId: embedChatId(message.embed.id, message.sessionId),
        triggerSource: "embed",
        metadata: { origin: "embed", embedId: message.embed.id },
        requireActive: true,
        deadlineAt: Date.now() + deps.deadlineMs,
      },
      deps.runners,
      {
        ...store,
        start: async (info) => {
          agentRunId = await store.start(info);
          return agentRunId;
        },
      },
    );
    await db.embedMessage.update({
      where: { id: message.id },
      data: {
        status: "ANSWERED",
        answer: turn.reply,
        // Structurally plain JSON; Prisma's input type wants an index signature.
        actions: actions as unknown as object[],
        citations: citations as unknown as object[],
        answeredAt: new Date(),
        ...(agentRunId === null ? {} : { agentRunId }),
      },
    });
    await queue.succeed(job.id, workerId);
    // After the answer is durable, never before: the classifier reads the stored
    // reply. A failure to queue it does not fail the answer the visitor already
    // has — it is reported in this result instead.
    const classify = (await queueClassify()) ? "classify: queued" : "classify: enqueue failed";
    return {
      outcome: "answered",
      jobId: job.id,
      messageId,
      detail: `${turn.steps} round(s), ${turn.tokensUsed} token(s) · ${classify}`,
    };
  } catch (error) {
    const detail = describeError(error);
    if (retryable(error) && job.attempts < job.maxAttempts) {
      // The row stays RUNNING across the backoff: the turn has begun and its next
      // attempt resumes it, and the widget's poll timeout is the watchdog.
      await queue.retry(job.id, workerId, detail, attemptDelay(job.attempts));
      return { outcome: "retried", jobId: job.id, messageId, detail };
    }
    return terminal(error, detail);
  }
}

/**
 * The payload is JSON from a queue row, so it is checked rather than trusted.
 * A turn that names no message cannot answer one, and guessing an id from the
 * row would be answering something nobody asked.
 */
function payloadMessageId(job: QueueJob): string | null {
  const payload = job.payload as { messageId?: unknown } | null;
  const messageId = payload?.messageId;
  return typeof messageId === "string" && messageId !== "" ? messageId : null;
}
