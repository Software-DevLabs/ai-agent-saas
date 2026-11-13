import type { Prisma, PrismaClient } from "@prisma/client";
import { HttpError, type Keyring } from "@saas/shared";
import { runAgentTurn, type AgentTool, type AgentTraceStep, type RunnerFactory } from "./agent-run.ts";
import { prepareAgentTurn } from "./capability/assemble.ts";
import type { QueryEmbedder } from "./knowledge/search.ts";
import {
  joinInputs,
  MAX_JOINED_INPUT,
  type GraphEdge,
  type GraphNode,
  type OrchestratorNode,
  type OrchestratorSubagent,
} from "./graph.ts";
import { inspectWorkflow } from "./inspect.ts";
import { attemptDecide, attemptDelay, describeError } from "./queue-policy.ts";
import type { Queue, QueueJob } from "./queue.ts";

/**
 * `executeGraph` — the worker's whole job, one graph at a time.
 *
 * Three rules give this file its shape:
 *
 * 1. **Nothing is trusted from the queue.** The `definition` column is re-read and
 *    re-judged through the same `inspectWorkflow` the console used, so a job
 *    enqueued against an older graph cannot run wiring the server would refuse to
 *    activate today.
 * 2. **Every node gets a row before anything runs.** The PENDING rows are what let
 *    the canvas say "3 of 7 nodes not reached" instead of going quiet, and a node
 *    that already SUCCEEDED under an earlier lease is skipped rather than re-run —
 *    at-least-once *delivery* must not become at-least-once *billing*.
 * 3. **A sink that cannot deliver says so.** `SHEETS_OUT` and `DRIVE_OUT` have no
 *    connector in this build, and a silently-succeeding sink node would be the
 *    worst lie this console can tell.
 */

export interface GraphRunPayload {
  workflowId: string;
  message: string;
  /** Console test runs reuse one thread; a real channel supplies its own. */
  externalChatId?: string;
}

export interface GraphRunRequest {
  db: PrismaClient;
  queue: Queue;
  keyring: Keyring;
  /** Already claimed by this worker: the lease is held before `executeGraph` is called. */
  job: QueueJob;
  workerId: string;
  leaseMs: number;
  heartbeatMs: number;
  deadlineMs: number;
  runners: RunnerFactory;
  /** Model rounds one agent turn may spend on tools (AGENT_MAX_TOOL_STEPS). */
  maxToolSteps: number;
  /** Delegations one orchestrator turn may make (ORCHESTRATOR_MAX_SUBAGENT_CALLS). */
  maxSubagentCalls: number;
  /**
   * The embedding path for `knowledge_search` on every agent node. Omitted means
   * keyword-only retrieval, which is a working knowledge base.
   */
  embedQuery?: QueryEmbedder;
}

export type GraphRunResult =
  | { outcome: "succeeded"; runId: string; output: string; tokensUsed: number }
  | { outcome: "failed" | "blocked"; runId: string | null; error: string }
  | { outcome: "lease-lost"; runId: string | null };

/** Raised when the lease is gone. Nothing below it may write again. */
class LeaseLost extends Error {}

function readPayload(raw: unknown): GraphRunPayload | null {
  const body = raw as GraphRunPayload | null;
  if (body === null || typeof body !== "object") return null;
  if (typeof body.workflowId !== "string" || typeof body.message !== "string") return null;
  return { workflowId: body.workflowId, message: body.message, externalChatId: body.externalChatId };
}

