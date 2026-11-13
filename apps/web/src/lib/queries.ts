import { QueryClient, keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import Message01Icon from "@hugeicons/core-free-icons/Message01Icon";
import Table01Icon from "@hugeicons/core-free-icons/Table01Icon";
import TelegramIcon from "@hugeicons/core-free-icons/TelegramIcon";
import type { IconSvgElement } from "@hugeicons/react";
import { deleteJson, fetchHealth, getJson, patchJson, postForm, postJson, putJson } from "./api";
import type {
  ActivityItem,
  ActivityStatus,
  Agent,
  AgentDraft,
  AgentRun,
  AgentRunDetail,
  AgentSite,
  AgentSiteSave,
  AgentStatus,
  CapabilityPreview,
  CapabilityView,
  Conversation,
  Direction,
  EmbedCreate,
  EmbedList,
  EmbedRateRow,
  EmbedRotate,
  EmbedStatus,
  EmbedWidget,
  GrantInput,
  GraphDefinition,
  Integration,
  IntegrationDraft,
  IntegrationStatus,
  KnowledgeDoc,
  KnowledgeSearch,
  KnowledgeWrite,
  ProjectInsights,
  Sentiment,
  SheetDetail,
  SheetExportResult,
  SheetSummary,
  WorkerState,
  WorkflowRun,
  IntegrationType,
  Message,
  Overview,
  Plan,
  Project,
  Provider,
  RunOutcome,
  RunStatus,
  Skill,
  SkillDraft,
  SkillRegistry,
  SkillStatus,
  Tenant,
  UsageEvent,
  WebhookEventLog,
  Workflow,
  WorkflowStatus,
  WorkflowSummary,
  WorkflowValidation,
} from "./domain";
import { usePageVisible } from "./use-page-visible";

export const queryClient = new QueryClient({
  // retry 0: a 404 or a 402 quota refusal is an answer, not a transient glitch,
  // and re-firing a model run to "retry" it would bill the tenant twice.
  defaultOptions: {
    queries: { staleTime: 15_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false, retry: 0 },
  },
});

export interface ActivityQuery {
  agentId?: string;
  status?: ActivityStatus;
  limit?: number;
}

export interface AgentRunQuery {
  agentId?: string;
  status?: RunStatus;
  limit?: number;
}

export interface WorkflowRunQuery {
  workflowId?: string;
  status?: RunStatus;
  limit?: number;
}

const keys = {
  overview: ["overview"] as const,
  projects: ["projects"] as const,
  project: (id: string) => ["projects", id] as const,
  projectAgents: (id: string) => ["projects", id, "agents"] as const,
  projectIntegrations: (id: string) => ["projects", id, "integrations"] as const,
  projectWorkflows: (id: string) => ["projects", id, "workflows"] as const,
  projectInsights: (id: string, sentiment: string) => ["projects", id, "insights", sentiment] as const,
  projectSheets: (id: string) => ["projects", id, "sheets"] as const,
  sheet: (id: string) => ["sheets", id] as const,
  workflows: ["workflows"] as const,
  workflow: (id: string) => ["workflows", id] as const,
  agents: ["agents"] as const,
  agent: (id: string) => ["agents", id] as const,
  skills: ["skills"] as const,
  skillRegistry: ["skills", "registry"] as const,
  skill: (id: string) => ["skills", id] as const,
  capabilities: (agentId: string) => ["agents", agentId, "capabilities"] as const,
  capabilityPreview: (agentId: string, surface: "console" | "public") =>
    ["agents", agentId, "capabilities", "preview", surface] as const,
  knowledge: (agentId: string) => ["agents", agentId, "knowledge"] as const,
  knowledgeSearch: (agentId: string, query: string) =>
    ["agents", agentId, "knowledge", "search", query] as const,
  site: (agentId: string) => ["agents", agentId, "site"] as const,
  embeds: (agentId: string) => ["agents", agentId, "embeds"] as const,
  embedRates: (embedId: string) => ["embeds", embedId, "rates"] as const,
  integrations: ["integrations"] as const,
  bindings: (agentId: string) => ["agents", agentId, "integrations"] as const,
  conversations: (agentId?: string) => ["conversations", agentId ?? "all"] as const,
  messages: (conversationId: string) => ["conversations", conversationId, "messages"] as const,
  usage: ["usage"] as const,
  webhooks: ["webhooks"] as const,
  tenant: ["tenant"] as const,
  plans: ["plans"] as const,
  providers: ["providers"] as const,
  health: ["health"] as const,
  worker: ["worker"] as const,
  runs: (workflowId: string) => ["workflows", workflowId, "runs"] as const,
  run: (runId: string) => ["workflow-runs", runId] as const,
  activity: (query: ActivityQuery) =>
    ["activity", query.agentId ?? "all", query.status ?? "ALL", query.limit ?? 30] as const,
  agentRuns: (query: AgentRunQuery) =>
    ["agent-runs", query.agentId ?? "all", query.status ?? "ALL", query.limit ?? 30] as const,
  agentRun: (id: string) => ["agent-runs", id] as const,
  workflowRuns: (query: WorkflowRunQuery) =>
    ["workflow-runs", query.workflowId ?? "all", query.status ?? "ALL", query.limit ?? 30] as const,
};

function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function useOverview() {
  return useQuery({ queryKey: keys.overview, queryFn: () => getJson<Overview>("/overview") });
}

export function useProjects(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: keys.projects,
    queryFn: () => getJson<Project[]>("/projects"),
    enabled: options?.enabled ?? true,
    placeholderData: keepPreviousData,
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: keys.project(id ?? ""),
    queryFn: () => getJson<Project>(`/projects/${id}`),
    enabled: Boolean(id),
  });
}

