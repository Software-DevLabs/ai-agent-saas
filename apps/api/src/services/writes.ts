import { Prisma, type PrismaClient } from "@prisma/client";
import {
  GRAPH_LANE,
  dependenciesOf,
  inspectWorkflow,
  prepareRun,
  readGraph,
  type GraphDefinition,
  type GraphIssue,
  type OrchestratorNode,
  type Queue,
} from "@saas/core";
import { defaultProjectId, tenantWhere } from "@saas/db";
import { registeredProviders } from "@saas/providers";
import type { Keyring } from "@saas/shared";
import { badRequest, conflict, notFound } from "../http-error.ts";
import { getAgent, getProject, getWorkflow, listAgentBindings, listIntegrations, readTenant } from "./reads.ts";
import { activeWorkflowUsing, projectContents, requireProject, requireWorkflow } from "./scope.ts";
import type {
  AgentDto,
  IntegrationDto,
  ProjectDto,
  WorkflowDto,
  WorkflowValidationDto,
  TenantDto,
} from "../dto.ts";

/**
 * Writes are where a console usually leaks: a PATCH that accepts `tenantId`
 * lets one workspace rename another's agent. Nothing here trusts the body for
 * identity — the row is looked up under the session tenant first, and the
 * mutation then applies to that id alone.
 */

/**
 * Every agent and connection belongs to a project, and the project column is
 * NOT NULL with a real foreign key. A tenant created after the `add_project`
 * migration has no project row of its own, so the deterministic default from
 * that backfill is created on demand here rather than assumed to exist.
 */
async function ensureDefaultProject(db: PrismaClient, tenantId: string): Promise<string> {
  const id = defaultProjectId(tenantId);
  await db.project.upsert({ where: { id }, update: {}, create: { id, tenantId, name: "Default", isDefault: true } });
  return id;
}

async function requireAgent(db: PrismaClient, tenantId: string, id: string): Promise<{ id: string; projectId: string }> {
  const row = await db.agent.findFirst({
    where: tenantWhere(tenantId, { id }),
    select: { id: true, projectId: true },
  });
  if (!row) throw notFound("agent_not_found", `agent ${id} is not in this tenant`);
  return row;
}

async function requireIntegration(db: PrismaClient, tenantId: string, id: string): Promise<void> {
  const row = await db.integration.findFirst({ where: tenantWhere(tenantId, { id }), select: { id: true } });
  if (!row) throw notFound("integration_not_found", `integration ${id} is not in this tenant`);
}

export interface ProjectInput {
  name: string;
  description?: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * A project is created with `isDefault: false`, always. The default row is
 * produced by the migration backfill and by `ensureDefaultProject`, and if a
 * user could mint a second one the label would stop meaning anything.
 */
export async function createProject(
  db: PrismaClient,
  tenantId: string,
  input: ProjectInput,
): Promise<ProjectDto | null> {
  try {
    const created = await db.project.create({
      data: { tenantId, name: input.name, description: input.description ?? null },
      select: { id: true },
    });
    return getProject(db, tenantId, created.id);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("project_name_taken", `this tenant already has a project named "${input.name}"`, {
        name: input.name,
      });
    }
    throw error;
  }
}

export async function updateProject(
  db: PrismaClient,
  tenantId: string,
  projectId: string,
  input: Partial<ProjectInput>,
): Promise<ProjectDto | null> {
  await requireProject(db, tenantId, projectId);
  try {
    await db.project.update({
      where: { id: projectId },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("project_name_taken", `this tenant already has a project named "${input.name}"`, {
        name: input.name,
      });
    }
    throw error;
  }
  return getProject(db, tenantId, projectId);
}

/**
 * Refuses rather than cascades, and that is the point: the schema puts
 * `onDelete: Restrict` on Agent and Integration for exactly this reason, so
 * tidying a folder cannot silently destroy a live agent's message history.
 * Emptying a project means moving or deleting its contents on purpose — which
 * v1 does not offer across projects, so in practice it means deleting them.
 */
export async function deleteProject(db: PrismaClient, tenantId: string, projectId: string): Promise<void> {
  const project = await requireProject(db, tenantId, projectId);
  const counts = await projectContents(db, tenantId, project.id);
  if (counts.agents > 0 || counts.integrations > 0 || counts.workflows > 0) {
    throw conflict(
      "project_not_empty",
      `"${project.name}" still holds ${counts.agents} agent(s), ${counts.integrations} connection(s) and ${counts.workflows} workflow(s)`,
      counts,
    );
  }
  try {
    await db.project.delete({ where: { id: project.id } });
  } catch (error) {
    // A row created between the count and the delete is caught by the
    // RESTRICT constraint; report it as the same refusal, not as a 500.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      throw conflict("project_not_empty", `"${project.name}" is not empty`, {});
    }
    throw error;
  }
}

