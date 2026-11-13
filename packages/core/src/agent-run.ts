import type { PrismaClient } from "@prisma/client";
import { HttpError, badRequest, conflict, notFound, withRetry } from "@saas/shared";
import type { TurnAssembly } from "./capability/assemble.ts";

/**
 * The one canonical agent turn: provider call, ledger row, balance decrement and
 * thread write, in that order and in one transaction.
 *
 * Both the console (`POST /agents/:id/run`, the playground) and the workflow
 * worker go through here, so a graph run and a playground message cannot drift
 * into two different ideas of what a run costs. Nothing in this file is
 * simulated: the reply is the model's, the token counts are the provider's own
 * usage payload, and a run that did not happen writes nothing.
 *
 * `core` deliberately does not import `resolveProvider`. It names the shape it
 * needs and lets each entrypoint build it — core orchestrates, adapters are dumb.
 *
 * A turn is a loop of model rounds. Each completed round is one billed
 * `UsageEvent` and one balance decrement in its own transaction — a tool call
 * that happened was paid for, so a later round failing does not un-bill it.
 * Tool rounds are ephemeral: only the user message and the final reply are
 * conversation rows, and the per-call audit lives in the ledger plus the
 * returned trace (which the worker stores on the node row).
 */

const HISTORY_WINDOW = 12;
const DEFAULT_MAX_STEPS = 6;
const ARGS_PREVIEW_CHARS = 200;
const RESULT_PREVIEW_CHARS = 500;

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object describing the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type ModelMessage =
  | { role: "user" | "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolName: string };

export interface ModelCallResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls?: ToolCall[];
  stopReason: "stop" | "tool_calls";
}

/** The provider shape `core` is allowed to know. Structurally a `ModelProvider`. */
export interface ModelRunner {
  readonly name: string;
  readonly model: string;
  run(input: {
    systemPrompt: string;
    messages: ModelMessage[];
    maxOutputTokens: number;
    temperature: number;
    tools?: ToolDefinition[];
    responseFormat?: "json";
  }): Promise<ModelCallResult>;
}

/** Chosen per agent, because the agent's own row carries the provider and model. */
export type RunnerFactory = (selection: { provider: string; model: string }) => ModelRunner;

/** A tool the caller offers. `execute` touches real state or throws — never fakes a result. */
export interface AgentTool extends ToolDefinition {
  execute(values: Record<string, unknown>): Promise<string>;
}

export interface AgentTurnInput {
  message: string;
  /** What started the turn; recorded on the run row when an observer is attached. */
  triggerSource?: string;
  /** Reuse an existing thread so multi-turn context is genuine. */
  conversationId?: string;
  externalChatId?: string;
  /**
   * The webhook-inbox row that carried this message. Present means the row is
   * already there and this turn updates it to `PROCESSED`; absent means the turn
   * began in the console and the inbound half is recorded fresh. Inserting a
   * second row per queued message would double what the Runs page counts.
   */
  eventId?: string;
  /** Merged into every round's `UsageEvent` metadata — `origin`, `runId`, `nodeKey`. */
  metadata?: Record<string, string | number>;
  /** Tools this turn may call. Absent or empty means exactly one model call. */
  tools?: AgentTool[];
  /**
   * The assembled capability turn — prompt, tools, snapshot. Callers get it from
   * `prepareAgentTurn`, which is how the playground and the worker's graph nodes
   * send identical bytes for identical grants. Absent means the agent has no
   * capability rows and runs on its own `systemPrompt`, unchanged from before the
   * capability system existed.
   */
  assembly?: TurnAssembly;
  /** Model rounds allowed, including the final one. Defaults to six. */
  maxSteps?: number;
  /**
   * Set by a public surface (the website widget). It refuses a DRAFT agent;
   * every console and worker path leaves it off.
   */
  requireActive?: boolean;
  /** Epoch ms past which no new round may start. */
  deadlineAt?: number;
}

