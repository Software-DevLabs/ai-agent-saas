import type { PrismaClient } from "@prisma/client";
import type { AgentTurnObserver } from "./agent-run.ts";

/**
 * The activity side of an agent turn: the observer `@saas/core` calls while it
 * bills each model round and executes each tool. It lives in core rather than in
 * one entrypoint because the console and the worker's embed lane must write the
 * same rows — a widget turn that never appears on the Runs page is a turn nobody
 * can audit, and two copies of this file would drift.
 *
 * Every callback runs inside core's `bestEffort`, so a failure here is dropped
 * rather than rolled back — a feed that lags the ledger is acceptable, a ledger
 * that loses a paid round because its activity write failed is not.
 */

const ERROR_CHARS = 2_000;

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= ERROR_CHARS ? text : `${text.slice(0, ERROR_CHARS - 1)}…`;
}

export function createAgentRunObserver(db: PrismaClient, tenantId: string): AgentTurnObserver {
  return {
    async start(info) {
      const run = await db.agentRun.create({
        data: {
          tenantId,
          projectId: info.agent.projectId,
          agentId: info.agent.id,
          agentName: info.agent.name,
          triggerSource: info.triggerSource,
          status: "RUNNING",
          conversationId: info.conversationId,
          externalChatId: info.externalChatId,
          input: info.input,
          deadlineAt: info.deadlineAt === undefined ? null : new Date(info.deadlineAt),
          // The capability set this turn actually ran with. Stored on the row
          // rather than read from the agent, because the agent may change and
          // this run may not: a replay has to see the catalogue the model saw.
          capability: info.capability === undefined ? undefined : (info.capability as object),
          capabilityHash: info.capabilityHash,
        },
        select: { id: true },
      });
      return run.id;
    },

    async round(runId, info) {
      await db.$transaction([
        db.agentRun.update({
          where: { id: runId, tenantId },
          data: {
            stepCount: { increment: 1 },
            tokensUsed: { increment: info.inputTokens + info.outputTokens },
          },
        }),
        db.agentRunStep.create({
          data: {
            runId,
            seq: info.seq,
            round: info.round,
            kind: "MODEL",
            inputTokens: info.inputTokens,
            outputTokens: info.outputTokens,
            durationMs: info.durationMs,
          },
        }),
      ]);
    },

    async stepDone(runId, info) {
      await db.$transaction([
        db.agentRun.update({
          where: { id: runId, tenantId },
          data: { toolCallCount: { increment: 1 } },
        }),
        db.agentRunStep.create({
          data: {
            runId,
            seq: info.seq,
            round: info.round,
            kind: "TOOL",
            tool: info.tool,
            argsPreview: info.argsPreview,
            resultPreview: info.resultPreview,
            ok: info.ok,
            durationMs: info.durationMs,
          },
        }),
      ]);
    },

    async finish(runId, outcome) {
      // Absolute values here, not increments: the turn is over and the outcome
      // is the source of truth for the closing row.
      await db.agentRun.update({
        where: { id: runId, tenantId },
        data: {
          status: "SUCCEEDED",
          output: outcome.reply,
          tokensUsed: outcome.tokensUsed,
          stepCount: outcome.steps,
          durationMs: outcome.durationMs,
          finishedAt: new Date(),
        },
      });
    },

    async fail(runId, error, partial) {
      await db.agentRun.update({
        where: { id: runId, tenantId },
        data: {
          status: "FAILED",
          error: errorText(error),
          tokensUsed: partial.tokensUsed,
          stepCount: partial.steps,
          durationMs: partial.durationMs,
          finishedAt: new Date(),
        },
      });
    },
  };
}