export interface AgentInput {
  name: string;
  systemPrompt: string;
  modelProvider: string;
  modelName: string;
  temperature: number;
  maxOutputTokens: number;
  /**
   * The project the agent is created inside. Absent means the tenant's default,
   * so an older caller keeps working; a supplied id goes through the ownership
   * guard and therefore cannot be another tenant's project.
   */
  projectId?: string;
  /** Cost ceilings. `0` on either budget means "the plan balance is the only cap". */
  maxToolSteps?: number;
  perTurnTokenBudget?: number;
  dailyTokenBudget?: number;
}

type AgentModelFields = Pick<AgentInput, "modelProvider" | "modelName" | "temperature" | "maxOutputTokens">;

function validateAgent(input: AgentModelFields): void {
  // The registry is the only source of truth. A typo'd provider would otherwise
  // be saved and then fail on every single inbound message.
  if (!registeredProviders().includes(input.modelProvider)) {
    throw badRequest("unknown_provider", `provider "${input.modelProvider}" is not registered`, {
      registered: registeredProviders(),
    });
  }
  if (input.maxOutputTokens < 1 || input.maxOutputTokens > 32_000) {
    throw badRequest("max_output_tokens", "maxOutputTokens must be between 1 and 32000");
  }
}

export async function createAgent(db: PrismaClient, tenantId: string, input: AgentInput): Promise<AgentDto | null> {
  validateAgent(input);
  const projectId = input.projectId
    ? (await requireProject(db, tenantId, input.projectId)).id
    : await ensureDefaultProject(db, tenantId);
  const created = await db.agent.create({
    data: {
      tenantId,
      projectId,
      // A new agent is a draft: the playground answers it (that is how it gets
      // written), but a public surface refuses it until the operator activates
      // it. The column default stays ACTIVE for the rows that predate DRAFT.
      status: "DRAFT",
      name: input.name,
      systemPrompt: input.systemPrompt,
      modelProvider: input.modelProvider,
      modelName: input.modelName,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      ...(input.maxToolSteps === undefined ? {} : { maxToolSteps: input.maxToolSteps }),
      ...(input.perTurnTokenBudget === undefined ? {} : { perTurnTokenBudget: input.perTurnTokenBudget }),
      ...(input.dailyTokenBudget === undefined ? {} : { dailyTokenBudget: input.dailyTokenBudget }),
    },
    select: { id: true },
  });
  return getAgent(db, tenantId, created.id);
}

export async function updateAgent(
  db: PrismaClient,
  tenantId: string,
  agentId: string,
  input: Partial<AgentInput>,
): Promise<AgentDto | null> {
  const current = await db.agent.findFirst({
    where: tenantWhere(tenantId, { id: agentId }),
    select: { modelProvider: true, modelName: true, temperature: true, maxOutputTokens: true },
  });
  if (!current) throw notFound("agent_not_found", `agent ${agentId} is not in this tenant`);

  validateAgent({
    modelProvider: input.modelProvider ?? current.modelProvider,
    modelName: input.modelName ?? current.modelName,
    temperature: input.temperature ?? current.temperature,
    maxOutputTokens: input.maxOutputTokens ?? current.maxOutputTokens,
  });
  await db.agent.update({
    where: { id: agentId },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
      ...(input.modelProvider === undefined ? {} : { modelProvider: input.modelProvider }),
      ...(input.modelName === undefined ? {} : { modelName: input.modelName }),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
      ...(input.maxToolSteps === undefined ? {} : { maxToolSteps: input.maxToolSteps }),
      ...(input.perTurnTokenBudget === undefined ? {} : { perTurnTokenBudget: input.perTurnTokenBudget }),
      ...(input.dailyTokenBudget === undefined ? {} : { dailyTokenBudget: input.dailyTokenBudget }),
    },
  });
  return getAgent(db, tenantId, agentId);
}