export function useProjectAgents(id: string | undefined) {
  return useQuery({
    queryKey: keys.projectAgents(id ?? ""),
    queryFn: () => getJson<Agent[]>(`/projects/${id}/agents`),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });
}

export function useProjectIntegrations(id: string | undefined) {
  return useQuery({
    queryKey: keys.projectIntegrations(id ?? ""),
    queryFn: () => getJson<Integration[]>(`/projects/${id}/integrations`),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });
}

/** Real rows from `Workflow` — the list is empty until the builder can save a graph. */
export function useProjectWorkflows(id: string | undefined) {
  return useQuery({
    queryKey: keys.projectWorkflows(id ?? ""),
    queryFn: () => getJson<WorkflowSummary[]>(`/projects/${id}/workflows`),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });
}

/**
 * The last questions, with the label the classifier gave each one. A filter is
 * part of the query key because the server filters the list — the totals on the
 * page are always the unfiltered counts, which is why they are read from the
 * same response instead of being derived from the visible rows.
 */
export function useProjectInsights(id: string | undefined, sentiment: Sentiment | "ALL", limit = 20) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: keys.projectInsights(id ?? "", sentiment),
    queryFn: () =>
      getJson<ProjectInsights>(`/projects/${id}/insights${queryString({ limit, sentiment: sentiment === "ALL" ? undefined : sentiment })}`),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
    // The worker writes a feedback row after the widget answers; a visible tab
    // picks it up without a reload, and a hidden one does not poll.
    refetchInterval: visible ? 15_000 : false,
  });
}

/**
 * A project's sheets, newest first. The list polls only while the tab is visible:
 * a sheet appears after an agent turn, which is not something the console can be
 * told about, but a background tab has no reason to keep asking.
 */
export function useProjectSheets(id: string | undefined) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: keys.projectSheets(id ?? ""),
    queryFn: () => getJson<{ sheets: SheetSummary[] }>(`/projects/${id}/sheets`),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
    refetchInterval: visible ? 20_000 : false,
  });
}

/** One sheet and its rows; fetched only once a sheet is selected. */
export function useSheet(id: string | null) {
  return useQuery({
    queryKey: keys.sheet(id ?? ""),
    queryFn: () => getJson<SheetDetail>(`/sheets/${id}`),
    enabled: Boolean(id),
  });
}

export interface SheetPush {
  id: string;
  integrationId?: string;
  spreadsheetId?: string;
  sheetName?: string;
}

/**
 * Push one sheet into Google Sheets. The answer is the updated detail row, so the
 * console shows the export state the API stored rather than a toast that outlives
 * a refresh and disagrees with the database.
 */
export function usePushSheet() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: SheetPush) => postJson<SheetExportResult>(`/sheets/${id}/export`, body),
    onSuccess: (result) => {
      client.setQueryData(keys.sheet(result.sheet.id), result.sheet);
      void client.invalidateQueries({ queryKey: keys.projectSheets(result.sheet.projectId) });
    },
  });
}

