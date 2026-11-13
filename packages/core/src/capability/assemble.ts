import type { PrismaClient } from "@prisma/client";
import { HttpError } from "@saas/shared";
import type { AgentTool } from "../agent-run.ts";
import type { QueryEmbedder } from "../knowledge/search.ts";
import type { LoadedCapabilities } from "./load.ts";
import { loadCapabilities } from "./load.ts";
import type { CapabilitySnapshot, CatalogueEntry, Degradation, ToolEntry } from "./snapshot.ts";
import { capabilityHash, effectsOf, sortEntries } from "./snapshot.ts";
import { getToolSpec, type ToolContext, type ToolSpec, type TurnRecord } from "./registry.ts";

/**
 * The assembler: grant rows in, one system prompt and one tool list out.
 *
 * This function is why the console's playground and the worker's graph run cannot
 * drift. Both call `prepareAgentTurn`, so the same agent asked the same question
 * sends the same bytes to the same model whether the message came from a person
 * testing it or from a queued channel event. Two assemblers is how a graph run
 * starts costing something different from a playground message.
 *
 * Fixed section order, because a prompt that varies with row order varies the
 * model's behaviour for no reason: identity, then the skill catalogue, then what
 * the agent was promised but cannot do, then the output contract. Tool *schemas*
 * are not restated in the prompt — they go to the provider's `tools` field, where
 * the model actually reads them — so the prompt carries only what the schema
 * cannot say.
 */

export const DEFAULT_PROMPT_BUDGET_CHARS = 16_000;

export interface RetrievalScope {
  /** The documents this turn may read — from its grants, never from a request body. */
  sourceIds: string[];
  /** True when at least one granted document has finished indexing. */
  indexed: boolean;
}

export interface TurnAssembly {
  systemPrompt: string;
  tools: AgentTool[];
  retrievalScope: RetrievalScope;
  snapshot: CapabilitySnapshot;
  capabilityHash: string;
  degradations: Degradation[];
}

export interface AssembleOptions {
  /**
   * A public surface (the website widget) refuses an unavailable `core` skill
   * instead of degrading it: the widget cannot go live advertising a capability
   * the agent does not have.
   */
  publicSurface?: boolean;
  promptBudgetChars?: number;
  /** Call-site tools that are not registry capabilities — the orchestrator's `subagent`. */
  extraTools?: AgentTool[];
  tenantId?: string;
  db?: PrismaClient;
  /**
   * The embedding path for this surface. Omitted means keyword-only retrieval,
   * which is a working knowledge base; supplied means the tool may try vectors
   * first and fall back per query.
   */
  embedQuery?: QueryEmbedder;
  /** A public turn's sink for sources and buttons; console turns pass nothing. */
  record?: TurnRecord;
}