export async function executeGraph(request: GraphRunRequest): Promise<GraphRunResult> {
  const { db, queue, keyring, job, workerId, leaseMs, heartbeatMs, deadlineMs, runners, maxToolSteps, maxSubagentCalls } = request;
  const tenantId = job.tenantId;
  if (tenantId === null) {
    await queue.dead(job.id, workerId, "job has no tenant to run under");
    return { outcome: "failed", runId: null, error: "job has no tenant to run under" };
  }

  const payload = readPayload(job.payload);
  if (payload === null) {
    // A body this build cannot interpret will not be understood by a retry either.
    await queue.dead(job.id, workerId, "job payload is not a graph run");
    return { outcome: "failed", runId: null, error: "job payload is not a graph run" };
  }

  const workflow = await db.workflow.findFirst({
    where: { AND: [{ id: payload.workflowId }, { tenantId }] },
    select: { id: true, projectId: true, name: true, version: true, status: true, definition: true },
  });
  if (workflow === null) {
    await queue.dead(job.id, workerId, `workflow ${payload.workflowId} is not in this tenant`);
    return { outcome: "failed", runId: null, error: `workflow ${payload.workflowId} is not in this tenant` };
  }
  if (workflow.status !== "ACTIVE") {
    // Pausing has to stop the next message, not only the ones after a restart. The
    // job waits rather than dying: resuming the graph is a legitimate thing to do
    // in five minutes, and this run should never have been queued while paused.
    const reason = `${workflow.name} is ${workflow.status.toLowerCase()}, not active`;
    await queue.retry(job.id, workerId, reason, attemptDelay(job.attempts));
    return { outcome: "failed", runId: null, error: reason };
  }

  const inspection = await inspectWorkflow(db, tenantId, workflow);
  if (inspection.graph === null || inspection.blockers.length > 0) {
    const reason = inspection.blockers
      .map((issue) => `${issue.path ?? issue.nodeKey ?? "graph"}: ${issue.message}`)
      .join("; ");
    await queue.dead(job.id, workerId, reason);
    return { outcome: "failed", runId: null, error: reason };
  }

  const run = await prepareRun(db, {
    tenantId,
    workflow,
    message: payload.message,
    triggerSource: job.source,
    externalMessageId: job.externalMessageId,
    nodes: inspection.graph.nodes,
    runId: job.runId,
  });
  // Re-affirmed here because the console's test run already linked them: this is
  // the path a channel event takes, where the job is written before any run row.
  await queue.attachRun(job.id, workerId, run.id, workflow.id);
  const lease = startLease(queue, job.id, workerId, leaseMs, heartbeatMs);
  const startedAt = run.startedAt;
  const clocks = new Map<string, number>();

  try {
    const walked = await walk({
      db,
      keyring,
      jobId: job.id,
      tenantId,
      runId: run.id,
      nodes: inspection.graph.nodes,
      edges: inspection.graph.edges,
      order: inspection.report.order,
      runners,
      message: payload.message,
      startedAt,
      deadlineMs,
      clocks,
      maxToolSteps,
      maxSubagentCalls,
      lease,
      ...(request.embedQuery === undefined ? {} : { embedQuery: request.embedQuery }),
    });
    await db.workflowRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCEEDED",
        output: walked.output,
        tokensUsed: walked.tokensUsed,
        durationMs: Date.now() - startedAt.getTime(),
        finishedAt: new Date(),
      },
    });
    await queue.succeed(job.id, workerId);
    return { outcome: "succeeded", runId: run.id, output: walked.output, tokensUsed: walked.tokensUsed };
  } catch (error) {
    if (error instanceof LeaseLost) {
      // Another process holds the job now. Anything we wrote here would overwrite
      // that process's answer with ours.
      return { outcome: "lease-lost", runId: run.id };
    }
    const reason = describeError(error);
    const decision = attemptDecide(error, job.attempts, job.maxAttempts);
    await db.workflowRun.update({
      where: { id: run.id },
      data: {
        status: decision === "blocked" ? "BLOCKED" : "FAILED",
        error: reason,
        tokensUsed: sumTokens(clocks),
        durationMs: Date.now() - startedAt.getTime(),
        finishedAt: new Date(),
      },
    });
    await markUnreached(db, run.id, reason);
    // A blocked tenant is terminal for this job too: retrying against a zero
    // balance spends nothing and buries the real reason in a stack of failures.
    if (decision === "retry") await queue.retry(job.id, workerId, reason, attemptDelay(job.attempts));
    else await queue.dead(job.id, workerId, reason);
    return { outcome: decision === "blocked" ? "blocked" : "failed", runId: run.id, error: reason };
  } finally {
    lease.stop();
  }
}