export function useAgents(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: keys.agents,
    queryFn: () => getJson<Agent[]>("/agents"),
    enabled: options?.enabled ?? true,
    placeholderData: keepPreviousData,
  });
}

export function useAgent(id: string | undefined) {
  return useQuery({
    queryKey: keys.agent(id ?? ""),
    queryFn: () => getJson<Agent>(`/agents/${id}`),
    enabled: Boolean(id),
  });
}

export function useIntegrations() {
  return useQuery({ queryKey: keys.integrations, queryFn: () => getJson<Integration[]>("/integrations"), placeholderData: keepPreviousData });
}

export interface BoundIntegration {
  integration: Integration;
  direction: Direction;
}

export function useAgentBindings(agentId: string | undefined) {
  return useQuery({
    queryKey: keys.bindings(agentId ?? ""),
    queryFn: () => getJson<BoundIntegration[]>(`/agents/${agentId}/integrations`),
    enabled: Boolean(agentId),
    placeholderData: keepPreviousData,
  });
}

export function useConversations(agentId?: string) {
  return useQuery({
    queryKey: keys.conversations(agentId),
    queryFn: () => getJson<Conversation[]>(`/conversations${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`),
    placeholderData: keepPreviousData,
  });
}

export function useMessages(conversationId: string | undefined) {
  return useQuery({
    queryKey: keys.messages(conversationId ?? ""),
    queryFn: () => getJson<Message[]>(`/conversations/${conversationId}/messages`),
    enabled: Boolean(conversationId),
  });
}

export function useUsageEvents() {
  return useQuery({ queryKey: keys.usage, queryFn: () => getJson<UsageEvent[]>("/usage"), placeholderData: keepPreviousData });
}

export function useWebhookEvents() {
  return useQuery({ queryKey: keys.webhooks, queryFn: () => getJson<WebhookEventLog[]>("/webhook-events"), placeholderData: keepPreviousData });
}

export function useTenant() {
  return useQuery({ queryKey: keys.tenant, queryFn: () => getJson<Tenant>("/tenant") });
}

export function usePlans() {
  return useQuery({ queryKey: keys.plans, queryFn: () => getJson<Plan[]>("/plans") });
}

/** The live model catalog read from the provider daemon — never a fixed list. */
export function useProviders() {
  return useQuery({ queryKey: keys.providers, queryFn: () => getJson<Provider[]>("/providers"), staleTime: 60_000 });
}

export function useHealth() {
  const visible = usePageVisible();
  return useQuery({
    queryKey: keys.health,
    queryFn: fetchHealth,
    refetchInterval: visible ? 30_000 : false,
    retry: false,
    staleTime: 5_000,
  });
}

/**
 * A write lands in Postgres, so the cache is refetched rather than patched
 * locally — nothing on screen can drift from what the database actually holds.
 */
function refetchAfterWrite(agentId?: string) {
  const groups: Array<readonly unknown[]> = [
    keys.overview,
    keys.projects,
    keys.workflows,
    keys.agents,
    keys.integrations,
    keys.conversations(),
    keys.usage,
    keys.webhooks,
    keys.tenant,
    ["activity"],
    ["agent-runs"],
    ["workflow-runs"],
  ];
  if (agentId) groups.push(keys.agent(agentId), keys.bindings(agentId), keys.conversations(agentId));
  for (const group of groups) void queryClient.invalidateQueries({ queryKey: group });
}

/** A draft plus the id it belongs to, so one form covers create and edit. */
export type AgentSave = AgentDraft & { id?: string };

export function useSaveAgent() {
  return useMutation({
    mutationFn: ({ id, projectId, ...draft }: AgentSave) =>
      id
        ? patchJson<Agent>(`/agents/${id}`, draft)
        : projectId
          ? postJson<Agent>(`/projects/${projectId}/agents`, draft)
          : postJson<Agent>("/agents", draft),
    onSuccess: () => refetchAfterWrite(),
  });
}

export function useSetAgentStatus() {
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: AgentStatus }) =>
      patchJson<Agent>(`/agents/${id}/status`, { status }),
    onSuccess: () => refetchAfterWrite(),
  });
}

export function useDeleteAgent() {
  return useMutation({
    mutationFn: (id: string) => deleteJson<null>(`/agents/${id}`),
    onSuccess: () => refetchAfterWrite(),
  });
}

