/**
 * The wire contract for the console. These shapes are what the browser
 * receives, and `apps/web/src/lib/domain.ts` mirrors them one-for-one: a
 * column is never sent before it appears here, and nothing the tenant did not
 * store is invented on the way out.
 */
import type { CapabilitySnapshot, DependencyRef, GraphDefinition, GraphIssue } from "@saas/core";

export type { CapabilitySnapshot, DependencyRef, GraphDefinition, GraphIssue } from "@saas/core";

export type AgentStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "ERROR";
export type IntegrationType = "TELEGRAM_IN" | "WHATSAPP_IN" | "SHEETS_OUT" | "DRIVE_OUT" | "WEBHOOK_OUT";
export type IntegrationStatus = "CONNECTED" | "ERROR" | "REVOKED";
export type Direction = "INPUT" | "OUTPUT";
export type MessageRole = "USER" | "ASSISTANT" | "SYSTEM";
export type UsageKind = "MODEL_CALL" | "CONNECTOR_WRITE" | "QUOTA_RESET" | "CLASSIFY";
export type WebhookStatus = "QUEUED" | "PROCESSED" | "FAILED" | "DEAD";

export interface TenantDto {
  id: string;
  name: string;
  planId: string;
  planName: string;
  /** BigInt column, serialised as a string so no precision is lost. */
  tokenBalance: string;
  cycleResetAt: string;
  createdAt: string;
}

export interface PlanDto {
  id: string;
  name: string;
  monthlyPriceUsd: number;
  tokenQuota: string;
  maxIntegrations: number;
  features: Record<string, unknown>;
}

export interface ProjectDto {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  /** True only for the row the `add_project` backfill and the seed create. */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  counts: { agents: number; integrations: number; workflows: number };
}

export type WorkflowStatus = "DRAFT" | "ACTIVE" | "PAUSED";

/** What a workflow list row can say without reading the graph document. */
export interface WorkflowSummaryDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  version: number;
  updatedAt: string;
}

/**
 * A dependency row plus the name it referred to. `name` is resolved at read
 * time, never stored: `refId` is FK-less on purpose, so a deleted agent still
 * appears here with `name: null` and the console says "deleted" rather than
 * quietly dropping the row the graph points at.
 */
export interface WorkflowDependencyDto extends DependencyRef {
  name: string | null;
}

export interface WorkflowDto {
  id: string;
  tenantId: string;
  projectId: string;
  projectName: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  version: number;
  definition: GraphDefinition;
  dependencies: WorkflowDependencyDto[];
  createdAt: string;
  updatedAt: string;
}

/** The server's own answer to "could this graph run?", from `@saas/core`. */
export interface WorkflowValidationDto {
  ok: boolean;
  issues: GraphIssue[];
  order: string[];
  entryKeys: string[];
}

export type NodeRunStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";
export type RunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED";

/** One executed tool call, as the node row recorded it. */
export interface AgentTraceStepDto {
  index: number;
  tool: string;
  argsPreview: string;
  resultPreview: string;
  ok: boolean;
  inputTokens: number;
  outputTokens: number;
  /** Absent on traces written before tool durations were measured. */
  durationMs?: number;
}