/**
 * One run row plus one PENDING row per box, in a single transaction — so the
 * console never sees a run with fewer node rows than the graph has nodes.
 *
 * The console's test run calls this *before* the job exists, so `202` can name a
 * real run the canvas then polls; the worker calls the same function with that
 * `runId` and resumes it. Pre-writing also runs on a re-claimed lease: `update:
 * {}` leaves a node that already SUCCEEDED exactly as it was, and a box that
 * appeared since the last attempt gets its row.
 */
export async function prepareRun(
  db: PrismaClient,
  run: {
    tenantId: string;
    workflow: { id: string; name: string; version: number };
    message: string;
    triggerSource: string;
    externalMessageId: string;
    nodes: GraphNode[];
    /** Set when the row already exists — a resume, never a second run for one message. */
    runId?: string | null;
  },
): Promise<{ id: string; startedAt: Date }> {
  return db.$transaction(async (tx) => {
    const existing =
      run.runId === undefined || run.runId === null
        ? null
        : await tx.workflowRun.findFirst({
            where: { AND: [{ id: run.runId }, { tenantId: run.tenantId }] },
            select: { id: true, startedAt: true },
          });
    const row =
      existing ??
      (await tx.workflowRun.create({
        data: {
          tenantId: run.tenantId,
          workflowId: run.workflow.id,
          workflowName: run.workflow.name,
          workflowVersion: run.workflow.version,
          status: "RUNNING",
          triggerSource: run.triggerSource,
          externalMessageId: run.externalMessageId,
          input: run.message,
        },
        select: { id: true, startedAt: true },
      }));
    for (const node of run.nodes) {
      await tx.workflowNodeRun.upsert({
        where: { runId_nodeKey: { runId: row.id, nodeKey: node.key } },
        update: {},
        create: {
          tenantId: run.tenantId,
          runId: row.id,
          nodeKey: node.key,
          kind: node.kind,
          label: node.label ?? null,
          refId: node.kind === "INBOUND" || node.kind === "OUTBOUND" ? node.config.integrationId : node.config.agentId,
          status: "PENDING",
        },
      });
    }
    return row;
  });
}

interface Lease {
  /** Call between nodes. Throws `LeaseLost` once another worker holds the row. */
  check(): void;
  stop(): void;
}

/**
 * The lease is extended on a timer and the loss is noticed at the next node
 * boundary, which is the honest granularity: a model call can run for two minutes
 * and nothing in this build can interrupt one mid-flight. The row already
 * SUCCEEDED is why that is survivable.
 */
function startLease(queue: Queue, jobId: string, workerId: string, leaseMs: number, everyMs: number): Lease {
  let lost = false;
  const timer = setInterval(() => {
    void queue
      .heartbeat(jobId, workerId, leaseMs)
      .then((held) => {
        if (!held) lost = true;
      })
      .catch(() => {
        /* a beat that fails to land is retried on the next tick; the lease decides */
      });
  }, everyMs);
  timer.unref?.();
  return {
    check() {
      if (lost) throw new LeaseLost("another worker holds this job now");
    },
    stop() {
      clearInterval(timer);
    },
  };
}

interface WalkRequest {
  db: PrismaClient;
  keyring: Keyring;
  jobId: string;
  tenantId: string;
  runId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  order: string[];
  runners: RunnerFactory;
  message: string;
  startedAt: Date;
  deadlineMs: number;
  /** Tokens spent per agent node, so a partial run still reports a real cost. */
  clocks: Map<string, number>;
  maxToolSteps: number;
  maxSubagentCalls: number;
  lease: Lease;
  embedQuery?: QueryEmbedder;
}

/**
 * The graph in `topoOrder`, one node at a time. An inbound node's output is the
 * message that arrived; an agent node's is the model's reply; a sink's is the text
 * it delivered, so a fan-in downstream of one reads the same words.
 */