// --- skills and capabilities -------------------------------------------------

export function useSkills(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: keys.skills,
    queryFn: () => getJson<Skill[]>("/skills"),
    enabled: options?.enabled ?? true,
    placeholderData: keepPreviousData,
  });
}

/** Requirement names, grantable tools and length limits, as this build defines them. */
export function useSkillRegistry() {
  return useQuery({
    queryKey: keys.skillRegistry,
    queryFn: () => getJson<SkillRegistry>("/skills/registry"),
    staleTime: 5 * 60_000,
  });
}

export function useCapabilities(agentId: string | undefined) {
  return useQuery({
    queryKey: keys.capabilities(agentId ?? ""),
    queryFn: () => getJson<CapabilityView>(`/agents/${agentId}/capabilities`),
    enabled: Boolean(agentId),
  });
}

/**
 * The assembled prompt, on demand rather than on mount: it is the answer to
 * "what will the model actually see", and asking it costs a read of every grant
 * plus a skill-version lookup, so it should not fire on every render of a list.
 */
export function useCapabilityPreview(agentId: string | undefined, surface: "console" | "public", enabled: boolean) {
  return useQuery({
    queryKey: keys.capabilityPreview(agentId ?? "", surface),
    queryFn: () => getJson<CapabilityPreview>(`/agents/${agentId}/capabilities/preview${queryString({ surface })}`),
    enabled: Boolean(agentId) && enabled,
  });
}

/** A skill save is an agent-affecting write: publishing changes what other pages show. */
function refetchAfterSkillWrite() {
  for (const group of [keys.skills, ["agents"]]) void queryClient.invalidateQueries({ queryKey: group });
}

export type SkillSave = SkillDraft & { id?: string };

export function useSaveSkill() {
  return useMutation({
    mutationFn: ({ id, ...draft }: SkillSave) =>
      id ? patchJson<Skill>(`/skills/${id}`, draft) : postJson<Skill>("/skills", draft),
    onSuccess: () => refetchAfterSkillWrite(),
  });
}

export function usePublishSkill() {
  return useMutation({
    mutationFn: (id: string) => postJson<Skill & { unchanged: boolean }>(`/skills/${id}/publish`, {}),
    onSuccess: () => refetchAfterSkillWrite(),
  });
}

export function useSetSkillStatus() {
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: SkillStatus }) =>
      patchJson<Skill>(`/skills/${id}/status`, { status }),
    onSuccess: () => refetchAfterSkillWrite(),
  });
}

export function useDeleteSkill() {
  return useMutation({
    mutationFn: (id: string) => deleteJson<null>(`/skills/${id}`),
    onSuccess: () => refetchAfterSkillWrite(),
  });
}

export function useSaveCapabilities(agentId: string) {
  return useMutation({
    mutationFn: (capabilities: GrantInput[]) =>
      putJson<CapabilityView>(`/agents/${agentId}/capabilities`, { capabilities }),
    onSuccess: () => refetchAfterWrite(agentId),
  });
}

/**
 * The agent's project's documents, polled while anything is still being indexed.
 * The interval is keyed on the rows themselves — a page full of `INDEXED` documents
 * costs one read on mount, not a poll — because the only thing that can change
 * without a write from this tab is a worker finishing a job.
 */
export function useAgentKnowledge(agentId: string | undefined) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: keys.knowledge(agentId ?? ""),
    queryFn: () => getJson<KnowledgeDoc[]>(`/agents/${agentId}/knowledge`),
    enabled: Boolean(agentId),
    refetchInterval: (q) => {
      if (!visible) return false;
      const rows = q.state.data ?? [];
      return rows.some((row) => row.status === "PENDING" || row.status === "INDEXING") ? 1_500 : false;
    },
  });
}

/** A document write changes the grant list too, so the capability view goes stale with it. */
function refetchAfterKnowledgeWrite(agentId: string) {
  void queryClient.invalidateQueries({ queryKey: keys.knowledge(agentId) });
  void queryClient.invalidateQueries({ queryKey: keys.capabilities(agentId) });
  void queryClient.invalidateQueries({ queryKey: ["agents", agentId, "knowledge", "search"] });
  refetchAfterWrite(agentId);
}

