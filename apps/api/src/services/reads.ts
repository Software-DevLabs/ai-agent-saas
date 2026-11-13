import { Prisma, type PrismaClient } from "@prisma/client";
import type { CapabilitySnapshot, GraphDefinition } from "@saas/core";
import { projectWhere, tenantWhere } from "@saas/db";
import type { Keyring } from "@saas/shared";
import type {
  ActivityItemDto,
  ActivityStatus,
  AgentDto,
  AgentRunDetailDto,
  AgentRunDto,
  AgentRunStepDto,
  AgentTraceStepDto,
  ConversationDto,
  DailyPointDto,
  IntegrationDto,
  MessageDto,
  NodeRunStatus,
  OverviewDto,
  PlanDto,
  ProjectDto,
  RunStatus,
  TenantDto,
  UsageEventDto,
  WebhookEventDto,
  WorkflowDto,
  WorkflowNodeRunDto,
  WorkflowRunSummaryDto,
  WorkflowSummaryDto,
} from "../dto.ts";

/**
 * Every function here reads the database the tenant owns and nothing else.
 * `tenantId` comes from the session (see `main.ts`), never from the request,
 * and each query carries it explicitly. `scoped` is the API's name for
 * `tenantWhere` in `packages/db/src/filter.ts` — the shape is the one
 * `packages/db/src/scoped.ts` produces, so a missing predicate is a visible
 * mistake rather than an accident.
 */

export const scoped = tenantWhere;

const DAY_MS = 86_400_000;

function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * `cycleResetAt` is always the 1st at the same clock time (see the seed), so
 * stepping the month back one lands exactly on the start of the current cycle.
 */
export function cycleStart(cycleResetAt: Date): Date {
  const start = new Date(cycleResetAt);
  start.setUTCMonth(start.getUTCMonth() - 1);
  return start;
}

export function maskSecret(plain: string): string {
  const chars = plain.replace(/[^A-Za-z0-9]/g, "");
  const tail = chars.slice(-4);
  return tail ? `****${tail}` : "****";
}