async function walk(request: WalkRequest): Promise<{ output: string; tokensUsed: number }> {
  const { db, runId, nodes, edges, order, message, clocks } = request;
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const upstream = new Map<string, string[]>(nodes.map((node) => [node.key, []]));
  for (const edge of edges) upstream.get(edge.to)?.push(edge.from);

  const done = new Map<string, string>();

  for (const key of order) {
    const node = byKey.get(key);
    if (node === undefined) continue;
    const existing = await db.workflowNodeRun.findFirst({
      where: { AND: [{ runId }, { nodeKey: key }] },
      select: { status: true, output: true },
    });
    if (existing?.status === "SUCCEEDED") {
      // Resume, not replay: this node already spent the tenant's tokens.
      done.set(key, existing.output ?? "");
      clocks.set(key, 0);
      continue;
    }
    request.lease.check();
    if (Date.now() - request.startedAt.getTime() > request.deadlineMs) {
      throw new HttpError(504, "run_deadline", `the run passed its deadline before node ${key}`);
    }

    const inputs = (upstream.get(key) ?? []).map((from) => done.get(from) ?? "");
    const joined = joinInputs(inputs.length > 0 ? inputs : [message], MAX_JOINED_INPUT);
    done.set(key, await runNode(request, node, joined.text === "" ? message : joined.text, clocks));
  }

  const last = order.length > 0 ? order[order.length - 1] : undefined;
  return { output: (last === undefined ? undefined : done.get(last)) ?? message, tokensUsed: sumTokens(clocks) };
}

const sumTokens = (clocks: Map<string, number>): number =>
  [...clocks.values()].reduce((total, value) => total + value, 0);

/** Returns the text this node produced, so `walk` can hand it downstream. */
async function runNode(request: WalkRequest, node: GraphNode, input: string, clocks: Map<string, number>): Promise<string> {
  const { db, runId } = request;
  const started = Date.now();
  await db.workflowNodeRun.updateMany({
    where: { AND: [{ runId }, { nodeKey: node.key }] },
    data: { status: "RUNNING", attempt: { increment: 1 }, input, startedAt: new Date(), error: null, finishedAt: null },
  });

  const finish = async (data: {
    status: "SUCCEEDED" | "FAILED";
    output?: string;
    error?: string;
    tokensUsed?: number;
    trace?: AgentTraceStep[];
  }) => {
    await db.workflowNodeRun.updateMany({
      where: { AND: [{ runId }, { nodeKey: node.key }] },
      data: {
        status: data.status,
        output: data.output,
        error: data.error,
        ...(data.tokensUsed === undefined ? {} : { tokensUsed: data.tokensUsed }),
        ...(data.trace === undefined ? {} : { trace: data.trace as unknown as Prisma.InputJsonValue }),
        durationMs: Date.now() - started,
        finishedAt: new Date(),
      },
    });
  };

  try {
    if (node.kind === "INBOUND") {
      await finish({ status: "SUCCEEDED", output: input });
      return input;
    }
    if (node.kind === "AGENT") {
      // The same assembler the playground path uses, so an agent asked the same
      // question by a channel and by a person in the console sends the same bytes.
      const assembly = await prepareAgentTurn(db, request.tenantId, node.config.agentId, {
        ...(request.embedQuery === undefined ? {} : { embedQuery: request.embedQuery }),
      });
      const turn = await runAgentTurn(
        db,
        request.tenantId,
        node.config.agentId,
        {
          message: input,
          assembly,
          // One thread per run: the playground and a graph run cannot end up
          // sharing a conversation history they were never meant to have.
          externalChatId: `workflow-run:${runId}`,
          eventId: request.jobId,
          metadata: { origin: "workflow", runId, nodeKey: node.key },
          maxSteps: request.maxToolSteps,
          deadlineAt: request.startedAt.getTime() + request.deadlineMs,
        },
        request.runners,
      );
      clocks.set(node.key, turn.tokensUsed);
      await finish({
        status: "SUCCEEDED",
        output: turn.reply,
        tokensUsed: turn.tokensUsed,
        ...(turn.trace.length > 0 ? { trace: turn.trace } : {}),
      });
      return turn.reply;
    }
    if (node.kind === "ORCHESTRATOR") {
      const turn = await runOrchestratorTurn(request, node, input);
      clocks.set(node.key, turn.tokensUsed);
      await finish({
        status: "SUCCEEDED",
        output: turn.reply,
        tokensUsed: turn.tokensUsed,
        ...(turn.trace.length > 0 ? { trace: turn.trace } : {}),
      });
      return turn.reply;
    }
    const delivered = await deliverSink(request, node, input);
    await finish({ status: "SUCCEEDED", output: delivered });
    return delivered;
  } catch (error) {
    const reason = describeError(error);
    await finish({ status: "FAILED", error: reason });
    throw error;
  }
}