export function useAddKnowledgeNote(agentId: string) {
  return useMutation({
    mutationFn: (input: { title?: string; text: string }) =>
      postJson<KnowledgeWrite>(`/agents/${agentId}/knowledge`, input),
    onSuccess: () => refetchAfterKnowledgeWrite(agentId),
  });
}

/** One file per call. The API's route is the only multipart endpoint in this build. */
export function useUploadKnowledge(agentId: string) {
  return useMutation({
    mutationFn: (input: { file: File; title?: string }) => {
      const form = new FormData();
      form.append("file", input.file);
      if (input.title !== undefined && input.title !== "") form.append("title", input.title);
      return postForm<KnowledgeWrite>(`/agents/${agentId}/knowledge/upload`, form);
    },
    onSuccess: () => refetchAfterKnowledgeWrite(agentId),
  });
}

export function useReindexKnowledge(agentId: string) {
  return useMutation({
    mutationFn: (docId: string) =>
      postJson<{ doc: KnowledgeDoc; queued: boolean; queue: string }>(`/knowledge/${docId}/reindex`, {}),
    onSuccess: () => refetchAfterKnowledgeWrite(agentId),
  });
}

export function useDeleteKnowledge(agentId: string) {
  return useMutation({
    mutationFn: (docId: string) => deleteJson<null>(`/knowledge/${docId}`),
    onSuccess: () => refetchAfterKnowledgeWrite(agentId),
  });
}

/**
 * The search box. `enabled` is false until the operator submits, because a query is
 * a deliberate question and the same words asked twice are answered from cache — it
 * costs no tokens either way, but firing on every keystroke would still be noise.
 */
export function useKnowledgeSearch(agentId: string | undefined, query: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.knowledgeSearch(agentId ?? "", query),
    queryFn: () => getJson<KnowledgeSearch>(`/agents/${agentId}/knowledge/search${queryString({ q: query })}`),
    enabled: Boolean(agentId) && enabled && query.trim() !== "",
    staleTime: 60_000,
  });
}

/**
 * The agent's site, polled only while a crawl is actually moving. `PENDING` and
 * `CRAWLING` are states a worker leaves behind without this tab doing anything, so
 * they are the two that justify a timer; a READY site is one read on mount.
 */
export function useAgentSite(agentId: string | undefined) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: keys.site(agentId ?? ""),
    queryFn: () => getJson<AgentSite | null>(`/agents/${agentId}/site`),
    enabled: Boolean(agentId),
    refetchInterval: (q) => {
      if (!visible) return false;
      const site = q.state.data;
      return site !== null && site !== undefined && (site.status === "PENDING" || site.status === "CRAWLING") ? 2_000 : false;
    },
  });
}

/** A site write changes the grant list (a save grants it, a delete removes it). */
function refetchAfterSiteWrite(agentId: string) {
  void queryClient.invalidateQueries({ queryKey: keys.site(agentId) });
  void queryClient.invalidateQueries({ queryKey: keys.capabilities(agentId) });
  refetchAfterWrite(agentId);
}

export function useSaveAgentSite(agentId: string) {
  return useMutation({
    mutationFn: (input: { rootUrl: string; manualUrls: string[] }) =>
      putJson<AgentSiteSave>(`/agents/${agentId}/site`, input),
    onSuccess: () => refetchAfterSiteWrite(agentId),
  });
}

export function useDeleteAgentSite(agentId: string) {
  return useMutation({
    mutationFn: () => deleteJson<null>(`/agents/${agentId}/site`),
    onSuccess: () => refetchAfterSiteWrite(agentId),
  });
}

/**
 * The widgets this agent answers through. Nothing here polls: a widget row only
 * changes when the operator writes one, and the rate buckets only move when a
 * visitor is refused — both of which are reads the tab asks for explicitly.
 */
export function useAgentEmbeds(agentId: string | undefined) {
  return useQuery({
    queryKey: keys.embeds(agentId ?? ""),
    queryFn: () => getJson<EmbedList>(`/agents/${agentId}/embeds`),
    enabled: Boolean(agentId),
  });
}

function refetchAfterEmbedWrite(agentId: string) {
  void queryClient.invalidateQueries({ queryKey: keys.embeds(agentId) });
  void queryClient.invalidateQueries({ queryKey: ["embeds"] });
}

export function useCreateEmbed(agentId: string) {
  return useMutation({
    mutationFn: (input: { name: string; origins: string[] }) =>
      postJson<EmbedCreate>(`/agents/${agentId}/embeds`, input),
    onSuccess: () => refetchAfterEmbedWrite(agentId),
  });
}