function preview(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

const tenantSelect = {
  id: true,
  name: true,
  planId: true,
  tokenBalance: true,
  cycleResetAt: true,
  createdAt: true,
  plan: { select: { id: true, name: true, monthlyPriceUsd: true, tokenQuota: true, maxIntegrations: true, features: true } },
} satisfies Prisma.TenantSelect;

type TenantRow = Prisma.TenantGetPayload<{ select: typeof tenantSelect }>;

function tenantView(row: TenantRow): TenantDto {
  return {
    id: row.id,
    name: row.name,
    planId: row.planId,
    planName: row.plan.name,
    tokenBalance: row.tokenBalance.toString(),
    cycleResetAt: row.cycleResetAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function planView(row: { id: string; name: string; monthlyPriceUsd: Prisma.Decimal; tokenQuota: bigint; maxIntegrations: number; features: Prisma.JsonValue }): PlanDto {
  return {
    id: row.id,
    name: row.name,
    monthlyPriceUsd: Number(row.monthlyPriceUsd),
    tokenQuota: row.tokenQuota.toString(),
    maxIntegrations: row.maxIntegrations,
    features: (row.features ?? {}) as Record<string, unknown>,
  };
}

async function loadTenant(db: PrismaClient, tenantId: string): Promise<TenantRow> {
  return db.tenant.findFirstOrThrow({ where: { id: tenantId }, select: tenantSelect });
}

const agentSelect = {
  id: true,
  tenantId: true,
  projectId: true,
  name: true,
  status: true,
  systemPrompt: true,
  modelProvider: true,
  modelName: true,
  temperature: true,
  maxOutputTokens: true,
  maxToolSteps: true,
  perTurnTokenBudget: true,
  dailyTokenBudget: true,
  createdAt: true,
  _count: { select: { conversations: true, integrations: true } },
} satisfies Prisma.AgentSelect;

type AgentRow = Prisma.AgentGetPayload<{ select: typeof agentSelect }>;

interface AgentCounters {
  tokens: number;
  lastRunAt: Date | null;
}

function agentView(row: AgentRow, counters: AgentCounters | undefined): AgentDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    name: row.name,
    status: row.status,
    systemPrompt: row.systemPrompt,
    modelProvider: row.modelProvider,
    modelName: row.modelName,
    temperature: row.temperature,
    maxOutputTokens: row.maxOutputTokens,
    maxToolSteps: row.maxToolSteps,
    perTurnTokenBudget: row.perTurnTokenBudget,
    dailyTokenBudget: row.dailyTokenBudget,
    createdAt: row.createdAt.toISOString(),
    tokensThisCycle: counters?.tokens ?? 0,
    conversations: row._count.conversations,
    channels: row._count.integrations,
    lastRunAt: counters?.lastRunAt ? counters.lastRunAt.toISOString() : null,
  };
}

/** Ledger totals for the current cycle, keyed by agent. */
async function agentCounters(db: PrismaClient, tenantId: string, since: Date): Promise<Map<string, AgentCounters>> {
  const grouped = await db.usageEvent.groupBy({
    by: ["agentId"],
    where: scoped(tenantId, { createdAt: { gte: since } }),
    _sum: { tokensUsed: true },
    _max: { createdAt: true },
  });
  const out = new Map<string, AgentCounters>();
  for (const row of grouped) {
    if (!row.agentId) continue;
    out.set(row.agentId, { tokens: row._sum.tokensUsed ?? 0, lastRunAt: row._max.createdAt ?? null });
  }
  return out;
}

async function agentRows(
  db: PrismaClient,
  where: Record<string, unknown>,
  tenantId: string,
  since: Date,
): Promise<AgentDto[]> {
  const [rows, counters] = await Promise.all([
    db.agent.findMany({ where, orderBy: { createdAt: "desc" }, select: agentSelect }),
    agentCounters(db, tenantId, since),
  ]);
  return rows.map((row) => agentView(row, counters.get(row.id)));
}

export async function listAgents(db: PrismaClient, tenantId: string): Promise<AgentDto[]> {
  const tenant = await loadTenant(db, tenantId);
  return agentRows(db, scoped(tenantId, {}), tenantId, cycleStart(tenant.cycleResetAt));
}

/** The same rows, narrowed to one project. Both scope clauses are always carried. */
export async function listProjectAgents(
  db: PrismaClient,
  tenantId: string,
  projectId: string,
): Promise<AgentDto[]> {
  const tenant = await loadTenant(db, tenantId);
  return agentRows(db, projectWhere(tenantId, projectId, {}), tenantId, cycleStart(tenant.cycleResetAt));
}

export async function getAgent(db: PrismaClient, tenantId: string, agentId: string): Promise<AgentDto | null> {
  const tenant = await loadTenant(db, tenantId);
  const row = await db.agent.findFirst({ where: scoped(tenantId, { id: agentId }), select: agentSelect });
  if (!row) return null;
  const counters = await agentCounters(db, tenantId, cycleStart(tenant.cycleResetAt));
  return agentView(row, counters.get(row.id));
}

const integrationSelect = {
  id: true,
  tenantId: true,
  projectId: true,
  type: true,
  externalId: true,
  status: true,
  createdAt: true,
  credentialsEncrypted: true,
  agents: { select: { direction: true, agent: { select: { id: true, name: true } } } },
} satisfies Prisma.IntegrationSelect;

type IntegrationRow = Prisma.IntegrationGetPayload<{ select: typeof integrationSelect }>;

/**
 * The ciphertext is read only to produce a masked preview. A blob that fails
 * authentication (rotated key, tampered row) reports no preview rather than a
 * guessed one — and never the raw value.
 */
function integrationView(row: IntegrationRow, keyring: Keyring): IntegrationDto {
  let credentialPreview: string | null = null;
  try {
    credentialPreview = maskSecret(keyring.decrypt(row.credentialsEncrypted));
  } catch {
    credentialPreview = null;
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    type: row.type,
    externalId: row.externalId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    credentialPreview,
    bindings: row.agents.map((binding) => ({
      agentId: binding.agent.id,
      agentName: binding.agent.name,
      direction: binding.direction,
    })),
  };
}

async function integrationRows(db: PrismaClient, where: Record<string, unknown>, keyring: Keyring): Promise<IntegrationDto[]> {
  const rows = await db.integration.findMany({ where, orderBy: { createdAt: "desc" }, select: integrationSelect });
  return rows.map((row) => integrationView(row, keyring));
}

export async function listIntegrations(db: PrismaClient, tenantId: string, keyring: Keyring): Promise<IntegrationDto[]> {
  return integrationRows(db, scoped(tenantId, {}), keyring);
}

export async function listProjectIntegrations(
  db: PrismaClient,
  tenantId: string,
  projectId: string,
  keyring: Keyring,
): Promise<IntegrationDto[]> {
  return integrationRows(db, projectWhere(tenantId, projectId, {}), keyring);
}

const projectSelect = {
  id: true,
  tenantId: true,
  name: true,
  description: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { agents: true, integrations: true, workflows: true } },
} satisfies Prisma.ProjectSelect;