export async function setAgentStatus(
  db: PrismaClient,
  tenantId: string,
  agentId: string,
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "ERROR",
): Promise<AgentDto | null> {
  await requireAgent(db, tenantId, agentId);
  await db.agent.update({ where: { id: agentId }, data: { status } });
  return getAgent(db, tenantId, agentId);
}

export async function deleteAgent(db: PrismaClient, tenantId: string, agentId: string): Promise<void> {
  await requireAgent(db, tenantId, agentId);
  // The graph keeps a dangling reference rather than a foreign key, so nothing
  // here would stop the delete at the database level. A running workflow losing
  // its agent between one message and the next is the failure this refuses.
  // DRAFT and PAUSED graphs may dangle: validation reports it, activation
  // refuses it, and the user keeps the freedom to tidy up in either order.
  const claimer = await activeWorkflowUsing(db, tenantId, "AGENT", agentId);
  if (claimer) {
    throw conflict("agent_in_active_workflow", `${claimer.name} is active and uses this agent — pause it first`, {
      workflowId: claimer.id,
      workflowName: claimer.name,
    });
  }
  // Threads and messages go with the agent through the schema's cascades.
  // UsageEvent rows stay: agentId is nullable precisely so the ledger survives
  // a deletion and reconciliation can still be audited afterwards.
  await db.agent.delete({ where: { id: agentId } });
}

export interface IntegrationInput {
  type: "TELEGRAM_IN" | "WHATSAPP_IN" | "SHEETS_OUT" | "DRIVE_OUT" | "WEBHOOK_OUT";
  credentials: string;
  externalId?: string | null;
  /**
   * The project the connection belongs to. Absent means the tenant's default,
   * because a connection created before projects existed has to land somewhere
   * — but a supplied id is resolved through `requireProject`, so it can only
   * ever be a project this tenant owns.
   */
  projectId?: string;
  /** Optional: bind to an agent in this tenant as the connection is created. */
  agentId?: string;
  agentDirection?: "INPUT" | "OUTPUT";
}

export async function createIntegration(
  db: PrismaClient,
  tenantId: string,
  input: IntegrationInput,
  keyring: Keyring,
): Promise<IntegrationDto | null> {
  const tenant = await readTenant(db, tenantId);
  const plan = await db.plan.findFirstOrThrow({ where: { id: tenant.planId }, select: { maxIntegrations: true } });
  // Deliberately counted across the whole tenant, not per project: a per-project
  // limit would turn the Free plan's 2 into 2 x number-of-projects, which is a
  // plan upgrade nobody asked for.
  const existing = await db.integration.count({ where: { tenantId } });
  if (existing >= plan.maxIntegrations) {
    throw conflict(
      "integration_limit",
      `${tenant.planName} plan allows ${plan.maxIntegrations} connection(s)`,
      { limit: plan.maxIntegrations, existing },
    );
  }
  const agent = input.agentId ? await requireAgent(db, tenantId, input.agentId) : null;
  if (agent && input.projectId && input.projectId !== agent.projectId) {
    throw badRequest("project_agent_mismatch", `agent ${agent.id} belongs to project ${agent.projectId}`, {
      agentId: agent.id,
      projectId: input.projectId,
    });
  }

  // Which project owns the connection: a caller-named one (resolved through the
  // ownership guard, so a foreign id is a 404), the bound agent's, or the tenant
  // default. The canvas filters channels by the project it was opened from, so
  // a connection parked in a third project would be invisible to the agent that
  // uses it — which is why the mismatch above is refused rather than guessed at.
  const projectId = input.projectId
    ? (await requireProject(db, tenantId, input.projectId)).id
    : agent
      ? agent.projectId
      : await ensureDefaultProject(db, tenantId);

  const created = await db.integration.create({
    data: {
      tenantId,
      projectId,
      type: input.type,
      externalId: input.externalId ?? null,
      credentialsEncrypted: keyring.encrypt(input.credentials),
    },
    select: { id: true },
  });

  if (input.agentId) {
    await db.agentIntegration.upsert({
      where: { agentId_integrationId: { agentId: input.agentId, integrationId: created.id } },
      create: { agentId: input.agentId, integrationId: created.id, direction: input.agentDirection ?? "INPUT" },
      update: { direction: input.agentDirection ?? "INPUT" },
    });
  }

  const rows = await listIntegrations(db, tenantId, keyring);
  return rows.find((row) => row.id === created.id) ?? null;
}