/** One executed tool call. Token counts belong to the model round that asked for it. */
export interface AgentTraceStep {
  index: number;
  tool: string;
  argsPreview: string;
  resultPreview: string;
  ok: boolean;
  inputTokens: number;
  outputTokens: number;
  /** Wall time spent executing the tool itself (not the model round). */
  durationMs: number;
}

/**
 * Optional projection of a turn into persistent activity. Core never writes
 * these rows itself; the API adapter supplies an observer. Every callback is
 * best-effort — activity must never be able to roll back billing or mask the
 * provider error it was trying to describe.
 */
export interface AgentTurnObserver {
  start(info: {
    agent: { id: string; name: string; projectId: string };
    triggerSource: string;
    conversationId: string;
    externalChatId: string;
    input: string;
    deadlineAt?: number;
    /** What the turn was assembled from, so a run can be replayed against it. */
    capability?: TurnAssembly["snapshot"];
    capabilityHash?: string;
  }): Promise<string | null>;
  round(
    runId: string,
    info: { seq: number; round: number; inputTokens: number; outputTokens: number; durationMs: number },
  ): Promise<void>;
  stepDone(
    runId: string,
    info: {
      seq: number;
      round: number;
      tool: string;
      argsPreview: string;
      resultPreview: string;
      ok: boolean;
      durationMs: number;
    },
  ): Promise<void>;
  finish(runId: string, outcome: AgentTurnOutcome): Promise<void>;
  fail(runId: string, error: unknown, partial: { tokensUsed: number; steps: number; durationMs: number }): Promise<void>;
}

export interface AgentTurnOutcome {
  conversationId: string;
  replyMessageId: string;
  reply: string;
  inputTokens: number;
  outputTokens: number;
  tokensUsed: number;
  costUsdEstimate: number;
  model: string;
  provider: string;
  durationMs: number;
  /** Model rounds this turn cost, including the final one. */
  steps: number;
  trace: AgentTraceStep[];
}

interface LoadedAgent {
  id: string;
  name: string;
  projectId: string;
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "ERROR";
  systemPrompt: string;
  modelProvider: string;
  modelName: string;
  temperature: number;
  maxOutputTokens: number;
  maxToolSteps: number;
  perTurnTokenBudget: number;
  dailyTokenBudget: number;
}

async function loadAgent(db: PrismaClient, tenantId: string, agentId: string): Promise<LoadedAgent> {
  const agent = await db.agent.findFirst({
    where: { AND: [{ id: agentId }, { tenantId }] },
    select: {
      id: true,
      name: true,
      projectId: true,
      status: true,
      systemPrompt: true,
      modelProvider: true,
      modelName: true,
      temperature: true,
      maxOutputTokens: true,
      maxToolSteps: true,
      perTurnTokenBudget: true,
      dailyTokenBudget: true,
    },
  });
  if (!agent) throw notFound("agent_not_found", `agent ${agentId} is not in this tenant`);
  // Anything but ACTIVE is refused, and an ERROR agent is refused on purpose:
  // a row the console already marked broken used to keep answering every
  // inbound message, so the badge and the behaviour disagreed.
  if (agent.status === "PAUSED" || agent.status === "ERROR") {
    throw conflict("agent_not_active", `${agent.name} is ${agent.status.toLowerCase()} — activate it before running`, {
      status: agent.status,
    });
  }
  return agent;
}

/**
 * `requireActive` is the public-surface gate. A DRAFT agent still answers the
 * playground — writing the prompt is what the playground is for — but nothing
 * a visitor can reach may run it until the operator activates it, so an embed
 * cannot go live against an agent that was never configured.
 */
function assertRunnableForSurface(agent: LoadedAgent, requireActive: boolean): void {
  if (agent.status === "DRAFT" && requireActive) {
    throw conflict("agent_not_active", `${agent.name} is a draft — activate it before it can answer on a public surface`, {
      status: agent.status,
    });
  }
}