type ProjectRow = Prisma.ProjectGetPayload<{ select: typeof projectSelect }>;

function projectView(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    counts: {
      agents: row._count.agents,
      integrations: row._count.integrations,
      workflows: row._count.workflows,
    },
  };
}

export async function listProjects(db: PrismaClient, tenantId: string): Promise<ProjectDto[]> {
  const rows = await db.project.findMany({
    where: scoped(tenantId, {}),
    orderBy: { createdAt: "asc" },
    select: projectSelect,
  });
  return rows.map(projectView);
}

export async function getProject(db: PrismaClient, tenantId: string, projectId: string): Promise<ProjectDto | null> {
  const row = await db.project.findFirst({ where: scoped(tenantId, { id: projectId }), select: projectSelect });
  return row ? projectView(row) : null;
}

const workflowSummarySelect = {
  id: true,
  projectId: true,
  name: true,
  description: true,
  status: true,
  version: true,
  updatedAt: true,
} satisfies Prisma.WorkflowSelect;

type WorkflowSummaryRow = Prisma.WorkflowGetPayload<{ select: typeof workflowSummarySelect }>;

function workflowSummaryView(row: WorkflowSummaryRow): WorkflowSummaryDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    status: row.status,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Real rows from `Workflow` — empty until the builder can save a graph. */
export async function listProjectWorkflows(
  db: PrismaClient,
  tenantId: string,
  projectId: string,
): Promise<WorkflowSummaryDto[]> {
  const rows = await db.workflow.findMany({
    where: projectWhere(tenantId, projectId, {}),
    orderBy: { updatedAt: "desc" },
    select: workflowSummarySelect,
  });
  return rows.map(workflowSummaryView);
}

const workflowSelect = {
  id: true,
  tenantId: true,
  projectId: true,
  name: true,
  description: true,
  status: true,
  version: true,
  definition: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { name: true } },
  dependencies: { select: { kind: true, refId: true }, orderBy: [{ kind: "asc" }, { refId: "asc" }] },
} satisfies Prisma.WorkflowSelect;

type WorkflowRow = Prisma.WorkflowGetPayload<{ select: typeof workflowSelect }>;

/**
 * `refId` has no foreign key, so the name behind it is looked up here and may
 * legitimately be missing. A `null` name is the console's cue to say
 * "deleted" — dropping the row instead would hide a reference the graph still
 * carries and that validation is reporting on.
 */