export async function updateIntegration(
  db: PrismaClient,
  tenantId: string,
  integrationId: string,
  input: { status?: "CONNECTED" | "ERROR" | "REVOKED"; externalId?: string | null; credentials?: string },
  keyring: Keyring,
): Promise<IntegrationDto | null> {
  await requireIntegration(db, tenantId, integrationId);
  await db.integration.update({
    where: { id: integrationId },
    data: {
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
      ...(input.credentials === undefined ? {} : { credentialsEncrypted: keyring.encrypt(input.credentials) }),
    },
  });
  const rows = await listIntegrations(db, tenantId, keyring);
  return rows.find((row) => row.id === integrationId) ?? null;
}

export async function detachIntegration(db: PrismaClient, tenantId: string, agentId: string, integrationId: string): Promise<void> {
  await requireAgent(db, tenantId, agentId);
  await requireIntegration(db, tenantId, integrationId);
  await db.agentIntegration.deleteMany({ where: { agentId, integrationId } });
}

export async function attachIntegration(
  db: PrismaClient,
  tenantId: string,
  agentId: string,
  input: { integrationId: string; direction: "INPUT" | "OUTPUT" },
  keyring: Keyring,
) {
  await requireAgent(db, tenantId, agentId);
  await requireIntegration(db, tenantId, input.integrationId);
  await db.agentIntegration.upsert({
    where: { agentId_integrationId: { agentId, integrationId: input.integrationId } },
    create: { agentId, integrationId: input.integrationId, direction: input.direction },
    update: { direction: input.direction },
  });
  return listAgentBindings(db, tenantId, agentId, keyring);
}

export async function updateTenant(db: PrismaClient, tenantId: string, name: string): Promise<TenantDto> {
  await db.tenant.update({ where: { id: tenantId }, data: { name } });
  return readTenant(db, tenantId);
}

export interface WorkflowInput {
  name: string;
  description?: string | null;
}

/**
 * A workflow is created empty rather than with a starter node. The canvas needs
 * an id to save against before the user has drawn anything, and inventing a
 * placeholder agent node would put a reference in the graph that the tenant
 * never chose.
 */