export function useUpdateEmbed(agentId: string) {
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; name?: string; origins?: string[]; status?: EmbedStatus }) =>
      patchJson<EmbedWidget>(`/embeds/${id}`, patch),
    onSuccess: () => refetchAfterEmbedWrite(agentId),
  });
}

/** Rotating rewrites `keyHash`; every pasted snippet stops answering until it is replaced. */
export function useRotateEmbed(agentId: string) {
  return useMutation({
    mutationFn: (id: string) => postJson<EmbedRotate>(`/embeds/${id}/rotate`, {}),
    onSuccess: () => refetchAfterEmbedWrite(agentId),
  });
}

export function useDeleteEmbed(agentId: string) {
  return useMutation({
    mutationFn: (id: string) => deleteJson<null>(`/embeds/${id}`),
    onSuccess: () => refetchAfterEmbedWrite(agentId),
  });
}

/** The bucket rows behind one widget: the proof that a 429 was counted, not implied. */
export function useEmbedRates(embedId: string | undefined) {
  return useQuery({
    queryKey: keys.embedRates(embedId ?? ""),
    queryFn: () => getJson<{ rates: EmbedRateRow[] }>(`/embeds/${embedId}/rates`),
    enabled: Boolean(embedId),
  });
}

/**
 * The body the project routes accept. `description: null` means "no
 * description", which is what an empty box must send — the column is nullable
 * and `""` would be a different value on the next read.
 */
export type ProjectSave = { name: string; description: string | null; id?: string };

export function useSaveProject() {
  return useMutation({
    mutationFn: ({ id, ...draft }: ProjectSave) =>
      id ? patchJson<Project>(`/projects/${id}`, draft) : postJson<Project>("/projects", draft),
    onSuccess: () => refetchAfterWrite(),
  });
}

/**
 * The API refuses to delete a project that still holds agents, connections or
 * workflows with a 409 naming what is inside, so the message the console shows
 * is the server's own reason rather than a guess at why it failed.
 */
export function useDeleteProject() {
  return useMutation({
    mutationFn: (id: string) => deleteJson<null>(`/projects/${id}`),
    onSuccess: () => refetchAfterWrite(),
  });
}

/** The full workflow row, graph document included. */
export function useWorkflow(id: string | undefined) {
  return useQuery({
    queryKey: keys.workflow(id ?? ""),
    queryFn: () => getJson<Workflow>(`/workflows/${id}`),
    enabled: Boolean(id),
  });
}

export interface WorkflowSave {
  projectId?: string;
  id?: string;
  name: string;
  description: string | null;
}

/**
 * Create posts under the project from the path; edit patches the workflow.
 * `tenantId` is never sent because the server takes it from the session.
 */
export function useSaveWorkflow() {
  return useMutation({
    mutationFn: ({ projectId, id, ...draft }: WorkflowSave) =>
      id ? patchJson<Workflow>(`/workflows/${id}`, draft) : postJson<Workflow>(`/projects/${projectId}/workflows`, draft),
    onSuccess: () => refetchAfterWrite(),
  });
}

/**
 * A workflow write returns the whole row it now holds, so the cache is updated
 * with that answer instead of refetched. This is not a performance choice:
 * refetching the graph would replace `nodes` and `edges` under a canvas the user
 * is still dragging on. The project list still refetches — its `updatedAt` and
 * counts really did move.
 */
function cacheWorkflowWrite(saved: Workflow) {
  queryClient.setQueryData(keys.workflow(saved.id), saved);
  void queryClient.invalidateQueries({ queryKey: keys.projects });
}

/** Autosave. See `cacheWorkflowWrite` for why the answer is cached, not refetched. */
export function useSaveGraph() {
  return useMutation({
    mutationFn: ({ id, definition, expectedVersion }: { id: string; definition: GraphDefinition; expectedVersion: number }) =>
      patchJson<Workflow>(`/workflows/${id}/graph`, { definition, expectedVersion }),
    onSuccess: cacheWorkflowWrite,
  });
}

export function useValidateWorkflow() {
  return useMutation({
    mutationFn: (id: string) => postJson<WorkflowValidation>(`/workflows/${id}/validate`, {}),
  });
}

