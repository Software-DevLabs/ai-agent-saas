import type { PrismaClient } from "@prisma/client";
import type { AgentTool } from "../agent-run.ts";
import type { AgentAction, AgentCitation } from "../embed-turn.ts";
import type { QueryEmbedder } from "../knowledge/search.ts";
import { knowledgeSearchSpec } from "../knowledge/tools.ts";
import { findPageSpec } from "../site/tools.ts";
import { makeSheetSpec } from "../sheets/tools.ts";

/**
 * The capability registry: code-owned definitions of what an agent can be *given*.
 *
 * The registry is deliberately not a table. A tool is an implementation, and an
 * implementation cannot be authored by an operator — only the *decision to grant*
 * one can, and that decision is `AgentCapability`. So the description, argument
 * schema and effect come from here, and the database says which of them this agent
 * has. That split is why nothing about a feature is hardcoded into a prompt: the
 * assembler asks the registry, and the registry answers or degrades.
 *
 * A key appears here when and only when its implementation exists. `knowledge_search`
 * joined with the indexer that fills the table it reads; `find_page` joined with the
 * crawler that fills `SitePage`; `make_sheet` joined with the sheets tables and the
 * console tab that renders them — a registry entry with no working body would be the
 * console advertising something that lies.
 */

/** A tool key is a registry key: this map's keys are the whole legal set. */
export type ToolKey = "use_skill" | "knowledge_search" | "find_page" | "make_sheet";

export type ToolEffect = "read" | "write" | "external";

/**
 * Something that has to be true in the world for a capability to be usable.
 * A requirement is *probed*, never assumed: an unmet one makes the capability
 * unavailable, and the reason is shown.
 */
export type Requirement = "knowledge" | "embeddings" | "site";

export const REQUIREMENTS: readonly Requirement[] = ["knowledge", "embeddings", "site"];

/** What `use_skill` hands back: the body the operator wrote, version-frozen. */
export interface SkillBody {
  key: string;
  name: string;
  instructions: string;
  version: number;
}

/**
 * The documents one turn may read, resolved from its grants before the model is
 * asked anything. `titles` exists for the tool description — a model that knows
 * what is in the box calls the tool more sensibly than one that does not.
 */
export interface KnowledgeScope {
  docIds: string[];
  titles: string[];
}

/**
 * One page the agent may route a visitor to. The stored URL is the only thing a
 * button may carry, so this list — produced by the last crawl — *is* the routing
 * permission, not a hint about one.
 */
export interface SitePageRef {
  url: string;
  path: string;
  title: string;
  summary: string;
  intent: string;
}

/** The crawled site a turn was given. Present only when the grant resolved READY. */
export interface SiteScope {
  siteId: string;
  rootUrl: string;
  host: string;
  pages: SitePageRef[];
}

/**
 * What a tool hands back beyond the text the model reads. A public turn has no
 * access to the trace, so the thing that proves the answer — the passage it came
 * from, the page it points at — has to be recorded here or it does not exist for
 * the widget. Console turns pass no sink, which is why they never grow one.
 */
export interface TurnRecord {
  citations?(citations: AgentCitation[]): void;
  actions?(actions: AgentAction[]): void;
}

/** Everything a tool implementation is allowed to touch. Add a field per phase, not per feature. */
export interface ToolContext {
  db: PrismaClient;
  tenantId: string;
  agentId: string;
  /** Resolved skill bodies by key — the catalogue and this map come from one read. */
  skills: ReadonlyMap<string, SkillBody>;
  /** Indexed documents this turn was granted. An empty list means "nothing", never "everything". */
  knowledge: KnowledgeScope;
  /** The crawled site this turn may route into. Absent means "no site", never "the whole web". */
  site?: SiteScope;
  /**
   * Embeds a search query for semantic retrieval. Absent means this entrypoint has
   * no embedder wired, and the turn reads the keyword index — which is a working
   * knowledge base, not a degraded one. The engine that answered is reported.
   */
  embed?: QueryEmbedder;
  /** Present only on a public turn: the only channel from a tool to the widget. */
  record?: TurnRecord;
}

export interface ToolSpec {
  key: ToolKey;
  /** What the console calls it, so a grant list reads as features rather than identifiers. */
  label: string;
  /** One line for the operator; the model gets the description the `build` returns. */
  summary: string;
  effect: ToolEffect;
  requires: Requirement[];
  parameters: Record<string, unknown>;
  /**
   * `null` means "this turn cannot have this tool" and the assembler records the
   * reason as a degradation. Returning a tool that throws on use is forbidden:
   * an unbuildable capability must be absent from the provider request.
   */
  build(ctx: ToolContext, unmet: (why: string) => void): AgentTool | null;
}

/** Unknown ref → `null`, so a grant written by an older build degrades by name. */
export function getToolSpec(ref: string): ToolSpec | null {
  return TOOLS.get(ref as ToolKey) ?? null;
}

export function isToolKey(ref: string): ref is ToolKey {
  return TOOLS.has(ref as ToolKey);
}

export function toolKeys(): ToolKey[] {
  return [...TOOLS.keys()];
}

const USE_SKILL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: { key: { type: "string", description: "The skill to read, exactly as the catalogue lists it." } },
  required: ["key"],
};

const useSkill: ToolSpec = {
  key: "use_skill",
  label: "Read a skill on demand",
  summary:
    "The catalogue of skill names and one-line descriptions sits in the system prompt; this tool returns the full instructions of one skill when the model decides it needs it. Ten skills therefore cost ten lines of prompt instead of ten bodies.",
  effect: "read",
  requires: [],
  parameters: USE_SKILL_PARAMETERS,
  build(ctx, unmet) {
    const keys = [...ctx.skills.keys()].sort();
    if (keys.length === 0) {
      unmet("no published skill is granted to this agent, so there is nothing for the tool to load");
      return null;
    }
    return {
      name: "use_skill",
      description: `Read the full instructions for one of this agent's skills: ${keys.join(", ")}. Call it before acting on a skill — the catalogue line is not the instructions.`,
      parameters: {
        type: "object",
        properties: { key: { type: "string", enum: keys, description: "Which listed skill to load." } },
        required: ["key"],
      },
      // A miss is answered with the catalogue rather than an exception: the model
      // can only correct a mistake it can see.
      execute: async (values) => {
        const key = typeof values.key === "string" ? values.key.trim() : "";
        const skill = key === "" ? undefined : ctx.skills.get(key);
        if (skill === undefined) {
          return `SKILL_ERROR: "${key}" is not one of this turn's skills. Available: ${keys.join(", ")}`;
        }
        return `${skill.name} (skill "${skill.key}", version ${skill.version})\n\n${skill.instructions}`;
      },
    };
  },
};

const TOOLS: ReadonlyMap<ToolKey, ToolSpec> = new Map<ToolKey, ToolSpec>([
  [useSkill.key, useSkill],
  [knowledgeSearchSpec.key, knowledgeSearchSpec],
  [findPageSpec.key, findPageSpec],
  [makeSheetSpec.key, makeSheetSpec],
]);