export function assembleTurn(
  agent: { id: string; name: string; systemPrompt: string },
  loaded: LoadedCapabilities,
  ctx: ToolContext,
  options: AssembleOptions = {},
): TurnAssembly {
  const budget = options.promptBudgetChars ?? DEFAULT_PROMPT_BUDGET_CHARS;
  const readySkills = loaded.skills.filter((skill) => skill.state === "READY");
  // The first READY site with pages is the routing table. A site row that finished
  // crawling but holds no pages is not routable, so it is not chosen.
  const readySite = loaded.sites.find((site) => site.state === "READY" && site.pages.length > 0);

  const tools: AgentTool[] = [];
  const toolEntries: ToolEntry[] = [];
  const degradations: Degradation[] = [...loaded.degradations];
  const pushTool = (tool: AgentTool, grant: "GRANTED" | "DERIVED", spec?: ToolSpec) => {
    // First one wins, and the call-site extras are added first: a tool built for
    // this specific turn closes over *its* run, so it must not be shadowed by a
    // generic registry implementation of the same name.
    if (tools.some((entry) => entry.name === tool.name)) return;
    tools.push(tool);
    toolEntries.push({ key: tool.name, effect: spec?.effect ?? "read", state: "READY", grant });
  };
  for (const extra of options.extraTools ?? []) pushTool(extra, "GRANTED", getToolSpec(extra.name) ?? undefined);

  // Which tool keys this turn can actually honour, before a catalogue needs them.
  const grantedKeys = new Set(loaded.toolGrants.filter((grant) => grant.state === "READY").map((grant) => grant.ref));
  if (loaded.bodies.size > 0) grantedKeys.add("use_skill");
  if (loaded.knowledgeDocs.length > 0) grantedKeys.add("knowledge_search");
  if (readySite !== undefined) grantedKeys.add("find_page");
  for (const extra of options.extraTools ?? []) grantedKeys.add(extra.name);

  // A skill whose body tells the model to call a tool the agent was not granted is
  // a skill that ends in a TOOL_ERROR. It is unavailable, and the reason names the
  // grant the operator forgot.
  const usable = readySkills.filter((skill) => skill.tools.every((tool) => grantedKeys.has(tool)));
  for (const skill of readySkills) {
    if (usable.includes(skill)) continue;
    const missing = skill.tools.filter((tool) => !grantedKeys.has(tool));
    degradations.push({
      kind: "SKILL",
      ref: skill.key,
      reason: `it asks for ${missing.join(", ")}, which this agent has not been granted`,
    });
  }

  // A core skill that cannot be used is a public surface lying, and the widget is
  // the one caller that says so. Checked here rather than at the top because the
  // tool gate above can also make a core skill unusable.
  if (options.publicSurface === true) {
    const blockedCore = loaded.skills.filter(
      (skill) => skill.core === true && skill.state === "UNAVAILABLE" && !usable.some((entry) => entry.key === skill.key),
    );
    const unusableCore = loaded.skills.filter((skill) => skill.core === true && !usable.some((entry) => entry.key === skill.key));
    const offenders = unusableCore.length > 0 ? unusableCore : blockedCore;
    if (offenders.length > 0) {
      throw new HttpError(
        409,
        "capability_unavailable",
        `${agent.name} cannot answer on a public surface: the core skill(s) ${offenders
          .map((skill) => skill.key)
          .join(", ")} are unavailable — ${offenders.map((skill) => skill.reason ?? "its declared tool is not granted").join("; ")}`,
        { skills: offenders.map((skill) => skill.key) },
      );
    }
  }

  const loadable = new Map([...ctx.skills].filter(([key]) => usable.some((skill) => skill.key === key)));
  // One map for both the catalogue and the tool: what `use_skill` will answer for
  // and what the prompt advertises must be the same set, or the enum contradicts
  // the list the model was given.
  //
  // The knowledge scope is rebuilt here from the grants rather than passed through
  // from the caller: the documents a turn may read are decided by what was loaded,
  // so no call site can widen it by handing over a scope of its own.
  const knowledgeDocs = loaded.knowledgeDocs;
  // The caller's own `site` is dropped for the same reason as `knowledge`: the
  // routing table comes from the grant that resolved, and no call site can hand
  // the model a URL the operator did not crawl.
  const { site: _callerSite, ...ctxWithoutSite } = ctx;
  const toolCtx: ToolContext = {
    ...ctxWithoutSite,
    skills: loadable,
    knowledge: {
      docIds: knowledgeDocs.map((doc) => doc.docId),
      titles: knowledgeDocs.map((doc) => doc.title),
    },
    ...(readySite === undefined
      ? {}
      : {
          site: {
            siteId: readySite.siteId ?? readySite.ref,
            rootUrl: readySite.rootUrl,
            host: readySite.host,
            pages: readySite.pages,
          },
        }),
  };

  // The catalogue is only emitted when the agent can open it: a list of skills the
  // model cannot read is an invitation to hallucinate their contents.
  if (usable.length > 0) {
    const useSkill = getToolSpec("use_skill");
    const built = useSkill?.build(toolCtx, (why) => degradations.push({ kind: "TOOL", ref: "use_skill", reason: why }));
    if (built !== undefined && built !== null) {
      pushTool(built, "DERIVED", useSkill ?? undefined);
    } else {
      degradations.push({ kind: "TOOL", ref: "use_skill", reason: "the catalogue could not be made loadable" });
    }
  }

  // Granting a document *is* granting the search: the operator's decision is "this
  // agent may read these files", and a second switch saying "and it may search them"
  // would only be a way to end up with documents nothing can read. A direct TOOL
  // grant still works — `pushTool` keeps the first tool of a name, and the scope is
  // the same list either way.
  if (knowledgeDocs.length > 0) {
    const spec = getToolSpec("knowledge_search");
    const built = spec?.build(toolCtx, (why) => degradations.push({ kind: "TOOL", ref: "knowledge_search", reason: why }));
    if (built !== undefined && built !== null) {
      pushTool(built, "DERIVED", spec ?? undefined);
    } else {
      degradations.push({ kind: "TOOL", ref: "knowledge_search", reason: "the granted documents could not be made searchable" });
    }
  }

  // Granting a site *is* granting routing: the operator's decision is "this agent
  // answers for this website", and a second switch saying "and it may send people
  // to its pages" would only be a way to end up with a crawl nothing can use.
  if (readySite !== undefined) {
    const spec = getToolSpec("find_page");
    const built = spec?.build(toolCtx, (why) => degradations.push({ kind: "TOOL", ref: "find_page", reason: why }));
    if (built !== undefined && built !== null) {
      pushTool(built, "DERIVED", spec ?? undefined);
    } else {
      degradations.push({ kind: "TOOL", ref: "find_page", reason: "the crawled site could not be made routable" });
    }
  }

  for (const grant of loaded.toolGrants) {
    if (grant.state !== "READY" || grant.spec === null) continue;
    const built = grant.spec.build(toolCtx, (why) => degradations.push({ kind: "TOOL", ref: grant.ref, reason: why }));
    if (built === null) {
      degradations.push({ kind: "TOOL", ref: grant.ref, reason: `the tool "${grant.ref}" could not be built for this turn` });
      continue;
    }
    pushTool(built, "GRANTED", grant.spec);
  }

  const catalogue: CatalogueEntry[] = sortEntries(
    loaded.skills.map((skill) => ({
      key: skill.key,
      ref: skill.grantRef,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      origin: skill.origin,
      core: skill.core,
      // The registry's own effect for the tools this skill asks for, so an
      // operator can see that a skill wants a `write` tool before granting it.
      effects: effectsOf(skill.tools),
      state: skill.state,
      ...(skill.reason === undefined ? {} : { reason: skill.reason }),
    })),
  );

  const sections: string[] = [agent.systemPrompt.trim()];

  // Named in the prompt because a model that does not know what it owns will answer
  // from its own training instead of searching. The titles come from the grants that
  // resolved, so a document still indexing is not listed here as something to read.
  if (knowledgeDocs.length > 0) {
    const listed = knowledgeDocs.slice(0, 8).map((doc) => `- ${doc.title}`).join("\n");
    const rest = knowledgeDocs.length > 8 ? `\n- … ${knowledgeDocs.length - 8} more` : "";
    sections.push(
      `## Knowledge you hold\n${listed}${rest}\n\nCall \`knowledge_search\` to read these documents — they are the only ones you have, so a fact that is not among them is not something you know.`,
    );
  }

  if (readySite !== undefined) {
    sections.push(
      `## Pages you can send people to\n${readySite.host} has ${readySite.pages.length} crawled page(s). When the answer is "where do I go", call \`find_page\` first: it answers with a page that exists, and the widget turns it into a button. Never invent a URL — a page that is not in the crawl is not something you can offer.`,
    );
  }

  if (usable.length > 0) {
    const lines = usable
      .map((skill) => `- ${skill.key} — ${skill.name}: ${skill.description}`)
      .join("\n");
    sections.push(
      `## Skills you hold\n${lines}\n\nThe line above is a label, not an instruction. Call \`use_skill\` with the key and read the body before you act on a skill.`,
    );
  }

  if (degradations.length > 0) {
    const lines = degradations.map((entry) => `- ${entry.ref}: ${entry.reason}`).join("\n");
    // Naming the missing capability in the prompt is what stops the model offering
    // it: "I cannot do that" has to be a fact the model knows, not a guess.
    sections.push(`## Not available in this turn\n${lines}\n\nDo not offer, imply or promise any of the above, and do not describe an action you cannot take.`);
  }

  sections.push(
    "## Answering\nAnswer only from what you were given in this conversation, the skills you read, and the tools you were handed. Never invent a page, price, policy, path or product name you have not been given: say what you do not have and what would settle it.",
  );

  const systemPrompt = sections.filter((section) => section !== "").join("\n\n");
  if (systemPrompt.length > budget) {
    const offending = [...catalogue.map((entry) => ({ ref: entry.key, chars: (entry.name + entry.description).length })), ...loaded.toolGrants.map((grant) => ({ ref: grant.ref, chars: 0 }))]
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 5);
    throw new HttpError(
      422,
      "capability_overflow",
      `the assembled prompt is ${systemPrompt.length} characters and the budget is ${budget} — remove capabilities rather than truncating them (largest granted: ${offending.map((entry) => entry.ref).join(", ") || "the agent's own system prompt"})`,
      { chars: systemPrompt.length, budget, offending: offending.map((entry) => entry.ref) },
    );
  }

  const snapshot: CapabilitySnapshot = {
    agentId: agent.id,
    skills: catalogue,
    tools: sortEntries(toolEntries),
    knowledge: [...loaded.knowledge]
      .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
      .map((doc) => ({
        ref: doc.ref,
        docId: doc.docId,
        title: doc.title,
        state: doc.state,
        ...(doc.reason === undefined ? {} : { reason: doc.reason }),
      })),
    sites: [...loaded.sites]
      .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
      .map((site) => ({
        ref: site.ref,
        siteId: site.siteId,
        host: site.host,
        rootUrl: site.rootUrl,
        pageCount: site.pages.length,
        state: site.state,
        ...(site.reason === undefined ? {} : { reason: site.reason }),
      })),
    degradations,
    promptChars: systemPrompt.length,
    promptBudgetChars: budget,
  };

  return {
    systemPrompt,
    tools,
    retrievalScope: { sourceIds: knowledgeDocs.map((doc) => doc.docId), indexed: knowledgeDocs.length > 0 },
    snapshot,
    capabilityHash: capabilityHash(snapshot),
    degradations,
  };
}