/**
 * Activation is the one write whose refusal must be readable in full: the server
 * returns every rule it broke, and nothing is filtered on the way to the screen.
 */
export function useSetWorkflowStatus() {
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: WorkflowStatus }) =>
      patchJson<Workflow>(`/workflows/${id}/status`, { status }),
    onSuccess: cacheWorkflowWrite,
  });
}

export function useDeleteWorkflow() {
  return useMutation({
    mutationFn: (id: string) => deleteJson<null>(`/workflows/${id}`),
    onSuccess: () => refetchAfterWrite(),
  });
}

export function useSaveIntegration() {
  return useMutation({
    mutationFn: (draft: IntegrationDraft) => postJson<Integration>("/integrations", draft),
    onSuccess: (_data, draft) => refetchAfterWrite(draft.agentId),
  });
}
export function useSetIntegrationStatus() {
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: IntegrationStatus }) =>
      patchJson<Integration>(`/integrations/${id}`, { status }),
    onSuccess: () => refetchAfterWrite(),
  });
}

export function useAttachChannel() {
  return useMutation({
    mutationFn: ({ agentId, integrationId, direction }: { agentId: string; integrationId: string; direction: Direction }) =>
      postJson<Integration>(`/agents/${agentId}/integrations`, { integrationId, direction }),
    onSuccess: (_data, vars) => refetchAfterWrite(vars.agentId),
  });
}

export function useDetachChannel() {
  return useMutation({
    mutationFn: ({ agentId, integrationId }: { agentId: string; integrationId: string }) =>
      deleteJson<null>(`/agents/${agentId}/integrations/${integrationId}`),
    onSuccess: (_data, vars) => refetchAfterWrite(vars.agentId),
  });
}

export function useUpdateTenant() {
  return useMutation({
    mutationFn: (name: string) => patchJson<Tenant>("/tenant", { name }),
    onSuccess: () => refetchAfterWrite(),
  });
}

export interface RunInput {
  agentId: string;
  message: string;
  conversationId?: string;
}

/** Sends the message to the real provider through the API and records the run. */
export function useRunAgent() {
  return useMutation({
    mutationFn: ({ agentId, message, conversationId }: RunInput) =>
      postJson<RunOutcome>(`/agents/${agentId}/run`, { message, conversationId }),
    onSuccess: (_data, vars) => refetchAfterWrite(vars.agentId),
  });
}

/**
 * The merged activity feed: direct agent turns from `AgentRun` and agent /
 * orchestrator nodes from workflow runs, newest first. It polls faster only
 * while one of the rows on screen is actually moving.
 */
export function useActivity(query: ActivityQuery = {}, options?: { enabled?: boolean }) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: keys.activity(query),
    queryFn: () =>
      getJson<ActivityItem[]>(
        `/activity${queryString({
          agentId: query.agentId,
          status: query.status,
          limit: query.limit ?? 30,
        })}`,
      ),
    enabled: options?.enabled ?? true,
    refetchInterval: (q) => {
      if (!visible) return false;
      const rows = q.state.data ?? [];
      return rows.some((row) => row.status === "RUNNING" || row.status === "PENDING") ? 1_500 : 8_000;
    },
    placeholderData: keepPreviousData,
  });
}

/** Persisted direct turns, newest first. `limit: 1` gives "the run in flight". */
export function useAgentRuns(query: AgentRunQuery = {}, options?: { enabled?: boolean }) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: keys.agentRuns(query),
    queryFn: () =>
      getJson<AgentRun[]>(
        `/agent-runs${queryString({
          agentId: query.agentId,
          status: query.status,
          limit: query.limit ?? 30,
        })}`,
      ),
    enabled: options?.enabled ?? true,
    refetchInterval: (q) => {
      if (!visible) return false;
      const rows = q.state.data ?? [];
      return rows.some((row) => row.status === "RUNNING") ? 1_500 : 6_000;
    },
    placeholderData: keepPreviousData,
  });
}

/** One run with every step it has recorded so far, polled while it is RUNNING. */
export function useAgentRun(id: string | undefined) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: keys.agentRun(id ?? ""),
    queryFn: () => getJson<AgentRunDetail>(`/agent-runs/${id}`),
    enabled: Boolean(id),
    refetchInterval: (q) => (visible && q.state.data?.status === "RUNNING" ? 1_000 : false),
  });
}