/**
 * One orchestrator node: the orchestrator agent runs a tool loop with exactly
 * one tool, `subagent`, whose roles are the declared subagents. A delegation is
 * a full `runAgentTurn` for that agent — billed per model call like any turn —
 * and its failure returns to the model as a `SUBAGENT_ERROR:` result rather than
 * a fabricated answer. Delegation is depth 1: subagents run with no tools.
 *
 * The node's total is the orchestrator's own rounds plus every subagent turn, so
 * the run total and the per-node total agree with the ledger.
 */
async function runOrchestratorTurn(
  request: WalkRequest,
  node: OrchestratorNode,
  input: string,
): Promise<{ reply: string; tokensUsed: number; trace: AgentTraceStep[] }> {
  const { db, tenantId, runId } = request;
  const declared = node.config.subagents;
  const deadlineAt = request.startedAt.getTime() + request.deadlineMs;

  // Names are read here so the tool description can say which role is which
  // agent; the graph check already refused a missing agent at activation.
  const rows =
    declared.length === 0
      ? []
      : await db.agent.findMany({
          where: { AND: [{ tenantId }, { id: { in: declared.map((sub) => sub.agentId) } }] },
          select: { id: true, name: true },
        });
  const nameById = new Map(rows.map((row) => [row.id, row.name]));
  const roster = declared.map((sub) => `${sub.role} (${nameById.get(sub.agentId) ?? "missing agent"})`);

  let calls = 0;
  let subagentTokens = 0;

  const subagentTool: AgentTool = {
    name: "subagent",
    description:
      declared.length === 0
        ? "Delegate a task to a declared specialist. This orchestrator declares no subagents, so no delegation is possible."
        : `Delegate one self-contained task to a declared specialist and get its reply. Each call is a full model turn for that agent, so delegate only what you cannot do yourself. Roles: ${roster.join(", ")}.`,
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", enum: declared.map((sub) => sub.role), description: "Which declared subagent should do the work." },
        task: { type: "string", description: "A complete, self-contained instruction — the subagent cannot see this conversation." },
      },
      required: ["role", "task"],
    },
    execute: async (args) => {
      const role = typeof args.role === "string" ? args.role.trim() : "";
      const task = typeof args.task === "string" ? args.task.trim() : "";
      const sub = declared.find((entry) => entry.role === role);
      if (sub === undefined) {
        return `SUBAGENT_ERROR: no declared subagent has role "${role}"; declared roles: ${declared.map((entry) => entry.role).join(", ") || "none"}`;
      }
      if (task === "") return "SUBAGENT_ERROR: task must be a non-empty string";
      if (calls >= request.maxSubagentCalls) {
        return `SUBAGENT_ERROR: this turn already made ${calls} delegation(s) and the cap is ${request.maxSubagentCalls} — answer with what you have`;
      }
      if (Date.now() > deadlineAt) return "SUBAGENT_ERROR: the run passed its deadline before this delegation";
      calls += 1;
      try {
        const turn = await delegate(request, node, sub, task, calls);
        subagentTokens += turn.tokensUsed;
        // The parent's context is capped like any fan-in; the cut is visible.
        return turn.reply.length > MAX_JOINED_INPUT ? `${turn.reply.slice(0, MAX_JOINED_INPUT)}…` : turn.reply;
      } catch (error) {
        return `SUBAGENT_ERROR: ${describeError(error)}`;
      }
    },
  };

  // `subagent` is not a registry capability — it closes over *this* node's declared
  // roster — so it enters the assembly as an extra tool rather than as a grant.
  // The orchestrator's own skills still come from its grants, through the same
  // assembler every other node uses.
  const assembly = await prepareAgentTurn(db, tenantId, node.config.agentId, {
    extraTools: declared.length === 0 ? [] : [subagentTool],
    ...(request.embedQuery === undefined ? {} : { embedQuery: request.embedQuery }),
  });
  const turn = await runAgentTurn(
    db,
    tenantId,
    node.config.agentId,
    {
      message: input,
      assembly,
      externalChatId: `workflow-run:${runId}`,
      eventId: request.jobId,
      metadata: { origin: "workflow-orchestrator", runId, nodeKey: node.key },
      maxSteps: request.maxToolSteps,
      deadlineAt,
    },
    request.runners,
  );

  return { reply: turn.reply, tokensUsed: turn.tokensUsed + subagentTokens, trace: turn.trace };
}

