/**
 * The console's view of the API. These interfaces mirror `apps/api/src/dto.ts`
 * one-for-one — the server is the only source of truth, and nothing here is
 * filled in when a row is missing. If the API has no value, the field is
 * `null` and the UI says so.
 */

export type AgentStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "ERROR";
export type IntegrationType = "TELEGRAM_IN" | "WHATSAPP_IN" | "SHEETS_OUT" | "DRIVE_OUT" | "WEBHOOK_OUT";
export type IntegrationStatus = "CONNECTED" | "ERROR" | "REVOKED";
export type Direction = "INPUT" | "OUTPUT";
export type MessageRole = "USER" | "ASSISTANT" | "SYSTEM";
export type UsageKind = "MODEL_CALL" | "CONNECTOR_WRITE" | "QUOTA_RESET" | "CLASSIFY";
export type WebhookStatus = "QUEUED" | "PROCESSED" | "FAILED" | "DEAD";

export interface Tenant {
  id: string;
  name: string;
  planId: string;
  planName: string;
  tokenBalance: string;
  cycleResetAt: string;
  createdAt: string;
}

export interface Plan {
  id: string;
  name: string;
  monthlyPriceUsd: number;
  tokenQuota: string;
  maxIntegrations: number;
  features: Record<string, unknown>;
}

export interface Project {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  counts: { agents: number; integrations: number; workflows: number };
}

/**
 * What the project form holds. `description` is the text in the box, so it is a
 * string here and only becomes the column's `null` when the mutation treats an
 * empty box as "no description" rather than "an empty one".
 */
export interface ProjectDraft {
  name: string;
  description: string;
}

export type WorkflowStatus = "DRAFT" | "ACTIVE" | "PAUSED";
export interface WorkflowSummary {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  version: number;
  updatedAt: string;
}

/**
 * The graph document, mirrored from `packages/core/src/graph.ts` through the
 * API's DTO. The node's `key` is canvas-stable and never a database id: edges
 * refer to it, and the ids live in `config` where a rename cannot break a cable.
 */