export interface WorkflowNodeRunDto {
  nodeKey: string;
  kind: "INBOUND" | "AGENT" | "OUTBOUND" | "ORCHESTRATOR";
  label: string | null;
  refId: string | null;
  status: NodeRunStatus;
  attempt: number;
  input: string | null;
  output: string | null;
  error: string | null;
  /** What this node's model turns cost; an orchestrator turn sums its delegations. */
  tokensUsed: number;
  /** Empty when the node called no tools. */
  trace: AgentTraceStepDto[];
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WorkflowRunSummaryDto {
  id: string;
  workflowId: string;
  /** Snapshot taken when the run started, so history survives a rename. */
  workflowName: string | null;
  workflowVersion: number;
  status: RunStatus;
  triggerSource: string;
  input: string;
  output: string | null;
  error: string | null;
  tokensUsed: number;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
  /** Resolved from the live workflow row; absent once that workflow is deleted. */
  projectId?: string | null;
  /** Nodes that had been written when the row was read; a list row does not
   *  fetch them, so this is only present on the detail view. */
  nodes?: WorkflowNodeRunDto[];
}

/** A persisted direct/playground agent turn, as the activity views read it. */
export interface AgentRunDto {
  id: string;
  projectId: string;
  agentId: string;
  /** Snapshot taken when the run started, so history survives a rename/delete. */
  agentName: string;
  triggerSource: string;
  status: RunStatus;
  conversationId: string | null;
  externalChatId: string | null;
  input: string;
  output: string | null;
  error: string | null;
  tokensUsed: number;
  /** Model rounds, including the final one. */
  stepCount: number;
  toolCallCount: number;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export type AgentRunStepKindDto = "MODEL" | "TOOL";

/** One entry in a run's ordered stream: a completed round or an executed tool. */
export interface AgentRunStepDto {
  id: string;
  seq: number;
  round: number;
  kind: AgentRunStepKindDto;
  tool: string | null;
  argsPreview: string | null;
  resultPreview: string | null;
  ok: boolean | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  createdAt: string;
}

export interface AgentRunDetailDto extends AgentRunDto {
  steps: AgentRunStepDto[];
  /**
   * The capability set this turn ran with, as the assembler recorded it before the
   * first paid round. Null when the turn was not assembled — a run from before the
   * capability system, or one started by a caller that passed no assembly — which
   * is a real absence, not an empty set: an agent with no grants still gets a
   * snapshot, because the contract line is part of its prompt.
   */
  capability: CapabilitySnapshot | null;
  capabilityHash: string | null;
}

/** A node's status can be something a run can never be (PENDING/SKIPPED). */
export type ActivityStatus = RunStatus | "PENDING" | "SKIPPED";

/**
 * One row of the merged activity feed. `AGENT_RUN` rows are direct turns;
 * `WORKFLOW_NODE` rows are AGENT/ORCHESTRATOR nodes of a graph run, carrying
 * the workflow run id so the console can open the run that produced them.
 */
export interface ActivityItemDto {
  id: string;
  source: "AGENT_RUN" | "WORKFLOW_NODE";
  status: ActivityStatus;
  agentId: string | null;
  agentName: string | null;
  projectId: string | null;
  workflowId: string | null;
  workflowName: string | null;
  workflowRunId: string | null;
  nodeKey: string | null;
  nodeLabel: string | null;
  inputPreview: string;
  outputPreview: string | null;
  tokensUsed: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface AgentDto {
  id: string;
  tenantId: string;
  /** The project that owns this agent; canvas nodes may only reach inside it. */
  projectId: string;
  name: string;
  status: AgentStatus;
  systemPrompt: string;
  modelProvider: string;
  modelName: string;
  temperature: number;
  maxOutputTokens: number;
  /** Cost ceilings. A zero budget means the plan balance is the only cap. */
  maxToolSteps: number;
  perTurnTokenBudget: number;
  dailyTokenBudget: number;
  createdAt: string;
  /** Derived from the ledger, not stored on the agent. */
  tokensThisCycle: number;
  conversations: number;
  channels: number;
  lastRunAt: string | null;
}

export interface IntegrationBindingDto {
  agentId: string;
  agentName: string;
  direction: Direction;
}

export interface IntegrationDto {
  id: string;
  tenantId: string;
  projectId: string;
  type: IntegrationType;
  externalId: string | null;
  status: IntegrationStatus;
  createdAt: string;
  /** Last characters of the decrypted secret; the blob itself never leaves the server. */
  credentialPreview: string | null;
  bindings: IntegrationBindingDto[];
}

export interface ConversationDto {
  id: string;
  tenantId: string;
  agentId: string;
  agentName: string;
  externalChatId: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview: string;
  lastMessageRole: MessageRole | null;
}

export interface MessageDto {
  id: string;
  role: MessageRole;
  content: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
}

export interface UsageEventDto {
  id: string;
  tenantId: string;
  agentId: string | null;
  agentName: string | null;
  kind: UsageKind;
  tokensUsed: number;
  costUsdEstimate: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface WebhookEventDto {
  id: string;
  source: string;
  externalMessageId: string;
  status: WebhookStatus;
  receivedAt: string;
  processedAt: string | null;
}

export interface DailyPointDto {
  date: string;
  tokens: number;
  calls: number;
}

export interface OverviewDto {
  tenant: TenantDto;
  plan: PlanDto;
  agents: { total: number; active: number; error: number };
  integrations: { total: number; connected: number; limit: number };
  tokensUsedThisCycle: number;
  tokensRemaining: number;
  messagesToday: number;
  costThisCycleUsd: number;
  daily: DailyPointDto[];
  recentConversations: ConversationDto[];
  recentUsage: UsageEventDto[];
  failingEvents: WebhookEventDto[];
}

export interface ProviderDto {
  name: string;
  /** Live model list from the provider's own API, empty if it could not be read. */
  models: string[];
  defaultModel: string;
  error: string | null;
}
