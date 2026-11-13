import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { MAX_EDGES, MAX_NODES, type Queue } from "@saas/core";
import { registeredProviders, resolveProvider } from "@saas/providers";
import type { ProviderConfig } from "@saas/providers";
import type { Keyring } from "@saas/shared";
import type { ProviderDto } from "./dto.ts";
import { badRequest, HttpError, notFound } from "./http-error.ts";
import {
  getAgent,
  getAgentRun,
  getProject,
  getWorkflow,
  getWorkflowRun,
  listActivity,
  listAgents,
  listAgentBindings,
  listAgentRuns,
  listConversations,
  listIntegrations,
  listMessages,
  listPlans,
  listProjectAgents,
  listProjectIntegrations,
  listProjectWorkflows,
  listProjects,
  listWorkflowRuns,
  listWorkflowRunsTenant,
  listUsage,
  listWebhookEvents,
  readOverview,
  readTenant,
} from "./services/reads.ts";
import { requireProject, requireWorkflow } from "./services/scope.ts";
import {
  addKnowledgeNote,
  deleteKnowledgeDoc,
  getKnowledgeDoc,
  listAgentKnowledge,
  reindexKnowledgeDoc,
  searchAgentKnowledge,
} from "./services/knowledge.ts";
import { registerKnowledgeUpload } from "./knowledge-upload.ts";
import { makeQueryEmbedder } from "./services/embedding.ts";
import { deleteAgentSite, getAgentSite, saveAgentSite } from "./services/site.ts";
import {
  createEmbed,
  deleteEmbed,
  listAgentEmbeds,
  listEmbedRates,
  rotateEmbedKey,
  updateEmbed,
} from "./services/embeds.ts";
import type { EmbedBundleDto } from "./services/embeds.ts";
import { embedInsights, projectInsights } from "./services/feedback.ts";
import { getSheet, listProjectSheets } from "./services/sheets.ts";
import { pushSheetToSheets } from "./services/sheet-export.ts";
import {
  attachIntegration,
  createAgent,
  createIntegration,
  createProject,
  createWorkflow,
  deleteAgent,
  startTestRun,
  deleteProject,
  deleteWorkflow,
  detachIntegration,
  saveGraph,
  setAgentStatus,
  setWorkflowStatus,
  updateAgent,
  updateIntegration,
  updateProject,
  updateTenant,
  updateWorkflow,
  validateWorkflow,
  workerState,
} from "./services/writes.ts";
import { runAgent } from "./services/run.ts";
import {
  createSkill,
  deleteSkill,
  describeCapabilities,
  getSkill,
  listSkills,
  previewAssembly,
  publishSkill,
  replaceCapabilities,
  setSkillStatus,
  skillRegistry,
  updateSkill,
} from "./services/capability.ts";

const INTEGRATION_TYPES = ["TELEGRAM_IN", "WHATSAPP_IN", "SHEETS_OUT", "DRIVE_OUT", "WEBHOOK_OUT"] as const;

const agentBody = z.object({
  name: z.string().min(1).max(80),
  systemPrompt: z.string().min(1).max(8_000),
  modelProvider: z.string().min(1).max(40),
  modelName: z.string().min(1).max(120),
  temperature: z.number().min(0).max(2),
  maxOutputTokens: z.number().int().min(1).max(32_000),
  // Cost ceilings. Absent means "leave the column default", not "zero": a tool
  // loop multiplies one message into many billed rounds, so the ceiling belongs
  // next to the model choice rather than in an env var nobody can see per agent.
  maxToolSteps: z.number().int().min(1).max(10).optional(),
  perTurnTokenBudget: z.number().int().min(0).max(10_000_000).optional(),
  dailyTokenBudget: z.number().int().min(0).max(100_000_000).optional(),
});

/**
 * `projectId` is accepted on create only. A PATCH cannot carry it, because
 * moving an agent between projects is not a field edit — it would re-parent the
 * threads and history that the project owns, and `updateAgent` deliberately
 * spreads a fixed list of columns.
 */