export async function runAgentTurn(
  db: PrismaClient,
  tenantId: string,
  agentId: string,
  input: AgentTurnInput,
  runners: RunnerFactory,
  observer?: AgentTurnObserver,
): Promise<AgentTurnOutcome> {
  const agent = await loadAgent(db, tenantId, agentId);
  assertRunnableForSurface(agent, input.requireActive ?? false);

  await assertBalance(db, tenantId, 0);
  await assertDailyBudget(db, tenantId, agent);

  const externalChatId = input.conversationId
    ? await externalIdOf(db, tenantId, input.conversationId)
    : (input.externalChatId ?? "console-playground");

  const thread = await db.conversation.upsert({
    where: { agentId_externalChatId: { agentId, externalChatId } },
    update: { updatedAt: new Date() },
    create: { tenantId, agentId, externalChatId },
    select: { id: true, externalChatId: true },
  });

  const history = await db.conversationMessage.findMany({
    where: { AND: [{ tenantId }, { conversationId: thread.id }] },
    orderBy: { createdAt: "desc" },
    take: HISTORY_WINDOW,
    select: { role: true, content: true },
  });

  const messages: ModelMessage[] = history
    .reverse()
    .filter((row) => row.role === "USER" || row.role === "ASSISTANT")
    .map((row) =>
      row.role === "USER"
        ? { role: "user" as const, content: row.content }
        : { role: "assistant" as const, content: row.content },
    );
  messages.push({ role: "user", content: input.message });

  const provider = runners({ provider: agent.modelProvider, model: agent.modelName });
  // The call-site tools win a name collision: they are the specific ones (an
  // orchestrator's `subagent` closes over *this* run's declared roster), and the
  // turn must be able to override a generic grant rather than silently drop it.
  const tools = dedupeTools([...(input.tools ?? []), ...(input.assembly?.tools ?? [])]);
  // The tighter of the two caps: an agent row cannot raise the ceiling a
  // deployment set with AGENT_MAX_TOOL_STEPS, and a caller cannot lower the
  // agent's own bound below one round. The fallback is not paranoia about the
  // column — a row assembled by a test double or an older read has no value here,
  // and `Math.min(Infinity, undefined)` is NaN, which would disable the cap.
  const agentCap = finitePositive(agent.maxToolSteps) || DEFAULT_MAX_STEPS;
  const maxSteps = Math.max(1, Math.min(input.maxSteps ?? Number.POSITIVE_INFINITY, agentCap));
  const systemPrompt = input.assembly?.systemPrompt ?? agent.systemPrompt;
  const trace: AgentTraceStep[] = [];
  let steps = 0;
  let sequence = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalDurationMs = 0;
  let finalContent = "";

  // The run row is created after the pre-flight refusals above (a paused agent
  // or an empty balance is a turn that never happened) and before the first
  // paid call. A failing observer disables itself rather than the turn.
  const runId =
    observer === undefined
      ? null
      : await bestEffort(async () =>
          observer.start({
            agent: { id: agent.id, name: agent.name, projectId: agent.projectId },
            triggerSource: input.triggerSource ?? "console",
            conversationId: thread.id,
            externalChatId,
            input: input.message,
            deadlineAt: input.deadlineAt,
            ...(input.assembly === undefined
              ? {}
              : { capability: input.assembly.snapshot, capabilityHash: input.assembly.capabilityHash }),
          }),
        );
  // Link every ledger row for this turn to the activity row once it exists.
  const billedInput =
    runId === null
      ? input
      : { ...input, metadata: { ...input.metadata, agentRunId: runId } };

  try {
    for (;;) {
      assertWithinDeadline(input.deadlineAt, steps + 1);
      // Checked before the round, not after: a round's cost is only knowable by
      // running it, so the most a tool turn can overrun is the one round it is
      // in the middle of — and that round stays billed, because it happened.
      // Reading it once at the start let a six-round turn spend six times what
      // the balance said.
      if (steps > 0) await assertBalance(db, tenantId, steps);
      steps += 1;

      const { result, durationMs } = await callModel(provider, agent, systemPrompt, messages, tools, steps);
      await billRound(db, tenantId, agent, billedInput, steps, result, durationMs);
      totalInput += result.inputTokens;
      totalOutput += result.outputTokens;
      totalDurationMs += durationMs;
      // A per-turn ceiling is checked after the round it covers, for the same
      // reason the balance is checked before the next one: the cost of a round is
      // only knowable by running it. The rounds already spent stay billed.
      const perTurn = finitePositive(agent.perTurnTokenBudget);
      if (perTurn > 0 && totalInput + totalOutput > perTurn) {
        throw new HttpError(
          429,
          "agent_budget_exhausted",
          `this turn reached ${totalInput + totalOutput} token(s) against ${agent.name}'s per-turn budget of ${perTurn} after ${steps} model round(s)`,
          { scope: "per_turn", tokensUsed: totalInput + totalOutput, budget: perTurn, roundsAlreadyPaid: steps },
        );
      }
      if (runId !== null && observer !== undefined) {
        const roundSeq = (sequence += 1);
        await bestEffort(() =>
          observer.round(runId, {
            seq: roundSeq,
            round: steps,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            durationMs,
          }),
        );
      }

      const calls = result.toolCalls ?? [];
      if (result.stopReason !== "tool_calls" || calls.length === 0) {
        finalContent = result.content;
        break;
      }
      if (steps >= maxSteps) {
        // The round above was billed before this check: it happened. The refusal
        // names the cap so the fix (raise it or split the task) is explicit.
        throw new HttpError(
          422,
          "tool_step_limit",
          `the model asked for more tools after ${steps} model step(s) — the cap is ${maxSteps}; raise AGENT_MAX_TOOL_STEPS or split the task`,
          { steps, maxSteps, pendingCalls: calls.map((call) => call.name) },
        );
      }

      messages.push({ role: "assistant", content: result.content, toolCalls: calls });
      for (const call of calls) {
        assertWithinDeadline(input.deadlineAt, steps);
        const tool = tools.find((candidate) => candidate.name === call.name);
        const argsPreview = preview(call.arguments, ARGS_PREVIEW_CHARS);
        let output: string;
        let ok = true;
        const toolStartedAt = Date.now();
        if (tool === undefined) {
          ok = false;
          output = `TOOL_ERROR: no tool named "${call.name}" is available in this turn`;
        } else {
          try {
            output = await tool.execute(call.arguments);
          } catch (error) {
            ok = false;
            output = `TOOL_ERROR: ${error instanceof Error ? error.message : "tool execution failed"}`;
          }
        }
        const toolDurationMs = Date.now() - toolStartedAt;
        const resultPreview = preview(output, RESULT_PREVIEW_CHARS);
        messages.push({ role: "tool", content: output, toolName: call.name });
        trace.push({
          index: steps,
          tool: call.name,
          argsPreview,
          resultPreview,
          ok,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          durationMs: toolDurationMs,
        });
        if (runId !== null && observer !== undefined) {
          const toolSeq = (sequence += 1);
          await bestEffort(() =>
            observer.stepDone(runId, {
              seq: toolSeq,
              round: steps,
              tool: call.name,
              argsPreview,
              resultPreview,
              ok,
              durationMs: toolDurationMs,
            }),
          );
        }
      }
    }
  } catch (error) {
    if (runId !== null && observer !== undefined) {
      await bestEffort(() =>
        observer.fail(runId, error, {
          tokensUsed: totalInput + totalOutput,
          steps,
          durationMs: totalDurationMs,
        }),
      );
    }
    throw error;
  }

  // This workspace is served by a local Ollama daemon: there is no per-token
  // invoice, so the estimate is genuinely zero rather than an invented rate.
  const costUsdEstimate = 0;
  const tokensUsed = totalInput + totalOutput;

  let replyMessage: { id: string };
  try {
    replyMessage = await db.$transaction(async (tx) => {
    const userMessage = await tx.conversationMessage.create({
      data: { tenantId, conversationId: thread.id, role: "USER", content: input.message },
      select: { id: true },
    });
    const assistant = await tx.conversationMessage.create({
      data: {
        tenantId,
        conversationId: thread.id,
        role: "ASSISTANT",
        content: finalContent,
        // The whole turn's cost: every round existed to produce this reply, and
        // the per-round split is already in the ledger.
        inputTokens: totalInput,
        outputTokens: totalOutput,
      },
      select: { id: true },
    });
    if (input.eventId) {
      // A queued message already owns its inbox row; this is the answer to it.
      await tx.webhookEventLog.update({
        where: { id: input.eventId },
        data: { status: "PROCESSED", processedAt: new Date() },
      });
    } else {
      // Otherwise the inbound half belongs in the inbox the Runs page shows.
      await tx.webhookEventLog.create({
        data: {
          tenantId,
          source: "console",
          externalMessageId: userMessage.id,
          status: "PROCESSED",
          processedAt: new Date(),
        },
      });
    }
    await tx.conversation.update({ where: { id: thread.id }, data: { updatedAt: new Date() } });
    return assistant;
    });
  } catch (error) {
    if (runId !== null && observer !== undefined) {
      await bestEffort(() =>
        observer.fail(runId, error, {
          tokensUsed: totalInput + totalOutput,
          steps,
          durationMs: totalDurationMs,
        }),
      );
    }
    throw error;
  }

  const outcome: AgentTurnOutcome = {
    conversationId: thread.id,
    replyMessageId: replyMessage.id,
    reply: finalContent,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    tokensUsed,
    costUsdEstimate,
    model: agent.modelName,
    provider: agent.modelProvider,
    durationMs: totalDurationMs,
    steps,
    trace,
  };
  if (runId !== null && observer !== undefined) {
    await bestEffort(() => observer.finish(runId, outcome));
  }
  return outcome;
}