/** Workflow runs across the whole tenant — the node rows feed the activity list. */
export function useWorkflowRunsTenant(query: WorkflowRunQuery = {}) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: keys.workflowRuns(query),
    queryFn: () =>
      getJson<WorkflowRun[]>(
        `/workflow-runs${queryString({
          workflowId: query.workflowId,
          status: query.status,
          limit: query.limit ?? 30,
        })}`,
      ),
    refetchInterval: visible ? 5_000 : false,
    placeholderData: keepPreviousData,
  });
}


/**
 * The worker's own heartbeat, read once per poll. The canvas uses this to say
 * "a worker is alive" or "nothing is listening" — never to guess.
 */
export function useWorker() {
  const visible = usePageVisible();
  return useQuery({
    queryKey: keys.worker,
    queryFn: () => getJson<WorkerState>("/worker"),
    // The heartbeat badge is only worth polling while the console is on screen.
    refetchInterval: visible ? 5_000 : false,
  });
}

/**
 * Queue a real run of an ACTIVE graph. 202 means the row exists and a worker
 * still has to pick it up, so the caller polls the run rather than the request.
 */
export function useStartRun(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (message: string) => postJson<{ runId: string; jobId: string; status: string }>(`/workflows/${workflowId}/runs`, { message }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.runs(workflowId) });
      void queryClient.invalidateQueries({ queryKey: keys.worker });
      void queryClient.invalidateQueries({ queryKey: keys.usage });
      void queryClient.invalidateQueries({ queryKey: ["activity"] });
      void queryClient.invalidateQueries({ queryKey: ["workflow-runs"] });
    },
  });
}

/** One run with its node rows, polled while it is still moving and on screen. */
export function useRun(runId: string | undefined) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: keys.run(runId ?? ""),
    queryFn: () => getJson<WorkflowRun>(`/workflow-runs/${runId}`),
    enabled: Boolean(runId),
    refetchInterval: (query) => (visible && query.state.data?.status === "RUNNING" ? 1_000 : false),
  });
}

/** Newest first; a list row carries no node rows. */
export function useWorkflowRuns(workflowId: string | undefined) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: keys.runs(workflowId ?? ""),
    queryFn: () => getJson<WorkflowRun[]>(`/workflows/${workflowId}/runs`),
    enabled: Boolean(workflowId),
    refetchInterval: visible ? 3_000 : false,
    placeholderData: keepPreviousData,
  });
}

export interface ChannelSpec {
  type: IntegrationType;
  label: string;
  blurb: string;
  direction: Direction;
  credentialLabel: string;
  placeholder: string;
  icon: IconSvgElement;
}

/**
 * Static catalog of what the platform can bind to. It describes the shape of a
 * credential, not a connection: a row enters the table only after the user
 * supplies a real token and the API stores it.
 */
export const CHANNEL_CATALOG: ChannelSpec[] = [
  {
    type: "TELEGRAM_IN",
    label: "Telegram",
    blurb: "Long-polling bot that receives inbound messages.",
    direction: "INPUT",
    credentialLabel: "Bot token from @BotFather",
    placeholder: "123456789:AA...",
    icon: TelegramIcon,
  },
  {
    type: "WHATSAPP_IN",
    label: "WhatsApp",
    blurb: "Cloud API webhook for business numbers.",
    direction: "INPUT",
    credentialLabel: "Permanent access token",
    placeholder: "EAAG...",
    icon: Message01Icon,
  },
  {
    type: "SHEETS_OUT",
    label: "Google Sheets",
    blurb: "Append a stored sheet's rows to a spreadsheet.",
    direction: "OUTPUT",
    credentialLabel: "OAuth client JSON (clientId, clientSecret, refreshToken)",
    placeholder: '{"clientId":"…","clientSecret":"…","refreshToken":"1//…"}',
    icon: Table01Icon,
  },
  {
    type: "DRIVE_OUT",
    label: "Google Drive",
    blurb: "Store transcripts as documents.",
    direction: "OUTPUT",
    credentialLabel: "OAuth refresh token",
    placeholder: "1//...",
    icon: Folder01Icon,
  },
  {
    type: "WEBHOOK_OUT",
    label: "Webhook",
    blurb: "POST every reply to your own endpoint.",
    direction: "OUTPUT",
    credentialLabel: "Signing secret",
    placeholder: "whsec_...",
    icon: Link01Icon,
  },
];