const agentCreate = agentBody.extend({ projectId: z.string().max(64).optional() });

const agentPatch = agentBody.partial();
const statusBody = z.object({ status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "ERROR"]) });
const integrationBody = z.object({
  type: z.enum(INTEGRATION_TYPES),
  credentials: z.string().min(1).max(8_000),
  externalId: z.string().max(200).nullish(),
  projectId: z.string().max(64).optional(),
  agentId: z.string().max(64).optional(),
  agentDirection: z.enum(["INPUT", "OUTPUT"]).optional(),
});
const integrationPatch = z.object({
  status: z.enum(["CONNECTED", "ERROR", "REVOKED"]).optional(),
  externalId: z.string().max(200).nullish(),
  credentials: z.string().min(1).max(8_000).optional(),
});
const bindingBody = z.object({ integrationId: z.string().min(1), direction: z.enum(["INPUT", "OUTPUT"]) });
const projectBody = z.object({ name: z.string().min(1).max(80), description: z.string().max(500).nullish() });
const projectPatch = projectBody.partial();
const workflowBody = z.object({ name: z.string().min(1).max(80), description: z.string().max(500).nullish() });
const workflowPatch = workflowBody.partial();
/**
 * Only the envelope is checked here. The shape of a node is judged by
 * `readGraph` in `packages/core`, which emits the same dotted paths and is the
 * one implementation the worker also runs — a second zod copy of the node rules
 * would be two opinions that can disagree about whether a graph is readable.
 * The array caps are kept at the edge because they decide whether the payload
 * fits Fastify's 1 MiB body limit before anything is parsed.
 */
const graphBody = z.object({
  expectedVersion: z.number().int().min(1),
  definition: z.object({
    nodes: z.array(z.unknown()).max(MAX_NODES),
    edges: z.array(z.unknown()).max(MAX_EDGES),
  }),
});
const runStartBody = z.object({ message: z.string().min(1).max(8_000) });

const workflowStatusBody = z.object({ status: z.enum(["DRAFT", "ACTIVE", "PAUSED"]) });
const tenantBody = z.object({ name: z.string().min(1).max(120) });
const runBody = z.object({ message: z.string().min(1).max(4_000), conversationId: z.string().max(64).optional() });

/**
 * Only the envelope: a key, a length and two arrays of names. What a skill *means*
 * — is the key legal, is the description within the prompt budget, does it ask for
 * a tool this build has — is judged by `validateSkill` in core, which is the same
 * judge the publish path and the assembler run. Two validators would be two
 * opinions about whether a skill is saveable.
 */
const skillBody = z.object({
  key: z.string().min(1).max(80).optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().min(1).max(4_000).optional(),
  instructions: z.string().min(1).max(200_000).optional(),
  requires: z.array(z.string().max(40)).max(8).optional(),
  tools: z.array(z.string().max(40)).max(16).optional(),
  core: z.boolean().optional(),
});
const skillStatusBody = z.object({ status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]) });
const grantsBody = z.object({
  capabilities: z
    .array(z.object({ kind: z.enum(["SKILL", "TOOL", "KNOWLEDGE", "SITE"]), ref: z.string().min(1).max(120), enabled: z.boolean().optional() }))
    .max(64),
});
/** `surface=public` asks the preview the same question the widget will: can this agent answer in public at all? */
const previewQuery = z.object({ surface: z.enum(["console", "public"]).default("console") });
/**
 * A pasted note is capped below the 400 000-character document limit on purpose: this
 * body arrives as JSON, so it is also bounded by the API's 1 MiB `bodyLimit`, and a
 * schema that allowed more would fail at the parser with a message about bytes rather
 * than one about the text. Something bigger than this is an upload.
 */
const noteBody = z.object({ title: z.string().max(200).optional(), text: z.string().min(1).max(200_000) });
/**
 * The envelope only: the crawler's own parser is the one judge of what a crawlable
 * URL is, so the API hands it strings and lets `canonicalSite` refuse with the
 * reason. Manual pages may be relative to the root, which a `.url()` here would
 * reject before it was ever resolved.
 */