export type NodeKind = "INBOUND" | "AGENT" | "OUTBOUND" | "ORCHESTRATOR";
export interface NodePosition {
  x: number;
  y: number;
}
export interface InboundNode {
  key: string;
  kind: "INBOUND";
  label?: string;
  position: NodePosition;
  config: { integrationId: string };
}
export interface AgentNode {
  key: string;
  kind: "AGENT";
  label?: string;
  position: NodePosition;
  config: { agentId: string };
}
export interface OutboundNode {
  key: string;
  kind: "OUTBOUND";
  label?: string;
  position: NodePosition;
  config: { integrationId: string };
}
/** A declared specialist an orchestrator may delegate to; `role` is its tool name. */
export interface OrchestratorSubagent {
  agentId: string;
  role: string;
  maxSteps?: number;
}
export interface OrchestratorNode {
  key: string;
  kind: "ORCHESTRATOR";
  label?: string;
  position: NodePosition;
  config: { agentId: string; subagents: OrchestratorSubagent[] };
}
export type GraphNode = InboundNode | AgentNode | OutboundNode | OrchestratorNode;
export interface GraphEdge {
  id?: string;
  from: string;
  to: string;
}
export interface GraphDefinition {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface WorkflowDependency {
  kind: "AGENT" | "INTEGRATION";
  refId: string;
  /** Null means the row is gone: the graph still names it, validation reports it. */
  name: string | null;
}

export interface Workflow {
  id: string;
  tenantId: string;
  projectId: string;
  projectName: string;
  name: string;
  description: string | null;
  status: WorkflowStatus;
  version: number;
  definition: GraphDefinition;
  dependencies: WorkflowDependency[];
  createdAt: string;
  updatedAt: string;
}

export type IssueLevel = "error" | "warning";

export interface GraphIssue {
  /** One of the code strings `packages/core` emits; the server owns the list. */
  code: string;
  level: IssueLevel;
  path?: string;
  nodeKey?: string;
  message: string;
}

export type RunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED";
export type NodeRunStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";

/** One box's part in a run, keyed by the canvas-stable node key. */
export interface WorkflowNodeRun {
  nodeKey: string;
  kind: NodeKind;
  label: string | null;
  refId: string | null;
  status: NodeRunStatus;
  attempt: number;
  input: string | null;
  output: string | null;
  error: string | null;
  /** What this node's model turns cost; an orchestrator turn sums its delegations. */
  tokensUsed: number;
  /** One entry per executed tool call; empty when the node called none. */
  trace: AgentTraceStep[];
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
}

/** One executed tool call, as the node row recorded it. */
export interface AgentTraceStep {
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

export interface WorkflowRun {
  id: string;
  workflowId: string;
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
  /** Present on tenant-wide run lists; null once the workflow row is gone. */
  projectId?: string | null;
  nodes?: WorkflowNodeRun[];
}

/** Whether a second process is actually consuming the queue, and what it holds. */
export interface WorkerState {
  alive: boolean;
  staleMs: number;
  seenAt: string | null;
  workerId: string | null;
  jobs: { queued: number; claimed: number; failed: number; dead: number };
}

/** The server's answer to "could this graph run?", returned by `POST /validate`. */
export interface WorkflowValidation {
  ok: boolean;
  issues: GraphIssue[];
  order: string[];
  entryKeys: string[];
}

export interface Agent {
  id: string;
  tenantId: string;
  projectId: string;
  name: string;
  status: AgentStatus;
  systemPrompt: string;
  modelProvider: string;
  modelName: string;
  temperature: number;
  maxOutputTokens: number;
  /** Ceiling on model rounds in one turn; the deployment default applies at 0. */
  maxToolSteps: number;
  /** 0 means no limit. A turn that crosses a non-zero ceiling fails after the round that cost it. */
  perTurnTokenBudget: number;
  dailyTokenBudget: number;
  createdAt: string;
  tokensThisCycle: number;
  conversations: number;
  channels: number;
  lastRunAt: string | null;
}

export interface AgentDraft {
  name: string;
  systemPrompt: string;
  modelProvider: string;
  modelName: string;
  temperature: number;
  maxOutputTokens: number;
  maxToolSteps: number;
  perTurnTokenBudget: number;
  dailyTokenBudget: number;
  /**
   * Create only: the project the agent is filed into. Omitted, the API uses the
   * tenant default. It is never a patch field — re-parenting an agent would move
   * its threads and history with it, which the API refuses to do by side effect.
   */
  projectId?: string;
}

/**
 * Knowledge, mirrored from `apps/api/src/services/knowledge.ts`.
 *
 * `status` is the whole indexing protocol, and it is the server's column rather than
 * a client-side guess: a document is `PENDING` when it is stored, `INDEXING` while a
 * worker holds the job, `INDEXED` with a chunk count, or `FAILED` with the reason.
 * Nothing in this list is ever rendered as searchable before it says so itself.
 */
export type KnowledgeKind = "FILE" | "PAGE" | "NOTE";
export type KnowledgeStatus = "PENDING" | "INDEXING" | "INDEXED" | "FAILED";
/** Which engine answered, so "no results" has two different meanings. */
export type SearchBackend = "keyword" | "vector" | "none";

export interface KnowledgeDoc {
  id: string;
  projectId: string | null;
  kind: KnowledgeKind;
  title: string;
  mime: string;
  status: KnowledgeStatus;
  error: string | null;
  charCount: number;
  byteSize: number;
  chunkCount: number;
  sha8: string;
  /** Whether the agent whose tab this is may search it. */
  granted: boolean;
  /** The vector half, from the embed lane's own record. Null means keyword-only. */
  embedding: { model: string; dim: number; chunks: number; at: string } | null;
  embeddingError: string | null;
  createdAt: string;
  updatedAt: string;
  excerpt?: string;
}

/** What a write answered — including whether it was a duplicate and what got queued. */
export interface KnowledgeWrite {
  doc: KnowledgeDoc;
  duplicate: boolean;
  granted: boolean;
  queued: boolean;
  queue: string;
}

export interface KnowledgeHit {
  chunkId: string;
  docId: string;
  seq: number;
  title: string;
  text: string;
  snippet: string;
  score: number;
  pageUrl?: string;
  backend: SearchBackend;
}

export interface KnowledgeSearch {
  query: string;
  backend: SearchBackend;
  hits: KnowledgeHit[];
  searched: number;
  note: string;
}

/**
 * A public widget, mirrored from `apps/api/src/services/embeds.ts`. `keyHint` is
 * all the console will ever see of the key again — the raw value exists once, in
 * the create response, and the snippet shown here is that moment's copy.
 */
export type EmbedStatus = "ACTIVE" | "PAUSED";

export interface EmbedWidget {
  id: string;
  agentId: string;
  projectId: string;
  name: string;
  keyHint: string;
  origins: string[];
  status: EmbedStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EmbedBundle {
  served: boolean;
  file: string;
}

export interface EmbedList {
  embeds: EmbedWidget[];
  bundle: EmbedBundle;
}

export interface EmbedCreate {
  embed: EmbedWidget;
  key: string;
  snippet: string;
  bundle: EmbedBundle;
}

export interface EmbedRotate {
  key: string;
  keyHint: string;
  snippet: string;
}

/** One visitor bucket. `rejected` is written by the same statement that returns 429. */
export interface EmbedRateRow {
  ipHash: string;
  tokens: number;
  rejected: number;
  updatedAt: string;
}

/**
 * What the classifier decided, and how it knows. `source` is `model` when the
 * label was read from the model's reply; `unparseable`, `provider_failed` or
 * `balance_exhausted` mean the row says UNKNOWN for a stated reason — none of
 * those is a feeling, and the UI must not colour them like one.
 */
export type Sentiment = "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "UNKNOWN";

export interface FeedbackRow {
  id: string;
  embedId: string;
  embedName: string;
  messageId: string;
  question: string;
  answer: string | null;
  sentiment: Sentiment;
  score: number | null;
  source: string;
  model: string | null;
  error: string | null;
  tokensUsed: number;
  createdAt: string;
}

export type SentimentTotals = Record<Sentiment, number> & { total: number };

export interface ProjectInsights {
  scope: "project" | "embed";
  scopeId: string;
  embedCount: number;
  totals: SentimentTotals;
  feedback: FeedbackRow[];
}

/**
 * Skills and capabilities, mirrored from `apps/api/src/services/capability.ts`,
 * which in turn mirrors `packages/core/src/capability`. A skill is content; a
 * grant is the permission for one agent to use it. `state: UNAVAILABLE` is the
 * honest half of the design: the console lists what was granted *and* what this
 * build refused to give the model, with the server's own reason.
 */
export type SkillOrigin = "BUILTIN" | "TENANT";
export type SkillStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type CapabilityKind = "SKILL" | "TOOL" | "KNOWLEDGE" | "SITE";
export type ToolEffect = "read" | "write" | "external";
export type CapabilityState = "READY" | "UNAVAILABLE";

export interface PublishedRef {
  version: number;
  /** sha-256 of the frozen body, so "did publishing change anything" is answerable. */
  hash: string;
  publishedAt: string | null;
}

export interface Skill {
  /** `builtin:<key>` for a code-owned skill, the row id for the tenant's own. */
  id: string;
  key: string;
  name: string;
  description: string;
  origin: SkillOrigin;
  status: SkillStatus;
  core: boolean;
  requires: string[];
  tools: string[];
  /** The draft an editor shows. A run never reads this — it reads `published`. */
  instructions: string;
  latestVersion: number;
  published: PublishedRef | null;
  warnings: string[];
  updatedAt: string | null;
}

/**
 * The registry's vocabulary, read from `GET /skills/registry` rather than
 * restated here: the editor offers the requirement names and limits the validator
 * enforces, so a second copy cannot drift out of sync with the build.
 */
export interface SkillRegistry {
  requirements: { name: string; blurb: string }[];
  tools: { key: string; label: string; summary: string; effect: ToolEffect }[];
  limits: { keyMax: number; nameMax: number; descriptionMax: number; instructionsWarnLines: number };
}

/** The shape the skill editor holds and posts. `key` is immutable after create. */
export interface SkillDraft {
  key: string;
  name: string;
  description: string;
  instructions: string;
  requires: string[];
  tools: string[];
  core: boolean;
}

export interface CapabilityGrant {
  kind: CapabilityKind;
  ref: string;
  enabled: boolean;
  state: CapabilityState;
  label: string;
  reason?: string;
}

export interface CatalogueEntry {
  key: string;
  ref: string;
  name: string;
  description: string;
  version: number | null;
  origin: SkillOrigin;
  core: boolean;
  effects: ToolEffect[];
  state: CapabilityState;
  reason?: string;
}

export interface CapabilityToolEntry {
  key: string;
  effect: ToolEffect;
  state: CapabilityState;
  /** `DERIVED` = the assembly built it because a catalogue needed it. */
  grant: "GRANTED" | "DERIVED";
  reason?: string;
}

/**
 * A knowledge grant resolved against the document it names. `docId: null` is the
 * server saying "that ref is not a document in this tenant" — the console shows the
 * line rather than dropping it, because a grant that silently disappears from the
 * list is indistinguishable from one that was never made.
 */
export interface KnowledgeEntry {
  ref: string;
  docId: string | null;
  title: string;
  state: CapabilityState;
  reason?: string;
}

export interface CapabilityDegradation {
  kind: "SKILL" | "TOOL" | "KNOWLEDGE" | "SITE";
  ref: string;
  reason: string;
}

/** A site grant resolved against the crawl it names; `state` is the crawl's verdict. */
export interface SiteEntry {
  ref: string;
  siteId: string | null;
  host: string;
  rootUrl: string;
  pageCount: number;
  state: CapabilityState;
  reason?: string;
}

export interface CapabilitySnapshot {
  agentId: string;
  skills: CatalogueEntry[];
  tools: CapabilityToolEntry[];
  knowledge: KnowledgeEntry[];
  sites: SiteEntry[];
  degradations: CapabilityDegradation[];
  promptChars: number;
  promptBudgetChars: number;
}

export interface CapabilityView {
  agentId: string;
  grants: CapabilityGrant[];
  catalogue: CatalogueEntry[];
  tools: CapabilityToolEntry[];
  knowledge: KnowledgeEntry[];
  sites: SiteEntry[];
  degradations: CapabilityDegradation[];
  available: {
    skills: { key: string; name: string; description: string; origin: SkillOrigin; core: boolean; published: boolean }[];
    tools: { key: string; label: string; summary: string; effect: ToolEffect }[];
    knowledge: {
      docId: string;
      title: string;
      kind: KnowledgeKind;
      status: KnowledgeStatus;
      chunkCount: number;
      charCount: number;
      indexed: boolean;
    }[];
    sites: {
      siteId: string;
      agentId: string;
      host: string;
      rootUrl: string;
      status: string;
      pageCount: number;
      crawledAt: string | null;
    }[];
  };
}

/** A grant the console sends. `PUT /agents/:id/capabilities` is replace-all. */
export interface GrantInput {
  kind: CapabilityKind;
  ref: string;
  enabled?: boolean;
}

/**
 * What `GET /agents/:id/capabilities/preview` answers: the exact prompt and tool
 * list the next turn would send, with no provider call. It is a preview rather
 * than a guess because it runs the same assembler a run does.
 */
export interface CapabilityPreview {
  systemPrompt: string;
  tools: { name: string; description: string }[];
  snapshot: CapabilitySnapshot;
  capabilityHash: string;
  degradations: CapabilityDegradation[];
}

/**
 * The agent's own site, mirrored from `apps/api/src/services/site.ts`. The pages
 * on the row are exactly what `find_page` may offer: a URL that is not here cannot
 * leave the server as a button, however convincingly a page suggests it.
 */
export type SiteCrawlStatus = "PENDING" | "CRAWLING" | "READY" | "FAILED";

export interface AgentSitePage {
  url: string;
  path: string;
  title: string;
  summary: string;
  intent: string;
}

export interface AgentSite {
  id: string;
  agentId: string;
  rootUrl: string;
  host: string;
  manualUrls: string[];
  status: SiteCrawlStatus;
  error: string | null;
  pageCount: number;
  crawledAt: string | null;
  createdAt: string;
  updatedAt: string;
  pages: AgentSitePage[];
}

/** What a save answers: the row plus whether a crawl was actually queued. */
export interface AgentSiteSave extends AgentSite {
  queued: boolean;
  queue: string;
}

export interface IntegrationBinding {
  agentId: string;
  agentName: string;
  direction: Direction;
}

export interface Integration {
  id: string;
  tenantId: string;
  projectId: string;
  type: IntegrationType;
  externalId: string | null;
  status: IntegrationStatus;
  createdAt: string;
  credentialPreview: string | null;
  bindings: IntegrationBinding[];
}

export interface IntegrationDraft {
  type: IntegrationType;
  credentials: string;
  externalId?: string | null;
  agentId?: string;
  agentDirection?: Direction;
}

export interface Conversation {
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

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
}

export interface UsageEvent {
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

export interface WebhookEventLog {
  id: string;
  source: string;
  externalMessageId: string;
  status: WebhookStatus;
  receivedAt: string;
  processedAt: string | null;
}

export interface DailyPoint {
  date: string;
  tokens: number;
  calls: number;
}

export interface Overview {
  tenant: Tenant;
  plan: Plan;
  agents: { total: number; active: number; error: number };
  integrations: { total: number; connected: number; limit: number };
  tokensUsedThisCycle: number;
  tokensRemaining: number;
  messagesToday: number;
  costThisCycleUsd: number;
  daily: DailyPoint[];
  recentConversations: Conversation[];
  recentUsage: UsageEvent[];
  failingEvents: WebhookEventLog[];
}

export interface Provider {
  name: string;
  models: string[];
  defaultModel: string;
  error: string | null;
}

export interface RunOutcome {
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
  /** The activity row this turn wrote; null when the observer could not start one. */
  agentRunId: string | null;
}

/** A persisted direct/playground agent turn. */
export interface AgentRun {
  id: string;
  projectId: string;
  agentId: string;
  agentName: string;
  triggerSource: string;
  status: RunStatus;
  conversationId: string | null;
  externalChatId: string | null;
  input: string;
  output: string | null;
  error: string | null;
  tokensUsed: number;
  stepCount: number;
  toolCallCount: number;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export type AgentRunStepKind = "MODEL" | "TOOL";

export interface AgentRunStep {
  id: string;
  seq: number;
  round: number;
  kind: AgentRunStepKind;
  tool: string | null;
  argsPreview: string | null;
  resultPreview: string | null;
  ok: boolean | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  createdAt: string;
}

export interface AgentRunDetail extends AgentRun {
  steps: AgentRunStep[];
  /** Null means this turn was never assembled, not that it had no capabilities. */
  capability: CapabilitySnapshot | null;
  capabilityHash: string | null;
}

export type ActivityStatus = RunStatus | "PENDING" | "SKIPPED";

/** One row of the merged activity feed: a direct turn or a workflow agent node. */
export interface ActivityItem {
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

export interface HealthResponse {
  ok: boolean;
  db: "up" | "down";
  env: string;
}

/** A table an agent produced with `make_sheet`. Cells are JSON primitives. */
export type SheetCell = string | number | boolean | null;

export interface SheetExportState {
  exportedAt: string | null;
  spreadsheetId: string | null;
  sheetName: string | null;
  url: string | null;
  /** Why the last Google Sheets push failed, kept until a push succeeds. */
  error: string | null;
}

export interface SheetSummary {
  id: string;
  projectId: string;
  agentId: string;
  agentName: string;
  title: string;
  columns: string[];
  /** Written from the rows the write path inserted, not from the model's claim. */
  rowCount: number;
  createdAt: string;
  export: SheetExportState;
}

export interface SheetRow {
  rowIndex: number;
  cells: SheetCell[];
}

export interface SheetDetail extends SheetSummary {
  rows: SheetRow[];
}

export interface SheetExportResult {
  sheet: SheetDetail;
  spreadsheetId: string;
  sheetName: string;
  /** Data rows appended below the header — the header itself is not counted. */
  rowsAppended: number;
  url: string;
}