function workflowView(row: WorkflowRow, names: Map<string, string>): WorkflowDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    projectId: row.projectId,
    projectName: row.project.name,
    name: row.name,
    description: row.description,
    status: row.status,
    version: row.version,
    // Only a graph that passed `readGraph` can have been written, so the column
    // is a definition; nothing here invents nodes to make that true.
    definition: row.definition as unknown as GraphDefinition,
    dependencies: row.dependencies.map((dep) => ({ ...dep, name: names.get(`${dep.kind}:${dep.refId}`) ?? null })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getWorkflow(db: PrismaClient, tenantId: string, workflowId: string): Promise<WorkflowDto | null> {
  const row = await db.workflow.findFirst({ where: scoped(tenantId, { id: workflowId }), select: workflowSelect });
  if (!row) return null;
  const names = await dependencyNames(db, tenantId);
  return workflowView(row, names);
}

async function dependencyNames(db: PrismaClient, tenantId: string): Promise<Map<string, string>> {
  const [agents, integrations] = await Promise.all([
    db.agent.findMany({ where: scoped(tenantId, {}), select: { id: true, name: true } }),
    db.integration.findMany({ where: scoped(tenantId, {}), select: { id: true, type: true, externalId: true } }),
  ]);
  return new Map([
    ...agents.map((agent) => [`AGENT:${agent.id}`, agent.name] as const),
    ...integrations.map((row) => [`INTEGRATION:${row.id}`, row.externalId ? `${row.type} · ${row.externalId}` : row.type] as const),
  ]);
}

const nodeRunSelect = {
  nodeKey: true,
  kind: true,
  label: true,
  refId: true,
  status: true,
  attempt: true,
  input: true,
  output: true,
  error: true,
  tokensUsed: true,
  trace: true,
  durationMs: true,
  startedAt: true,
  finishedAt: true,
} satisfies Prisma.WorkflowNodeRunSelect;

type NodeRunRow = Prisma.WorkflowNodeRunGetPayload<{ select: typeof nodeRunSelect }>;

function nodeRunView(row: NodeRunRow): WorkflowNodeRunDto {
  return {
    nodeKey: row.nodeKey,
    kind: row.kind,
    label: row.label,
    refId: row.refId,
    status: row.status,
    attempt: row.attempt,
    input: row.input,
    output: row.output,
    error: row.error,
    tokensUsed: row.tokensUsed,
    // A node that ran before the trace column existed reads as "no tool calls",
    // which is exactly what it did.
    trace: Array.isArray(row.trace) ? (row.trace as unknown as AgentTraceStepDto[]) : [],
    durationMs: row.durationMs,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

const runSelect = {
  id: true,
  workflowId: true,
  workflowName: true,
  workflowVersion: true,
  status: true,
  triggerSource: true,
  input: true,
  output: true,
  error: true,
  tokensUsed: true,
  durationMs: true,
  startedAt: true,
  finishedAt: true,
} satisfies Prisma.WorkflowRunSelect;

type RunRow = Prisma.WorkflowRunGetPayload<{ select: typeof runSelect }>;

function runView(row: RunRow, nodes?: WorkflowNodeRunDto[]): WorkflowRunSummaryDto {
  return {
    id: row.id,
    workflowId: row.workflowId,
    workflowName: row.workflowName,
    workflowVersion: row.workflowVersion,
    status: row.status,
    triggerSource: row.triggerSource,
    input: row.input,
    output: row.output,
    error: row.error,
    tokensUsed: row.tokensUsed,
    durationMs: row.durationMs,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    ...(nodes === undefined ? {} : { nodes }),
  };
}

/** Newest first, without the node rows: a list of twenty runs is not twenty queries. */
export async function listWorkflowRuns(
  db: PrismaClient,
  tenantId: string,
  workflowId: string,
  take = 20,
): Promise<WorkflowRunSummaryDto[]> {
  const rows = await db.workflowRun.findMany({
    where: scoped(tenantId, { workflowId }),
    orderBy: { startedAt: "desc" },
    take,
    select: runSelect,
  });
  return rows.map((row) => runView(row));
}

export async function getWorkflowRun(db: PrismaClient, tenantId: string, runId: string): Promise<WorkflowRunSummaryDto | null> {
  const row = await db.workflowRun.findFirst({ where: scoped(tenantId, { id: runId }), select: runSelect });
  if (!row) return null;
  const nodes = await db.workflowNodeRun.findMany({
    where: { runId },
    orderBy: { startedAt: "asc" },
    select: nodeRunSelect,
  });
  return runView(row, nodes.map(nodeRunView));
}

const agentRunSelect = {
  id: true,
  projectId: true,
  agentId: true,
  agentName: true,
  triggerSource: true,
  status: true,
  conversationId: true,
  externalChatId: true,
  input: true,
  output: true,
  error: true,
  tokensUsed: true,
  stepCount: true,
  toolCallCount: true,
  durationMs: true,
  startedAt: true,
  finishedAt: true,
} satisfies Prisma.AgentRunSelect;

type AgentRunRow = Prisma.AgentRunGetPayload<{ select: typeof agentRunSelect }>;

function agentRunView(row: AgentRunRow): AgentRunDto {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    agentName: row.agentName,
    triggerSource: row.triggerSource,
    status: row.status,
    conversationId: row.conversationId,
    externalChatId: row.externalChatId,
    input: row.input,
    output: row.output,
    error: row.error,
    tokensUsed: row.tokensUsed,
    stepCount: row.stepCount,
    toolCallCount: row.toolCallCount,
    durationMs: row.durationMs,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

const agentRunStepSelect = {
  id: true,
  seq: true,
  round: true,
  kind: true,
  tool: true,
  argsPreview: true,
  resultPreview: true,
  ok: true,
  inputTokens: true,
  outputTokens: true,
  durationMs: true,
  createdAt: true,
} satisfies Prisma.AgentRunStepSelect;

type AgentRunStepRow = Prisma.AgentRunStepGetPayload<{ select: typeof agentRunStepSelect }>;

function agentRunStepView(row: AgentRunStepRow): AgentRunStepDto {
  return {
    id: row.id,
    seq: row.seq,
    round: row.round,
    kind: row.kind,
    tool: row.tool,
    argsPreview: row.argsPreview,
    resultPreview: row.resultPreview,
    ok: row.ok,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Newest first. `before` pages with the `startedAt` of the last row already shown. */
export async function listAgentRuns(
  db: PrismaClient,
  tenantId: string,
  opts: { agentId?: string; status?: RunStatus; limit: number; before?: Date },
): Promise<AgentRunDto[]> {
  const rows = await db.agentRun.findMany({
    where: scoped(tenantId, {
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.before ? { startedAt: { lt: opts.before } } : {}),
    }),
    orderBy: { startedAt: "desc" },
    take: opts.limit,
    select: agentRunSelect,
  });
  return rows.map(agentRunView);
}

export async function getAgentRun(
  db: PrismaClient,
  tenantId: string,
  runId: string,
): Promise<AgentRunDetailDto | null> {
  const row = await db.agentRun.findFirst({
    where: scoped(tenantId, { id: runId }),
    // `capability` is only carried on the detail read: it is the assembled
    // snapshot the turn ran with, and a list of twenty runs has no business
    // shipping twenty prompts.
    select: { ...agentRunSelect, capability: true, capabilityHash: true },
  });
  if (!row) return null;
  const steps = await db.agentRunStep.findMany({
    where: { runId },
    orderBy: { seq: "asc" },
    select: agentRunStepSelect,
  });
  return {
    ...agentRunView(row),
    steps: steps.map(agentRunStepView),
    capability: (row.capability as unknown as CapabilitySnapshot | null) ?? null,
    capabilityHash: row.capabilityHash,
  };
}

/**
 * Tenant-wide workflow runs, newest first. The workflow name comes from the
 * run's own snapshot, so a renamed or deleted workflow still reads truthfully.
 */
export async function listWorkflowRunsTenant(
  db: PrismaClient,
  tenantId: string,
  opts: { workflowId?: string; status?: RunStatus; limit: number },
): Promise<WorkflowRunSummaryDto[]> {
  const rows = await db.workflowRun.findMany({
    where: scoped(tenantId, {
      ...(opts.workflowId ? { workflowId: opts.workflowId } : {}),
      ...(opts.status ? { status: opts.status } : {}),
    }),
    orderBy: { startedAt: "desc" },
    take: opts.limit,
    select: runSelect,
  });
  const workflowIds = [...new Set(rows.map((row) => row.workflowId))];
  const workflows = workflowIds.length
    ? await db.workflow.findMany({
        where: scoped(tenantId, { id: { in: workflowIds } }),
        select: { id: true, projectId: true },
      })
    : [];
  const projectByWorkflow = new Map(workflows.map((row) => [row.id, row.projectId]));
  return rows.map((row) => ({
    ...runView(row),
    projectId: projectByWorkflow.get(row.workflowId) ?? null,
  }));
}

function agentStatusesFor(status: ActivityStatus | undefined): RunStatus | "ALL" | "NONE" {
  if (status === undefined) return "ALL";
  if (status === "RUNNING" || status === "SUCCEEDED" || status === "FAILED" || status === "BLOCKED") return status;
  return "NONE";
}

function nodeStatusesFor(status: ActivityStatus | undefined): NodeRunStatus | "ALL" | "NONE" {
  if (status === undefined) return "ALL";
  if (status === "PENDING" || status === "RUNNING" || status === "SUCCEEDED" || status === "FAILED" || status === "SKIPPED") {
    return status;
  }
  return "NONE";
}

/**
 * The merged feed: direct agent turns plus the AGENT/ORCHESTRATOR nodes of
 * workflow runs, ordered by when they started. Names and project ids are
 * resolved in bulk here — a feed of thirty rows is not thirty extra queries.
 */
export async function listActivity(
  db: PrismaClient,
  tenantId: string,
  opts: { agentId?: string; status?: ActivityStatus; limit: number },
): Promise<ActivityItemDto[]> {
  // One extra row proves the merged list was truncated by the limit rather than
  // by an empty side, but the extra never leaves the server.
  const take = opts.limit + 1;
  const wantedAgentStatus = agentStatusesFor(opts.status);
  const wantedNodeStatus = nodeStatusesFor(opts.status);

  const [agentRows, nodeRows] = await Promise.all([
    wantedAgentStatus === "NONE"
      ? Promise.resolve([])
      : db.agentRun.findMany({
          where: scoped(tenantId, {
            ...(opts.agentId ? { agentId: opts.agentId } : {}),
            ...(wantedAgentStatus === "ALL" ? {} : { status: wantedAgentStatus }),
          }),
          orderBy: { startedAt: "desc" },
          take,
          select: agentRunSelect,
        }),
    wantedNodeStatus === "NONE"
      ? Promise.resolve([])
      : db.workflowNodeRun.findMany({
          where: {
            tenantId,
            kind: { in: ["AGENT", "ORCHESTRATOR"] },
            ...(opts.agentId ? { refId: opts.agentId } : {}),
            ...(wantedNodeStatus === "ALL" ? {} : { status: wantedNodeStatus }),
          },
          orderBy: { startedAt: "desc" },
          take,
          select: {
            id: true,
            runId: true,
            nodeKey: true,
            kind: true,
            label: true,
            refId: true,
            status: true,
            input: true,
            output: true,
            tokensUsed: true,
            durationMs: true,
            startedAt: true,
            finishedAt: true,
            run: { select: { workflowId: true, workflowName: true } },
          },
        }),
  ]);

  const workflowIds = [...new Set(nodeRows.map((row) => row.run.workflowId))];
  const agentIds = [
    ...new Set([
      ...agentRows.map((row) => row.agentId),
      ...nodeRows.map((row) => row.refId).filter((id): id is string => Boolean(id)),
    ]),
  ];
  const [workflows, agents] = await Promise.all([
    workflowIds.length
      ? db.workflow.findMany({
          where: scoped(tenantId, { id: { in: workflowIds } }),
          select: { id: true, projectId: true, name: true },
        })
      : Promise.resolve([]),
    agentIds.length
      ? db.agent.findMany({ where: scoped(tenantId, { id: { in: agentIds } }), select: { id: true, name: true } })
      : Promise.resolve([]),
  ]);
  const workflowById = new Map(workflows.map((row) => [row.id, row]));
  const agentNameById = new Map(agents.map((row) => [row.id, row.name]));

  const items: ActivityItemDto[] = [
    ...agentRows.map((row): ActivityItemDto => ({
      id: row.id,
      source: "AGENT_RUN",
      status: row.status,
      agentId: row.agentId,
      // The run's own snapshot, not today's name: the row records what ran.
      agentName: row.agentName,
      projectId: row.projectId,
      workflowId: null,
      workflowName: null,
      workflowRunId: null,
      nodeKey: null,
      nodeLabel: null,
      inputPreview: preview(row.input),
      outputPreview: row.output === null ? null : preview(row.output),
      tokensUsed: row.tokensUsed,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      durationMs: row.durationMs,
    })),
    ...nodeRows.map((row): ActivityItemDto => {
      const workflow = workflowById.get(row.run.workflowId);
      return {
        id: row.id,
        source: "WORKFLOW_NODE",
        status: row.status,
        agentId: row.kind === "AGENT" ? row.refId : null,
        agentName: row.kind === "AGENT" && row.refId ? agentNameById.get(row.refId) ?? null : null,
        projectId: workflow?.projectId ?? null,
        workflowId: row.run.workflowId,
        workflowName: row.run.workflowName ?? workflow?.name ?? null,
        workflowRunId: row.runId,
        nodeKey: row.nodeKey,
        nodeLabel: row.label,
        inputPreview: row.input === null ? "" : preview(row.input),
        outputPreview: row.output === null ? null : preview(row.output),
        tokensUsed: row.tokensUsed,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
        durationMs: row.durationMs,
      };
    }),
  ];

  items.sort((a, b) => (a.startedAt === b.startedAt ? 0 : a.startedAt < b.startedAt ? 1 : -1));
  return items.slice(0, opts.limit);
}

export async function listAgentBindings(
  db: PrismaClient,
  tenantId: string,
  agentId: string,
  keyring: Keyring,
): Promise<Array<{ integration: IntegrationDto; direction: "INPUT" | "OUTPUT" }>> {
  const rows = await db.agentIntegration.findMany({
    where: { agentId, agent: { tenantId }, integration: { tenantId } },
    select: {
      direction: true,
      // Same projection as `listIntegrations`, so a binding and a row in the
      // connections list can never disagree about what they describe.
      integration: { select: integrationSelect },
    },
  });
  return rows.map((row) => ({ integration: integrationView(row.integration, keyring), direction: row.direction }));
}

export async function conversationViews(
  db: PrismaClient,
  tenantId: string,
  where: Record<string, unknown>,
  take?: number,
): Promise<ConversationDto[]> {
  const rows = await db.conversation.findMany({
    where: scoped(tenantId, where),
    orderBy: { updatedAt: "desc" },
    ...(take ? { take } : {}),
    select: {
      id: true,
      tenantId: true,
      agentId: true,
      externalChatId: true,
      createdAt: true,
      updatedAt: true,
      agent: { select: { name: true } },
      _count: { select: { messages: true } },
    },
  });
  if (rows.length === 0) return [];

  // Newest message per thread, from real rows — no summarising or rewording.
  const ids = rows.map((row) => row.id);
  const messages = await db.conversationMessage.findMany({
    where: scoped(tenantId, { conversationId: { in: ids } }),
    orderBy: { createdAt: "desc" },
    select: { conversationId: true, content: true, role: true },
  });
  const latest = new Map<string, { content: string; role: MessageDto["role"] }>();
  for (const message of messages) {
    if (!latest.has(message.conversationId)) latest.set(message.conversationId, { content: message.content, role: message.role });
  }

  return rows.map((row) => {
    const last = latest.get(row.id);
    return {
      id: row.id,
      tenantId: row.tenantId,
      agentId: row.agentId,
      agentName: row.agent.name,
      externalChatId: row.externalChatId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      messageCount: row._count.messages,
      lastMessagePreview: last ? preview(last.content) : "",
      lastMessageRole: last?.role ?? null,
    };
  });
}

export async function listConversations(db: PrismaClient, tenantId: string, agentId?: string): Promise<ConversationDto[]> {
  return conversationViews(db, tenantId, agentId ? { agentId } : {});
}

export async function listMessages(db: PrismaClient, tenantId: string, conversationId: string): Promise<MessageDto[]> {
  const rows = await db.conversationMessage.findMany({
    where: scoped(tenantId, { conversationId }),
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, content: true, inputTokens: true, outputTokens: true, createdAt: true },
  });
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function listUsage(db: PrismaClient, tenantId: string, take = 200): Promise<UsageEventDto[]> {
  const rows = await db.usageEvent.findMany({
    where: scoped(tenantId, {}),
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      tenantId: true,
      agentId: true,
      kind: true,
      tokensUsed: true,
      costUsdEstimate: true,
      metadata: true,
      createdAt: true,
    },
  });

  // UsageEvent keeps a plain agentId column (the ledger outlives the agent),
  // so names are resolved here rather than through a relation.
  const ids = [...new Set(rows.map((row) => row.agentId).filter((id): id is string => Boolean(id)))];
  const agents = ids.length
    ? await db.agent.findMany({ where: scoped(tenantId, { id: { in: ids } }), select: { id: true, name: true } })
    : [];
  const nameById = new Map(agents.map((agent) => [agent.id, agent.name]));

  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenantId,
    agentId: row.agentId,
    agentName: row.agentId ? nameById.get(row.agentId) ?? null : null,
    kind: row.kind,
    tokensUsed: row.tokensUsed,
    costUsdEstimate: Number(row.costUsdEstimate),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function listWebhookEvents(db: PrismaClient, tenantId: string, take = 200): Promise<WebhookEventDto[]> {
  const rows = await db.webhookEventLog.findMany({ where: { tenantId }, orderBy: { receivedAt: "desc" }, take });
  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    externalMessageId: row.externalMessageId,
    status: row.status,
    receivedAt: row.receivedAt.toISOString(),
    processedAt: row.processedAt ? row.processedAt.toISOString() : null,
  }));
}

export async function readTenant(db: PrismaClient, tenantId: string): Promise<TenantDto> {
  return tenantView(await loadTenant(db, tenantId));
}

export async function listPlans(db: PrismaClient): Promise<PlanDto[]> {
  const rows = await db.plan.findMany({ orderBy: { monthlyPriceUsd: "asc" } });
  return rows.map(planView);
}

const DAILY_DAYS = 14;

interface DailyRow {
  date: string;
  tokens: number;
  calls: number;
}

async function dailyPoints(db: PrismaClient, tenantId: string, since: Date): Promise<DailyPointDto[]> {
  const rows = await db.$queryRaw<DailyRow[]>(
    Prisma.sql`SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS date,
                       COALESCE(SUM("tokensUsed"), 0)::int AS tokens,
                       COUNT(*)::int AS calls
                FROM "UsageEvent"
                WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${since}
                GROUP BY 1
                ORDER BY 1`,
  );
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const out: DailyPointDto[] = [];
  const first = startOfUtcDay(since);
  for (let offset = 0; offset < DAILY_DAYS; offset += 1) {
    const day = new Date(first.getTime() + offset * DAY_MS);
    const key = day.toISOString().slice(0, 10);
    const hit = byDate.get(key);
    out.push({ date: key, tokens: hit?.tokens ?? 0, calls: hit?.calls ?? 0 });
  }
  return out;
}

export async function readOverview(db: PrismaClient, tenantId: string): Promise<OverviewDto> {
  const tenant = await loadTenant(db, tenantId);
  const since = cycleStart(tenant.cycleResetAt);
  const today = startOfUtcDay(new Date());
  const dailySince = new Date(today.getTime() - (DAILY_DAYS - 1) * DAY_MS);

  const [agentStatuses, integrationStatuses, totals, messagesToday, recentConversations, recentUsage, failingEvents, daily] =
    await Promise.all([
      db.agent.groupBy({ by: ["status"], where: scoped(tenantId, {}), _count: { _all: true } }),
      db.integration.groupBy({ by: ["status"], where: scoped(tenantId, {}), _count: { _all: true } }),
      db.usageEvent.aggregate({ where: scoped(tenantId, { createdAt: { gte: since } }), _sum: { tokensUsed: true, costUsdEstimate: true } }),
      db.conversationMessage.count({ where: scoped(tenantId, { createdAt: { gte: today } }) }),
      conversationViews(db, tenantId, {}, 5),
      listUsage(db, tenantId, 8),
      db.webhookEventLog.findMany({ where: { tenantId, status: { in: ["FAILED", "DEAD"] } }, orderBy: { receivedAt: "desc" }, take: 10 }),
      dailyPoints(db, tenantId, dailySince),
    ]);

  const count = <T extends { status: string; _count: { _all: number } }>(groups: T[], status: string): number =>
    groups.find((group) => group.status === status)?._count._all ?? 0;

  const agentsTotal = agentStatuses.reduce((sum, group) => sum + group._count._all, 0);
  const integrationsTotal = integrationStatuses.reduce((sum, group) => sum + group._count._all, 0);

  return {
    tenant: tenantView(tenant),
    plan: planView(tenant.plan),
    agents: { total: agentsTotal, active: count(agentStatuses, "ACTIVE"), error: count(agentStatuses, "ERROR") },
    integrations: { total: integrationsTotal, connected: count(integrationStatuses, "CONNECTED"), limit: tenant.plan.maxIntegrations },
    tokensUsedThisCycle: totals._sum.tokensUsed ?? 0,
    tokensRemaining: Number(tenant.tokenBalance),
    messagesToday,
    costThisCycleUsd: Number(totals._sum.costUsdEstimate ?? 0),
    daily,
    recentConversations,
    recentUsage,
    failingEvents: failingEvents.map((row) => ({
      id: row.id,
      source: row.source,
      externalMessageId: row.externalMessageId,
      status: row.status,
      receivedAt: row.receivedAt.toISOString(),
      processedAt: row.processedAt ? row.processedAt.toISOString() : null,
    })),
  };
}