const siteBody = z.object({
  rootUrl: z.string().min(1).max(500),
  manualUrls: z.array(z.string().max(500)).max(50).optional(),
});
const knowledgeSearchQuery = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(12).default(5),
});
const usageQuery = z.object({ take: z.coerce.number().int().min(1).max(500).default(200) });
const conversationQuery = z.object({ agentId: z.string().max(64).optional() });
const embedCreateBody = z.object({
  name: z.string().trim().min(1).max(80).default("Website widget"),
  origins: z.array(z.string().max(300)).min(1).max(10),
});
const embedPatchBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  origins: z.array(z.string().max(300)).min(1).max(10).optional(),
  status: z.enum(["ACTIVE", "PAUSED"]).optional(),
});
const insightsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sentiment: z.enum(["POSITIVE", "NEUTRAL", "NEGATIVE", "UNKNOWN"]).optional(),
});
const sheetExportBody = z.object({
  integrationId: z.string().min(1).max(64).optional(),
  spreadsheetId: z.string().min(1).max(300).optional(),
  sheetName: z.string().min(1).max(100).optional(),
});

const RUN_STATUS = z.enum(["RUNNING", "SUCCEEDED", "FAILED", "BLOCKED"]);
const ACTIVITY_STATUS = z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED", "BLOCKED"]);
const runListQuery = z.object({
  status: RUN_STATUS.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().datetime().optional(),
});
const agentRunsQuery = runListQuery.extend({ agentId: z.string().max(64).optional() });
const activityQuery = z.object({
  agentId: z.string().max(64).optional(),
  status: ACTIVITY_STATUS.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const workflowRunsQuery = z.object({
  workflowId: z.string().max(64).optional(),
  status: RUN_STATUS.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** Input is pinned to `unknown` so T resolves from the schema's *output*: a `.default()` field is required after parsing. */
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest("validation_failed", result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "), result.error.issues);
  }
  return result.data;
}

export interface RouteDeps {
  db: PrismaClient;
  keyring: Keyring;
  tenantId: string;
  providerConfig: ProviderConfig;
  /** The queue this process writes into and the worker reads from. */
  queue: Queue;
  /** Older than this, and no worker is believed to be alive. */
  workerStaleMs: number;
  /**
   * Asks the provider whether a model can call tools. `main.ts` wires this to
   * the real adapters; absent, activating a graph with an orchestrator refuses.
   */
  probeTools?: (provider: string, model: string) => Promise<boolean>;
  /**
   * Where the built widget lives, from the build's own manifest. A snippet naming
   * a file that does not exist is worse than a console that says "not built yet".
   */
  embedBundle?: EmbedBundleDto;
}

/**
 * The console's whole read/write surface. `tenantId` is the session tenant
 * handed in at boot — there is no query parameter that can point the API at
 * somebody else's workspace.
 */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { db, keyring, tenantId, providerConfig, queue, workerStaleMs, probeTools } = deps;
  const embedBundle = deps.embedBundle ?? { served: false, file: "embed.js" };
  /** The origin the console itself is reached on — the same origin the widget will call. */
  const apiOriginOf = (request: { protocol: string; host: string }): string => `${request.protocol}://${request.host}`;

  app.get("/overview", async () => readOverview(db, tenantId));

  /**
   * Is there a second process alive that will actually run these graphs? The
   * answer comes from the worker's own heartbeat row, never from this process
   * guessing — which is the difference between a console that says "active" and a
   * console that says "nothing is listening".
   */
  app.get("/worker", async () => workerState(db, queue, workerStaleMs));

  /**
   * Projects. A project id only ever arrives as a path segment and is resolved
   * through `requireProject` before anything is read or written, so a foreign
   * id answers 404 instead of quietly returning somebody else's rows — and no
   * body field can move an agent between projects behind the user's back.
   */
  app.get("/projects", async () => listProjects(db, tenantId));
  app.post("/projects", async (request, reply) => {
    const project = await createProject(db, tenantId, parse(projectBody, request.body));
    reply.status(201);
    return project;
  });
  app.get<{ Params: { id: string } }>("/projects/:id", async (request) => {
    await requireProject(db, tenantId, request.params.id);
    return getProject(db, tenantId, request.params.id);
  });
  app.patch<{ Params: { id: string } }>("/projects/:id", async (request) =>
    updateProject(db, tenantId, request.params.id, parse(projectPatch, request.body)));
  app.delete<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    await deleteProject(db, tenantId, request.params.id);
    reply.status(204);
    return null;
  });
  app.get<{ Params: { id: string } }>("/projects/:id/agents", async (request) => {
    await requireProject(db, tenantId, request.params.id);
    return listProjectAgents(db, tenantId, request.params.id);
  });
  app.get<{ Params: { id: string } }>("/projects/:id/integrations", async (request) => {
    await requireProject(db, tenantId, request.params.id);
    return listProjectIntegrations(db, tenantId, request.params.id, keyring);
  });
  app.get<{ Params: { id: string } }>("/projects/:id/workflows", async (request) => {
    await requireProject(db, tenantId, request.params.id);
    return listProjectWorkflows(db, tenantId, request.params.id);
  });
  app.post<{ Params: { id: string } }>("/projects/:id/workflows", async (request, reply) => {
    await requireProject(db, tenantId, request.params.id);
    const created = await createWorkflow(db, tenantId, request.params.id, parse(workflowBody, request.body));
    reply.status(201);
    return created;
  });

  /**
   * Workflows are addressed by their own id, never by a project in the body:
   * `requireWorkflow` resolves the row under the session tenant and carries the
   * `projectId` that every node reference is then checked against. A graph is
   * saved as one document with the version it was loaded at, so a stale canvas
   * is refused rather than silently overwriting somebody else's edit.
   */
  app.get<{ Params: { id: string } }>("/workflows/:id", async (request) => {
    await requireWorkflow(db, tenantId, request.params.id);
    return getWorkflow(db, tenantId, request.params.id);
  });
  app.patch<{ Params: { id: string } }>("/workflows/:id", async (request) =>
    updateWorkflow(db, tenantId, request.params.id, parse(workflowPatch, request.body)));
  app.patch<{ Params: { id: string } }>("/workflows/:id/graph", async (request) => {
    const body = parse(graphBody, request.body);
    return saveGraph(db, tenantId, request.params.id, { definition: body.definition, expectedVersion: body.expectedVersion });
  });
  app.post<{ Params: { id: string } }>("/workflows/:id/validate", async (request) =>
    validateWorkflow(db, tenantId, request.params.id));

  /**
   * A real run of a real graph: the message is queued the way a channel event
   * would queue it, and the reply comes from the provider. 202 because nothing
   * has happened yet — the run row says RUNNING and the canvas polls it. The
   * worker, not this request, does the model call, so a slow Ollama cannot hold
   * a console tab open (docs/plan-architecture.md invariant 1).
   */
  app.post<{ Params: { id: string } }>("/workflows/:id/runs", async (request, reply) => {
    const started = await startTestRun(db, queue, tenantId, request.params.id, parse(runStartBody, request.body).message);
    reply.status(202);
    return started;
  });
  app.get<{ Params: { id: string } }>("/workflows/:id/runs", async (request) => {
    await requireWorkflow(db, tenantId, request.params.id);
    return listWorkflowRuns(db, tenantId, request.params.id);
  });
  /**
   * One run with its node rows — the live overlay. Addressed by the run's own id,
   * tenant-scoped, polled at 1s while the graph is moving.
   */
  app.get<{ Params: { id: string } }>("/workflow-runs/:id", async (request) => {
    const run = await getWorkflowRun(db, tenantId, request.params.id);
    if (!run) throw notFound("run_not_found", `run ${request.params.id} is not in this tenant`);
    return run;
  });
  app.patch<{ Params: { id: string } }>("/workflows/:id/status", async (request) =>
    setWorkflowStatus(
      db,
      tenantId,
      request.params.id,
      parse(workflowStatusBody, request.body).status,
      workerStaleMs,
      probeTools,
    ));
  app.delete<{ Params: { id: string } }>("/workflows/:id", async (request, reply) => {
    await deleteWorkflow(db, tenantId, request.params.id);
    reply.status(204);
    return null;
  });

  app.get("/agents", async () => listAgents(db, tenantId));
  app.get<{ Params: { id: string } }>("/agents/:id", async (request) => {
    const agent = await getAgent(db, tenantId, request.params.id);
    if (!agent) throw notFound("agent_not_found", `agent ${request.params.id} is not in this tenant`);
    return agent;
  });
  app.post("/agents", async (request, reply) => {
    const agent = await createAgent(db, tenantId, parse(agentCreate, request.body));
    reply.status(201);
    return agent;
  });
  /**
   * The project route is the same create with the path id winning: an agent
   * made from inside a project belongs to that project, and the id is resolved
   * through `requireProject` first so a foreign one answers 404 rather than
   * filing an agent into somebody else's workspace.
   */
  app.post<{ Params: { id: string } }>("/projects/:id/agents", async (request, reply) => {
    await requireProject(db, tenantId, request.params.id);
    const agent = await createAgent(db, tenantId, {
      ...parse(agentBody, request.body),
      projectId: request.params.id,
    });
    reply.status(201);
    return agent;
  });
  app.patch<{ Params: { id: string } }>("/agents/:id", async (request) =>
    updateAgent(db, tenantId, request.params.id, parse(agentPatch, request.body)));
  app.patch<{ Params: { id: string } }>("/agents/:id/status", async (request) =>
    setAgentStatus(db, tenantId, request.params.id, parse(statusBody, request.body).status));
  app.delete<{ Params: { id: string } }>("/agents/:id", async (request, reply) => {
    await deleteAgent(db, tenantId, request.params.id);
    reply.status(204);
    return null;
  });

  app.get<{ Params: { id: string } }>("/agents/:id/integrations", async (request) =>
    listAgentBindings(db, tenantId, request.params.id, keyring));
  app.post<{ Params: { id: string } }>("/agents/:id/integrations", async (request) =>
    attachIntegration(db, tenantId, request.params.id, parse(bindingBody, request.body), keyring));
  app.delete<{ Params: { id: string; integrationId: string } }>("/agents/:id/integrations/:integrationId", async (request, reply) => {
    await detachIntegration(db, tenantId, request.params.id, request.params.integrationId);
    reply.status(204);
    return null;
  });

  app.post<{ Params: { id: string } }>("/agents/:id/run", async (request) =>
    runAgent(db, tenantId, request.params.id, parse(runBody, request.body), providerConfig));

  /**
   * Skills. A builtin reads as a skill with `origin: BUILTIN` and cannot be
   * edited or deleted, which is what keeps one honest property: everything the
   * console lists is something this build actually does.
   */
  app.get("/skills", async () => listSkills(db, tenantId));
  /**
   * The registry's own vocabulary — legal requirement names, grantable tools and
   * the size limits — so the editor offers what the validator enforces instead of
   * keeping a second copy that can drift. Static segment, and find-my-way ranks a
   * static path above `/skills/:id`, so this never reaches the id lookup.
   */
  app.get("/skills/registry", async () => skillRegistry());
  app.post("/skills", async (request, reply) => {
    const skill = await createSkill(db, tenantId, parse(skillBody, request.body));
    reply.status(201);
    return skill;
  });
  app.get<{ Params: { id: string } }>("/skills/:id", async (request) => getSkill(db, tenantId, request.params.id));
  app.patch<{ Params: { id: string } }>("/skills/:id", async (request) =>
    updateSkill(db, tenantId, request.params.id, parse(skillBody, request.body)));
  app.post<{ Params: { id: string } }>("/skills/:id/publish", async (request) =>
    publishSkill(db, tenantId, request.params.id));
  app.patch<{ Params: { id: string } }>("/skills/:id/status", async (request) =>
    setSkillStatus(db, tenantId, request.params.id, parse(skillStatusBody, request.body).status));
  app.delete<{ Params: { id: string } }>("/skills/:id", async (request, reply) => {
    await deleteSkill(db, tenantId, request.params.id);
    reply.status(204);
    return null;
  });

  /**
   * What one agent is allowed to have, and what this build can actually honour.
   * The PUT is replace-all and returns the resolved view, so the write and the
   * read of the same screen are one round trip.
   */
  app.get<{ Params: { id: string } }>("/agents/:id/capabilities", async (request) =>
    describeCapabilities(db, tenantId, request.params.id));
  app.put<{ Params: { id: string } }>("/agents/:id/capabilities", async (request) =>
    replaceCapabilities(db, tenantId, request.params.id, parse(grantsBody, request.body).capabilities));
  app.get<{ Params: { id: string }; Querystring: { surface?: string } }>("/agents/:id/capabilities/preview", async (request) => {
    const { surface } = parse(previewQuery, request.query ?? {});
    return previewAssembly(db, tenantId, request.params.id, surface === "public");
  });

  /**
   * Knowledge. The documents live in the agent's project and are reached two ways:
   * through the agent (list / paste / search, because "what can *this* agent read" is
   * the question the tab asks) and by their own id (read / delete / re-index, because
   * a document is one row, not a subresource of whichever agent happened to upload it).
   * Neither path takes a `tenantId` or a `projectId` from the body.
   */
  app.get<{ Params: { id: string } }>("/agents/:id/knowledge", async (request) => listAgentKnowledge(db, tenantId, request.params.id));
  app.post<{ Params: { id: string } }>("/agents/:id/knowledge", async (request, reply) => {
    const written = await addKnowledgeNote(db, queue, tenantId, request.params.id, parse(noteBody, request.body));
    reply.status(201);
    return written;
  });
  /**
   * The search box, and the honest one: it resolves the readable scope through the
   * same `loadCapabilities` a turn uses, so what it returns is what the agent could
   * have found — no model call, no tokens, and the `backend` field says which engine
   * answered rather than leaving "no results" ambiguous.
   */
  app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string } }>("/agents/:id/knowledge/search", async (request) => {
    const { q, limit } = parse(knowledgeSearchQuery, request.query ?? {});
    return searchAgentKnowledge(db, tenantId, request.params.id, q, limit, makeQueryEmbedder(providerConfig));
  });
  app.get<{ Params: { id: string } }>("/knowledge/:id", async (request) => getKnowledgeDoc(db, tenantId, request.params.id));
  app.delete<{ Params: { id: string } }>("/knowledge/:id", async (request, reply) => {
    await deleteKnowledgeDoc(db, tenantId, request.params.id);
    reply.status(204);
    return null;
  });
  app.post<{ Params: { id: string } }>("/knowledge/:id/reindex", async (request) =>
    reindexKnowledgeDoc(db, queue, tenantId, request.params.id));
  // The multipart route is its own encapsulated instance, because the 8 MiB file cap
  // it needs must not become the body limit of every other route in the API.
  registerKnowledgeUpload(app, { db, queue, tenantId });

  /**
   * The agent's own site. GET answers null until one is saved; PUT always queues a
   * fresh crawl and returns the row that crawl is about to fill; DELETE takes the
   * pages and the grant with it, so the agent stops offering URLs it no longer has.
   */
  app.get<{ Params: { id: string } }>("/agents/:id/site", async (request) => getAgentSite(db, tenantId, request.params.id));
  app.put<{ Params: { id: string } }>("/agents/:id/site", async (request) =>
    saveAgentSite(db, queue, tenantId, request.params.id, parse(siteBody, request.body)));
  app.delete<{ Params: { id: string } }>("/agents/:id/site", async (request, reply) => {
    await deleteAgentSite(db, tenantId, request.params.id);
    reply.status(204);
    return null;
  });

  /**
   * The widget, from the operator's side. A key is a public identifier, so creating
   * or rotating one is not a secret write — but it is returned exactly once, and the
   * row keeps only its hash. The snippet's origin is the origin this request arrived
   * on, which in development is the proxied API port and in production is the host
   * the operator typed.
   */
  app.get<{ Params: { id: string } }>("/agents/:id/embeds", async (request) =>
    listAgentEmbeds(db, tenantId, request.params.id, embedBundle));
  app.post<{ Params: { id: string } }>("/agents/:id/embeds", async (request, reply) => {
    const body = parse(embedCreateBody, request.body);
    const created = await createEmbed(db, tenantId, request.params.id, body, {
      apiOrigin: apiOriginOf(request),
      bundle: embedBundle,
    });
    reply.status(201);
    return created;
  });
  app.patch<{ Params: { id: string } }>("/embeds/:id", async (request) =>
    updateEmbed(db, tenantId, request.params.id, parse(embedPatchBody, request.body)));
  app.post<{ Params: { id: string } }>("/embeds/:id/rotate", async (request) =>
    rotateEmbedKey(db, tenantId, request.params.id, { apiOrigin: apiOriginOf(request), bundle: embedBundle }));
  app.delete<{ Params: { id: string } }>("/embeds/:id", async (request, reply) => {
    await deleteEmbed(db, tenantId, request.params.id);
    reply.status(204);
    return null;
  });
  app.get<{ Params: { id: string } }>("/embeds/:id/rates", async (request) =>
    ({ rates: await listEmbedRates(db, tenantId, request.params.id) }));

  /**
   * Insights read `EmbedFeedback` — the worker's own classification rows. A
   * project view counts every widget the project owns; a widget view counts one.
   * The `sentiment` filter narrows the listed questions, never the totals, so a
   * filtered list cannot be mistaken for "fewer visitors felt that way".
   */
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>("/projects/:id/insights", async (request) => {
    await requireProject(db, tenantId, request.params.id);
    return projectInsights(db, tenantId, request.params.id, parse(insightsQuery, request.query));
  });
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>("/embeds/:id/insights", async (request) =>
    embedInsights(db, tenantId, request.params.id, parse(insightsQuery, request.query)));

  /**
   * Sheets read what `make_sheet` wrote. The list is project-scoped; the detail is
   * tenant-scoped and returns rows in stored order. Nothing here writes: a table the
   * model did not produce is not something the console can invent.
   */
  app.get<{ Params: { id: string } }>("/projects/:id/sheets", async (request) => {
    await requireProject(db, tenantId, request.params.id);
    return { sheets: await listProjectSheets(db, tenantId, request.params.id) };
  });
  app.get<{ Params: { id: string } }>("/sheets/:id", async (request) => getSheet(db, tenantId, request.params.id));
  /**
   * An explicit push of one stored sheet into Google Sheets. The in-app rows stay
   * authoritative; the row records the success or the reason, so a Google failure is
   * visible on the sheet instead of in a log nobody reads.
   */
  app.post<{ Params: { id: string } }>("/sheets/:id/export", async (request) =>
    pushSheetToSheets(db, keyring, tenantId, request.params.id, parse(sheetExportBody, request.body ?? {})));

  /**
   * Activity. `AgentRun` rows are direct/playground turns; workflow node rows
   * are the AGENT/ORCHESTRATOR nodes of a graph run. Both are read under the
   * session tenant, and every item carries the ids the drawer needs to open the
   * run that produced it.
   */
  app.get("/activity", async (request) => listActivity(db, tenantId, parse(activityQuery, request.query)));
  app.get("/agent-runs", async (request) => {
    const query = parse(agentRunsQuery, request.query);
    return listAgentRuns(db, tenantId, {
      ...(query.agentId ? { agentId: query.agentId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.before ? { before: new Date(query.before) } : {}),
      limit: query.limit,
    });
  });
  app.get<{ Params: { id: string } }>("/agent-runs/:id", async (request) => {
    const run = await getAgentRun(db, tenantId, request.params.id);
    if (!run) throw notFound("run_not_found", `run ${request.params.id} is not in this tenant`);
    return run;
  });
  app.get<{ Params: { id: string } }>("/agents/:id/runs", async (request) => {
    const agent = await getAgent(db, tenantId, request.params.id);
    if (!agent) throw notFound("agent_not_found", `agent ${request.params.id} is not in this tenant`);
    const query = parse(runListQuery, request.query);
    return listAgentRuns(db, tenantId, {
      agentId: request.params.id,
      ...(query.status ? { status: query.status } : {}),
      ...(query.before ? { before: new Date(query.before) } : {}),
      limit: query.limit,
    });
  });
  app.get("/workflow-runs", async (request) =>
    listWorkflowRunsTenant(db, tenantId, parse(workflowRunsQuery, request.query)));

  app.get("/integrations", async () => listIntegrations(db, tenantId, keyring));
  app.post("/integrations", async (request, reply) => {
    const integration = await createIntegration(db, tenantId, parse(integrationBody, request.body), keyring);
    reply.status(201);
    return integration;
  });
  app.patch<{ Params: { id: string } }>("/integrations/:id", async (request) =>
    updateIntegration(db, tenantId, request.params.id, parse(integrationPatch, request.body), keyring));

  app.get("/conversations", async (request) => {
    const query = parse(conversationQuery, request.query);
    return listConversations(db, tenantId, query.agentId);
  });
  app.get<{ Params: { id: string } }>("/conversations/:id/messages", async (request) =>
    listMessages(db, tenantId, request.params.id));

  app.get("/usage", async (request) => listUsage(db, tenantId, parse(usageQuery, request.query).take));
  app.get("/webhook-events", async () => listWebhookEvents(db, tenantId));

  app.get("/tenant", async () => readTenant(db, tenantId));
  app.patch("/tenant", async (request) => updateTenant(db, tenantId, parse(tenantBody, request.body).name));
  app.get("/plans", async () => listPlans(db));

  /**
   * Provider catalog for the agent builder. Models come from the daemon's own
   * `/api/tags`, so the select can only ever offer a model that exists.
   */
  app.get("/providers", async (): Promise<ProviderDto[]> => {
    const names = registeredProviders();
    return Promise.all(
      names.map(async (name): Promise<ProviderDto> => {
        const provider = resolveProvider(name, { config: providerConfig });
        const defaultModel = provider.model;
        if (!provider.listModels) return { name, models: [defaultModel], defaultModel, error: null };
        try {
          const models = await provider.listModels();
          return { name, models: models.length > 0 ? models : [defaultModel], defaultModel, error: null };
        } catch (error) {
          // The configured model stays selectable, but the console is told the
          // live list could not be read instead of being shown a short list.
          return { name, models: [defaultModel], defaultModel, error: error instanceof Error ? error.message : "model list unavailable" };
        }
      }),
    );
  });
}

/** Fastify's own client errors (body limit, malformed JSON) carry a 4xx `statusCode`; keep it instead of reporting 500. */
function clientStatusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" && status >= 400 && status < 500 ? status : null;
}

/** Turns thrown errors into small, stable JSON — never a stack trace. */
export function toReply(error: unknown): { status: number; body: { error: string; message: string; details?: unknown } } {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: error.code, message: error.message, details: error.details } };
  }
  if (error instanceof z.ZodError) {
    return { status: 400, body: { error: "validation_failed", message: error.message } };
  }
  const status = clientStatusOf(error);
  if (status !== null) {
    const raw = (error as { code?: unknown }).code;
    const code = typeof raw === "string" && raw !== "" ? raw.toLowerCase() : "bad_request";
    const message = error instanceof Error && error.message !== "" ? error.message : "the request was rejected";
    return { status, body: { error: code, message } };
  }
  return { status: 500, body: { error: "internal_error", message: "the request could not be completed" } };
}