export async function createWorkflow(
  db: PrismaClient,
  tenantId: string,
  projectId: string,
  input: WorkflowInput,
): Promise<WorkflowDto | null> {
  await requireProject(db, tenantId, projectId);
  let created: { id: string };
  try {
    created = await db.workflow.create({
      data: {
        tenantId,
        projectId,
        name: input.name,
        description: input.description ?? null,
        definition: { nodes: [], edges: [] },
      },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("workflow_name_taken", `a workflow named "${input.name}" already exists in this project`);
    }
    throw error;
  }
  return getWorkflow(db, tenantId, created.id);
}

export async function updateWorkflow(
  db: PrismaClient,
  tenantId: string,
  workflowId: string,
  input: Partial<WorkflowInput>,
): Promise<WorkflowDto | null> {
  await requireWorkflow(db, tenantId, workflowId);
  try {
    await db.workflow.update({
      where: { id: workflowId },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("workflow_name_taken", `a workflow named "${input.name}" already exists in this project`);
    }
    throw error;
  }
  return getWorkflow(db, tenantId, workflowId);
}

/**
 * One line per issue, path first. This is the shape `parse()` already gives a
 * zod rejection, so a curl user reads the same style of refusal whichever layer
 * said no — and the full structured list still rides in `details`.
 */
const summarise = (issues: GraphIssue[]): string =>
  issues.map((issue) => `${issue.path ?? issue.nodeKey ?? "graph"}: ${issue.message}`).join("; ");

export async function validateWorkflow(
  db: PrismaClient,
  tenantId: string,
  workflowId: string,
): Promise<WorkflowValidationDto> {
  const workflow = await requireWorkflow(db, tenantId, workflowId);
  return (await inspectWorkflow(db, tenantId, workflow)).report;
}

export interface GraphSave {
  /** Untrusted: the canvas sends this shape, the server decides what it means. */
  definition: unknown;
  /** The version the canvas loaded. A stale number is a refused write. */
  expectedVersion: number;
}

/**
 * Autosave. Two rules make this safe to call on every drag:
 *
 * 1. An unfinished graph is a legitimate thing to save. Only a document that
 *    cannot be read at all is refused — a node missing its agent id is not "a
 *    work in progress", it is a shape the rest of the system cannot interpret.
 *    Unconnected nodes, dangling refs and cycles are reported by `validate` and
 *    block activation, never the save.
 * 2. The write is a compare-and-swap on `version`, and the derived reference
 *    index is rebuilt inside the same transaction. A save that half-applied
 *    would leave the index claiming a wiring the canvas no longer shows, which
 *    is exactly the two-sources-of-truth failure the index exists to prevent.
 */
export async function saveGraph(
  db: PrismaClient,
  tenantId: string,
  workflowId: string,
  input: GraphSave,
): Promise<WorkflowDto | null> {
  const loaded = await requireWorkflow(db, tenantId, workflowId);
  const parsed = readGraph(input.definition);
  if (!parsed.graph) {
    throw badRequest("validation_failed", summarise(parsed.issues), { issues: parsed.issues });
  }
  const graph = parsed.graph;
  const refs = dependenciesOf(graph);

  const applied = await db.$transaction(async (tx) => {
    const updated = await tx.workflow.updateMany({
      where: tenantWhere(tenantId, { id: workflowId, version: input.expectedVersion }),
      data: { definition: graph as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
    });
    if (updated.count === 0) return false;
    await tx.workflowDependency.deleteMany({ where: { workflowId } });
    if (refs.length > 0) {
      await tx.workflowDependency.createMany({
        data: refs.map((ref) => ({ tenantId, workflowId, kind: ref.kind, refId: ref.refId })),
      });
    }
    return true;
  });

  if (!applied) {
    // Read the true current version rather than reporting the one this request
    // started from: the whole point of the message is the number to reload.
    const now = await db.workflow.findFirst({
      where: tenantWhere(tenantId, { id: workflowId }),
      select: { version: true },
    });
    throw conflict(
      "graph_version",
      now
        ? `someone else saved this graph first — the server is on version ${now.version}. Reload before editing again.`
        : "this workflow no longer exists, so there is nothing to save onto",
      { expected: input.expectedVersion, current: now?.version ?? null },
    );
  }
  return getWorkflow(db, tenantId, workflowId);
}

export async function setWorkflowStatus(
  db: PrismaClient,
  tenantId: string,
  workflowId: string,
  status: "DRAFT" | "ACTIVE" | "PAUSED",
  workerStaleMs: number,
  probeTools?: (provider: string, model: string) => Promise<boolean>,
): Promise<WorkflowDto | null> {
  const workflow = await requireWorkflow(db, tenantId, workflowId);
  if (workflow.status === status) return getWorkflow(db, tenantId, workflowId);

  if (status === "ACTIVE") {
    // Every rule runs here and nowhere else. A DRAFT may be unfinished — that is
    // what a draft is — but an ACTIVE graph is a promise that the next inbound
    // message gets an answer, so it is held to the same standard the worker will
    // apply to it.
    const { graph, report, blockers } = await inspectWorkflow(db, tenantId, workflow);
    if (graph === null || blockers.length > 0) {
      throw badRequest("graph_invalid", summarise(blockers), { issues: report.issues });
    }
    // Two active graphs wired to the same inbound channel make every incoming
    // message ambiguous — both would answer, the tenant pays twice and the user
    // cannot predict which reply arrives. First claim wins, named in the error.
    for (const node of graph.nodes) {
      if (node.kind !== "INBOUND") continue;
      const holder = await activeWorkflowUsing(db, tenantId, "INTEGRATION", node.config.integrationId);
      if (holder && holder.id !== workflowId) {
        throw conflict(
          "channel_claimed",
          `${holder.name} is already active on this channel. One active workflow per inbound — pause it first.`,
          { workflowId: holder.id, workflowName: holder.name, integrationId: node.config.integrationId },
        );
      }
    }
    // Delegation only exists if every agent involved can call tools. Asking the
    // provider now means a run never discovers a missing capability on its first
    // billed call.
    const orchestrators = graph.nodes.filter((node): node is OrchestratorNode => node.kind === "ORCHESTRATOR");
    if (orchestrators.length > 0) {
      await requireToolCapableAgents(db, tenantId, orchestrators, probeTools);
    }
  }

  // "Active" is a claim about a SECOND PROCESS: the next message gets answered.
  // The heartbeat row the worker writes about itself is the only evidence the API
  // has for that, so a graph stays a draft while nothing has checked in. Every
  // rule above holds whether or not a worker is up; this one is about the promise.
  if (status === "ACTIVE") {
    const alive = await liveWorker(db, workerStaleMs);
    if (alive === null) {
      throw conflict(
        "worker_not_running",
        `the graph is valid, but no worker has checked in within ${Math.round(workerStaleMs / 1000)}s, so activating it would run nothing. Start one with pnpm dev:worker.`,
        { workflowId, staleMs: workerStaleMs },
      );
    }
  }

  await db.workflow.update({ where: { id: workflowId }, data: { status } });
  return getWorkflow(db, tenantId, workflowId);
}

/**
 * An orchestrator is a promise about the models underneath it, not only about
 * the drawing. Every agent it can reach — itself and each declared subagent —
 * must report the `tools` capability before "active" is allowed. Verdicts are
 * cached per provider+model here, and again for five minutes inside the adapter.
 */
async function requireToolCapableAgents(
  db: PrismaClient,
  tenantId: string,
  orchestrators: OrchestratorNode[],
  probeTools: ((provider: string, model: string) => Promise<boolean>) | undefined,
): Promise<void> {
  const agentIds = [
    ...new Set(orchestrators.flatMap((node) => [node.config.agentId, ...node.config.subagents.map((sub) => sub.agentId)])),
  ];
  const rows = await db.agent.findMany({
    where: { AND: [{ tenantId }, { id: { in: agentIds } }] },
    select: { id: true, name: true, modelProvider: true, modelName: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const verdicts = new Map<string, boolean>();

  for (const node of orchestrators) {
    const refs = [...new Set([node.config.agentId, ...node.config.subagents.map((sub) => sub.agentId)])];
    for (const agentId of refs) {
      const agent = byId.get(agentId);
      // The graph check already refused a missing agent; nothing to probe here.
      if (agent === undefined) continue;
      const key = `${agent.modelProvider}|${agent.modelName}`;
      let supported = verdicts.get(key);
      if (supported === undefined) {
        if (probeTools === undefined) {
          throw conflict(
            "tools_probe_failed",
            `cannot check whether ${agent.modelProvider} "${agent.modelName}" supports tools: no provider probe is wired into this process`,
            { nodeKey: node.key, agentId, agent: agent.name, model: agent.modelName },
          );
        }
        try {
          supported = await probeTools(agent.modelProvider, agent.modelName);
        } catch (error) {
          throw conflict(
            "tools_probe_failed",
            `could not ask ${agent.modelProvider} whether "${agent.modelName}" supports tools: ${error instanceof Error ? error.message : String(error)}`,
            { nodeKey: node.key, agentId, agent: agent.name, model: agent.modelName },
          );
        }
        verdicts.set(key, supported);
      }
      if (!supported) {
        throw conflict(
          "tools_unsupported",
          `"${agent.name}" runs on ${agent.modelName}, which does not declare the "tools" capability. Orchestrator "${node.label ?? node.key}" can only run agents whose model supports tools.`,
          { nodeKey: node.key, agentId, agent: agent.name, model: agent.modelName },
        );
      }
    }
  }
}

/**
 * Delete refuses while the graph is ACTIVE, because a running channel with no
 * workflow behind it is silent — the messages arrive, nothing answers, and the
 * tenant has no screen that says so. Pausing first makes the gap a choice.
 *
 * Run history is not deleted: `WorkflowRun.workflowId` is FK-less on purpose, so
 * the ledger of what the graph did outlives the graph itself.
 */
/**
 * The one honest answer to "is anything going to run this?" — a heartbeat row the
 * worker process wrote about itself, younger than `staleMs`. The API cannot know
 * this from its own state, which is why it used to refuse instead.
 */
export async function liveWorker(
  db: PrismaClient,
  staleMs: number,
): Promise<{ workerId: string; lastSeenAt: string } | null> {
  const row = await db.workerHeartbeat.findFirst({
    where: { lastSeenAt: { gte: new Date(Date.now() - staleMs) } },
    orderBy: { lastSeenAt: "desc" },
    select: { workerId: true, lastSeenAt: true },
  });
  return row === null ? null : { workerId: row.workerId, lastSeenAt: row.lastSeenAt.toISOString() };
}

export interface WorkerStateDto {
  alive: boolean;
  staleMs: number;
  seenAt: string | null;
  workerId: string | null;
  /** What the queue itself holds, so "idle" and "backed up" stay distinguishable. */
  jobs: { queued: number; claimed: number; failed: number; dead: number };
}

export async function workerState(db: PrismaClient, queue: Queue, staleMs: number): Promise<WorkerStateDto> {
  const [alive, jobs] = await Promise.all([liveWorker(db, staleMs), queue.counts(GRAPH_LANE)]);
  return { alive: alive !== null, staleMs, seenAt: alive?.lastSeenAt ?? null, workerId: alive?.workerId ?? null, jobs };
}

export interface TestRunStart {
  runId: string;
  /** The queue row carrying it — the same table a real channel event lands in. */
  jobId: string;
  status: "RUNNING";
}

/**
 * The console's test run: a real message, through the real queue, executed by the
 * worker. Nothing here simulates a reply.
 *
 * The run row is written BEFORE the job is queued so `202` can name a run the
 * canvas polls, and the job carries that id — the worker resumes it rather than
 * starting a second one. This is the producer the queue has never had; the
 * channel adapters (Phase G) enqueue the same payload shape from a webhook.
 */
export async function startTestRun(
  db: PrismaClient,
  queue: Queue,
  tenantId: string,
  workflowId: string,
  message: string,
): Promise<TestRunStart> {
  const workflow = await requireWorkflow(db, tenantId, workflowId);
  if (workflow.status !== "ACTIVE") {
    throw conflict("workflow_not_active", `${workflow.name} is ${workflow.status.toLowerCase()} — activate it before running it`);
  }
  const { graph, report, blockers } = await inspectWorkflow(db, tenantId, workflow);
  if (graph === null || blockers.length > 0) {
    throw badRequest("graph_invalid", summarise(blockers), { issues: report.issues });
  }
  const run = await prepareRun(db, {
    tenantId,
    workflow: { id: workflow.id, name: workflow.name, version: workflow.version },
    message,
    triggerSource: "console-test",
    // Filled in below with the queue row's own id: the run does not exist until
    // something is waiting for a worker, and that something is what this names.
    externalMessageId: "",
    nodes: graph.nodes,
  });
  const enqueued = await queue.enqueue({
    lane: GRAPH_LANE,
    tenantId,
    source: "console-test",
    // One click, one run, one job: the run id is the dedupe key, so a double
    // submit of the same run cannot enqueue it twice.
    externalMessageId: run.id,
    payload: { workflowId: workflow.id, message },
    workflowId: workflow.id,
    runId: run.id,
  });
  await db.workflowRun.update({ where: { id: run.id }, data: { externalMessageId: enqueued.id } });
  return { runId: run.id, jobId: enqueued.id, status: "RUNNING" };
}

export async function deleteWorkflow(db: PrismaClient, tenantId: string, workflowId: string): Promise<void> {
  const workflow = await requireWorkflow(db, tenantId, workflowId);
  if (workflow.status === "ACTIVE") {
    throw conflict("workflow_active", `${workflow.name} is active — pause it before deleting`);
  }
  await db.workflow.delete({ where: { id: workflowId } });
}