/** One delegation: a real agent turn, in its own thread, billed on its own. */
async function delegate(
  request: WalkRequest,
  node: OrchestratorNode,
  sub: OrchestratorSubagent,
  task: string,
  callIndex: number,
): Promise<{ reply: string; tokensUsed: number }> {
  const { db, tenantId, runId } = request;
  const agent = await db.agent.findFirst({
    where: { AND: [{ id: sub.agentId }, { tenantId }] },
    select: { id: true },
  });
  if (agent === null) throw new Error(`subagent "${sub.role}" points at an agent that no longer exists`);
  // Assembled like any other turn: a specialist reads its own skills when it is
  // delegated to, exactly as it would if the same question arrived in the console.
  // What it does *not* get is another `subagent` tool — delegation stays depth 1.
  const assembly = await prepareAgentTurn(db, tenantId, sub.agentId, {
    ...(request.embedQuery === undefined ? {} : { embedQuery: request.embedQuery }),
  });
  const turn = await runAgentTurn(
    db,
    tenantId,
    sub.agentId,
    {
      message: task,
      assembly,
      // One thread per run and agent: a later run cannot inherit this context,
      // and two subagents cannot read each other's history.
      externalChatId: `workflow-run:${runId}:${sub.agentId}`,
      eventId: request.jobId,
      metadata: { origin: "workflow-subagent", runId, nodeKey: node.key, role: sub.role, callIndex },
      maxSteps: sub.maxSteps ?? 1,
    },
    request.runners,
  );
  return { reply: turn.reply, tokensUsed: turn.tokensUsed };
}

/**
 * The only sink this build can honestly reach is a webhook URL. Everything else
 * fails in its own words, because a node reporting success while nothing was sent
 * tells the tenant their data went somewhere it did not.
 */
async function deliverSink(request: WalkRequest, node: GraphNode & { kind: "OUTBOUND" }, text: string): Promise<string> {
  const channel = await request.db.integration.findFirst({
    where: { AND: [{ id: node.config.integrationId }, { tenantId: request.tenantId }] },
    select: { id: true, type: true, credentialsEncrypted: true, externalId: true, status: true },
  });
  if (channel === null) throw new HttpError(409, "dangling_integration", `node ${node.key} points at a channel that no longer exists`);
  if (channel.type !== "WEBHOOK_OUT") {
    throw new HttpError(409, "sink_not_wired", `${channel.type} has no connector implemented — only WEBHOOK_OUT can deliver in this build`);
  }
  const url = request.keyring.decrypt(channel.credentialsEncrypted);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new HttpError(502, "sink_delivery_failed", `${channel.externalId ?? url} answered ${response.status}`);
  return text;
}

/** Nodes the walk never reached say why, rather than sitting PENDING forever. */
async function markUnreached(db: PrismaClient, runId: string, reason: string): Promise<void> {
  await db.workflowNodeRun.updateMany({
    where: { AND: [{ runId }, { status: "PENDING" }] },
    data: { status: "SKIPPED", error: reason, finishedAt: new Date() },
  });
}