/**
 * The one call every turn-making path uses: load the grants this agent has, probe
 * what the world allows, assemble. `extraTools` is how a caller adds a tool that
 * is not a registry capability (the orchestrator's `subagent`) without reaching
 * around the assembler.
 */
export async function prepareAgentTurn(
  db: PrismaClient,
  tenantId: string,
  agentId: string,
  options: AssembleOptions = {},
): Promise<TurnAssembly> {
  const agent = await db.agent.findFirst({
    where: { AND: [{ id: agentId }, { tenantId }] },
    select: { id: true, name: true, systemPrompt: true },
  });
  if (agent === null) throw new HttpError(404, "agent_not_found", `agent ${agentId} is not in this tenant`);
  const loaded = await loadCapabilities(db, tenantId, agentId);
  // The scope handed in is the one the grants produced; `assembleTurn` rebuilds it
  // from `loaded` regardless, so a caller cannot widen what a turn may read.
  return assembleTurn(
    agent,
    loaded,
    {
      db,
      tenantId,
      agentId,
      skills: loaded.bodies,
      knowledge: { docIds: loaded.knowledgeDocs.map((doc) => doc.docId), titles: loaded.knowledgeDocs.map((doc) => doc.title) },
      ...(options.embedQuery === undefined ? {} : { embed: options.embedQuery }),
      ...(options.record === undefined ? {} : { record: options.record }),
    },
    options,
  );
}