async function callModel(
  provider: ModelRunner,
  agent: LoadedAgent,
  systemPrompt: string,
  messages: ModelMessage[],
  tools: AgentTool[],
  round: number,
): Promise<{ result: ModelCallResult; durationMs: number }> {
  const startedAt = Date.now();
  let result: ModelCallResult;
  try {
    result = await withRetry(
      () =>
        provider.run({
          systemPrompt,
          messages,
          temperature: agent.temperature,
          maxOutputTokens: agent.maxOutputTokens,
          ...(tools.length > 0 ? { tools } : {}),
        }),
      { retries: 2, backoffMs: 400, backoffCapMs: 2_000 },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : "provider call failed";
    // Earlier rounds stay billed: they happened. This round wrote nothing.
    throw new HttpError(502, "provider_failed", `model round ${round}: ${reason}`, { provider: agent.modelProvider });
  }
  const durationMs = Date.now() - startedAt;
  const tokens = result.inputTokens + result.outputTokens;
  if (!Number.isFinite(tokens) || tokens <= 0) {
    throw badRequest("provider_usage", "provider reported zero usage — nothing was metered");
  }
  return { result, durationMs };
}

/** One ledger row and one decrement per completed model round, atomically. */
async function billRound(
  db: PrismaClient,
  tenantId: string,
  agent: LoadedAgent,
  input: AgentTurnInput,
  callIndex: number,
  result: ModelCallResult,
  durationMs: number,
): Promise<void> {
  const tokensUsed = result.inputTokens + result.outputTokens;
  await db.$transaction(async (tx) => {
    await tx.usageEvent.create({
      data: {
        tenantId,
        agentId: agent.id,
        kind: "MODEL_CALL",
        tokensUsed,
        costUsdEstimate: 0,
        metadata: {
          provider: agent.modelProvider,
          model: agent.modelName,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          durationMs,
          callIndex,
          role: "assistant",
          stopReason: result.stopReason,
          origin: "console",
          ...input.metadata,
        },
      },
    });
    await tx.tenant.update({ where: { id: tenantId }, data: { tokenBalance: { decrement: BigInt(tokensUsed) } } });
  });
}

/**
 * A per-agent daily ceiling, counted from the ledger rather than a counter we
 * would have to keep in sync with it. A heavy knowledge turn therefore cannot
 * spend the day's allowance meant for chat without that spend being visible in
 * the row it came from.
 *
 * UTC day, because "today" has to mean one thing to a tenant whose visitors do
 * not — a local midnight would reset the budget at a time nobody can predict.
 */
/**
 * A limit column as a number, or 0 for "this row never set one".
 * `undefined <= 0` and `undefined > 0` are both false, so comparing the raw column
 * is how a missing value turns into a limit of zero — or into a check that runs at
 * all. Rows assembled before the migration and doubles that omit the column have
 * no value here, and the honest reading of that is "no limit" (budget) or "use the
 * deployment default" (step cap).
 */
function finitePositive(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : 0;
}

async function assertDailyBudget(db: PrismaClient, tenantId: string, agent: LoadedAgent): Promise<void> {
  const budget = finitePositive(agent.dailyTokenBudget);
  if (budget === 0) return;
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const spent = await db.usageEvent.aggregate({
    _sum: { tokensUsed: true },
    where: { AND: [{ tenantId }, { agentId: agent.id }, { createdAt: { gte: dayStart } }] },
  });
  const used = spent._sum.tokensUsed ?? 0;
  if (used < budget) return;
  throw new HttpError(
    429,
    "agent_budget_exhausted",
    `${agent.name} has used ${used} token(s) today against its daily budget of ${budget} — nothing was spent on this turn`,
    { scope: "daily", tokensUsed: used, budget, dayStart: dayStart.toISOString() },
  );
}

/** First definition of a name wins, so the call-site list overrides the assembly. */
function dedupeTools(tools: AgentTool[]): AgentTool[] {
  const seen = new Set<string>();
  const kept: AgentTool[] = [];
  for (const tool of tools) {
    if (seen.has(tool.name)) continue;
    seen.add(tool.name);
    kept.push(tool);
  }
  return kept;
}

/** Zero balance refuses a round before it is spent, never after. */
async function assertBalance(db: PrismaClient, tenantId: string, roundsAlreadyPaid: number): Promise<void> {  const tenant = await db.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { tokenBalance: true } });
  if (tenant.tokenBalance > 0n) return;
  throw new HttpError(
    402,
    "quota_exhausted",
    roundsAlreadyPaid === 0
      ? "this workspace has no tokens left in the current cycle"
      : `the turn stopped after ${roundsAlreadyPaid} model round(s) — the balance reached zero`,
    { roundsAlreadyPaid },
  );
}

function assertWithinDeadline(deadlineAt: number | undefined, round: number): void {
  if (deadlineAt !== undefined && Date.now() > deadlineAt) {
    throw new HttpError(504, "run_deadline", `the turn passed its deadline before model round ${round}`);
  }
}

/** Activity is a projection: a failing observer never fails the turn. */
async function bestEffort<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

function preview(value: unknown, limit: number): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

async function externalIdOf(db: PrismaClient, tenantId: string, conversationId: string): Promise<string> {
  const row = await db.conversation.findFirst({
    where: { AND: [{ id: conversationId }, { tenantId }] },
    select: { externalChatId: true },
  });
  if (!row) throw notFound("conversation_not_found", `conversation ${conversationId} is not in this tenant`);
  return row.externalChatId;
}
