import type { PrismaClient } from "@prisma/client";
import type { CapabilityState, Degradation } from "./snapshot.ts";
import { getToolSpec, type Requirement, type SitePageRef, type SkillBody, type ToolSpec } from "./registry.ts";
import { BUILTIN_SKILLS, type SkillDefinition } from "../skills/catalog.ts";
import { toStringArray } from "../skills/validate.ts";

/**
 * Turning grant rows into something a prompt can be built from.
 *
 * Three rules shape this file:
 *
 * 1. **A grant is a request, not a promise.** Every row resolves to READY or
 *    UNAVAILABLE with a reason, and only READY skills reach the catalogue and
 *    only READY skills reach `use_skill`. The console shows the same list the
 *    model saw, because both read this one function.
 * 2. **A tenant skill is read from its published version, never from the draft
 *    row.** The operator edits `Skill`; the agent runs `SkillVersion`. Reading the
 *    live row would mean an edit mid-conversation changing what the next turn of
 *    the same run does.
 * 3. **Nothing is implicit.** An agent with no grant rows gets no catalogue and no
 *    tools, so a migration gives no existing agent a new capability. What it does
 *    get, unconditionally, is the assembler's one output contract — the line that
 *    says not to invent a page or a price. That is a deliberate change to every
 *    prompt, not a capability, and it is the guard the knowledge phases depend on.
 */

export type CapabilityKindName = "SKILL" | "TOOL" | "KNOWLEDGE" | "SITE";

export interface CapabilityGrant {
  kind: CapabilityKindName;
  ref: string;
  enabled: boolean;
}

export interface ResolvedSkill extends SkillDefinition {
  origin: "BUILTIN" | "TENANT";
  /** The grant that produced this entry — a skill id or a key, exactly as stored. */
  grantRef: string;
  /** The frozen version the body came from; null when nothing was publishable. */
  version: number | null;
  state: CapabilityState;
  reason?: string;
}

export interface ResolvedToolGrant {
  ref: string;
  spec: ToolSpec | null;
  state: CapabilityState;
  reason?: string;
}

/**
 * A knowledge grant, resolved against the document it names. `ref` is what the
 * operator wrote; `docId` is what the row turned out to be, and null when nothing
 * answered — which the console shows rather than hides.
 */
export interface ResolvedKnowledge {
  ref: string;
  docId: string | null;
  title: string;
  status: string;
  state: CapabilityState;
  reason?: string;
}

/**
 * A site grant, resolved against the crawl it names. `pages` is empty unless the
 * crawl finished, because a button may only point at a page that was actually
 * fetched — the routing scope is the table, not the root URL.
 */
export interface ResolvedSite {
  ref: string;
  /** Null when the grant names a site that is gone: the intent is still recorded. */
  siteId: string | null;
  rootUrl: string;
  host: string;
  status: string;
  pageCount: number;
  state: CapabilityState;
  reason?: string;
  pages: SitePageRef[];
}

/** What has to be true in the world for a `requires` entry to be satisfiable. */
export interface WorldState {
  knowledge: boolean;
  embeddings: boolean;
  site: boolean;
}

export interface LoadedCapabilities {
  grants: CapabilityGrant[];
  skills: ResolvedSkill[];
  toolGrants: ResolvedToolGrant[];
  knowledge: ResolvedKnowledge[];
  /** READY documents only. This is the scope `knowledge_search` may read, and nothing else. */
  knowledgeDocs: { docId: string; title: string }[];
  sites: ResolvedSite[];
  /** READY skills only. This is the map `use_skill` answers from. */
  bodies: Map<string, SkillBody>;
  world: WorldState;
  /** Grants this build could not honour — persisted on the run and shown in the console. */
  degradations: Degradation[];
}

/**
 * Why each requirement is unmet right now, for the requirement this build cannot
 * probe yet. `knowledge` is probed — an indexed document in this tenant — since the
 * keyword search phase. The rest are replaced by a real query in the phase that owns
 * the thing: the embedding model list (P3), the site crawl (P5). A requirement with
 * no probe is reported as unavailable rather than assumed true, because an assumed
 * `true` is how a capability ends up advertised in a prompt that cannot deliver it.
 */
const UNPROVEN: Record<Requirement, string> = {
  knowledge: "this tenant has no indexed knowledge source yet — grant a document that has finished indexing",
  embeddings: "no chunk of this tenant has a vector embedding yet — the embedding lane has not completed for any document",
  site: "no site has been crawled for this tenant yet",
};

export async function probeWorldState(db: PrismaClient, tenantId: string): Promise<WorldState> {
  // One count, not a list: the question is "is there anything to search at all".
  // Which documents a *specific* agent may read is the grants' business, below.
  const indexed = await db.knowledgeDoc.count({ where: { AND: [{ tenantId }, { status: "INDEXED" }] } });
  return { knowledge: indexed > 0, embeddings: await anyEmbedding(db, tenantId), site: await anyCrawledSite(db, tenantId) };
}

/**
 * Whether this tenant has a site that finished a crawl. Tenant-wide on purpose:
 * a `requires: ["site"]` is about the build's world, and which agent owns the
 * site is the SITE grant's business — the same split as knowledge.
 * An older schema or a test double reads as unavailable, never as met.
 */
async function anyCrawledSite(db: PrismaClient, tenantId: string): Promise<boolean> {
  try {
    const ready = await db.site.count({ where: { AND: [{ tenantId }, { status: "READY" }] } });
    return ready > 0;
  } catch {
    return false;
  }
}

/**
 * Whether the semantic half exists for this tenant, asked of the rows rather than
 * of the provider: `core` cannot reach config or the daemon, and "there is at least
 * one vector I may compare against" is the fact a requirement actually needs.
 * A database that cannot answer — an older schema, a test double — reads as
 * unavailable, because an unproven requirement must never be advertised as met.
 */
async function anyEmbedding(db: PrismaClient, tenantId: string): Promise<boolean> {
  try {
    const rows = await db.$queryRaw<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM "KnowledgeChunkEmbedding" e
        JOIN "KnowledgeChunk" c ON c."id" = e."chunkId"
        WHERE c."tenantId" = ${tenantId}
      ) AS "present"`;
    return rows[0]?.present === true;
  } catch {
    return false;
  }
}

export async function loadCapabilities(
  db: PrismaClient,
  tenantId: string,
  agentId: string,
): Promise<LoadedCapabilities> {
  const rows = await db.agentCapability.findMany({
    where: { AND: [{ agentId }, { tenantId }] },
    select: { kind: true, ref: true, enabled: true },
    orderBy: [{ kind: "asc" }, { ref: "asc" }],
  });
  const grants: CapabilityGrant[] = rows.map((row) => ({
    kind: row.kind as CapabilityKindName,
    ref: row.ref,
    enabled: row.enabled,
  }));

  const skillRefs = grants.filter((grant) => grant.kind === "SKILL" && grant.enabled).map((grant) => grant.ref);
  // A grant may name a skill by its id or by its key, so a tenant can write
  // `triage`-style refs in an API call without knowing the cuid.
  const tenantRows =
    skillRefs.length === 0
      ? []
      : await db.skill.findMany({
          where: { AND: [{ tenantId }, { OR: [{ id: { in: skillRefs } }, { key: { in: skillRefs } }] }] },
          select: {
            id: true,
            key: true,
            name: true,
            description: true,
            status: true,
            core: true,
            requires: true,
            tools: true,
            activeVersionId: true,
            latestVersion: true,
          },
        });
  const versionIds = tenantRows.map((row) => row.activeVersionId).filter((id): id is string => id !== null);
  const versions =
    versionIds.length === 0
      ? []
      : await db.skillVersion.findMany({
          where: { id: { in: versionIds } },
          select: { id: true, versionNumber: true, instructions: true },
        });
  const versionById = new Map(versions.map((version) => [version.id, version]));

  const world = await probeWorldState(db, tenantId);
  const degradations: Degradation[] = [];
  const skills: ResolvedSkill[] = [];
  const bodies = new Map<string, SkillBody>();

  for (const grant of grants.filter((entry) => entry.kind === "SKILL")) {
    if (!grant.enabled) continue;
    const builtin = BUILTIN_SKILLS.find((skill) => skill.key === grant.ref) ?? null;
    const row = tenantRows.find((candidate) => candidate.id === grant.ref || candidate.key === grant.ref) ?? null;
    if (builtin === null && row === null) {
      skills.push({
        key: grant.ref,
        grantRef: grant.ref,
        name: grant.ref,
        description: "",
        instructions: "",
        requires: [],
        tools: [],
        core: false,
        origin: "TENANT",
        version: null,
        state: "UNAVAILABLE",
        reason: `no skill named "${grant.ref}" is published in this tenant`,
      });
      degradations.push({ kind: "SKILL", ref: grant.ref, reason: `no skill named "${grant.ref}" is published in this tenant` });
      continue;
    }

    const definition: SkillDefinition =
      builtin ??
      {
        key: row!.key,
        name: row!.name,
        description: row!.description,
        instructions: "",
        requires: toStringArray(row!.requires) as Requirement[],
        tools: toStringArray(row!.tools),
        core: row!.core,
      };

    let instructions = definition.instructions;
    let version: number | null = builtin !== null ? 1 : null;
    let state: CapabilityState = "READY";
    let reason: string | undefined;

    if (builtin === null && row !== null) {
      const versionRow = row.activeVersionId === null ? undefined : versionById.get(row.activeVersionId);
      if (row.status !== "PUBLISHED") {
        state = "UNAVAILABLE";
        reason = `this skill is ${row.status.toLowerCase()}, not published`;
      } else if (versionRow === undefined) {
        state = "UNAVAILABLE";
        reason = "this skill has no published version to read — publish it before granting it";
      } else {
        instructions = versionRow.instructions;
        version = versionRow.versionNumber;
      }
    }

    const unmet = definition.requires.filter((entry) => !world[entry]);
    if (unmet.length > 0 && state === "READY") {
      state = "UNAVAILABLE";
      reason = unmet.map((entry) => UNPROVEN[entry]).join("; ");
    }

    const skillName = definition.name;
    skills.push({
      ...definition,
      grantRef: grant.ref,
      instructions,
      origin: builtin ? "BUILTIN" : "TENANT",
      version,
      state,
      ...(reason === undefined ? {} : { reason }),
    });
    if (state === "READY") {
      bodies.set(definition.key, {
        key: definition.key,
        name: skillName,
        instructions,
        version: version ?? 0,
      });
    } else {
      degradations.push({ kind: "SKILL", ref: grant.ref, reason: reason ?? "this skill is unavailable" });
    }
  }

  const toolGrants: ResolvedToolGrant[] = [];
  for (const grant of grants.filter((entry) => entry.kind === "TOOL")) {
    if (!grant.enabled) continue;
    const spec = getToolSpec(grant.ref);
    if (spec === null) {
      const reason = `this build's registry has no tool named "${grant.ref}"`;
      toolGrants.push({ ref: grant.ref, spec: null, state: "UNAVAILABLE", reason });
      degradations.push({ kind: "TOOL", ref: grant.ref, reason });
      continue;
    }
    const missing = spec.requires.filter((entry) => !world[entry]);
    if (missing.length > 0) {
      const reason = missing.map((entry) => UNPROVEN[entry]).join("; ");
      toolGrants.push({ ref: grant.ref, spec, state: "UNAVAILABLE", reason });
      degradations.push({ kind: "TOOL", ref: grant.ref, reason });
      continue;
    }
    toolGrants.push({ ref: grant.ref, spec, state: "READY" });
  }

  const knowledgeRefs = grants.filter((entry) => entry.kind === "KNOWLEDGE" && entry.enabled).map((entry) => entry.ref);
  const docRows =
    knowledgeRefs.length === 0
      ? []
      : await db.knowledgeDoc.findMany({
          where: { AND: [{ tenantId }, { id: { in: knowledgeRefs } }] },
          select: { id: true, title: true, status: true, error: true },
        });
  const knowledge: ResolvedKnowledge[] = [];
  const knowledgeDocs: { docId: string; title: string }[] = [];
  for (const grant of grants.filter((entry) => entry.kind === "KNOWLEDGE")) {
    if (!grant.enabled) continue;
    const row = docRows.find((doc) => doc.id === grant.ref) ?? null;
    if (row === null) {
      // A grant whose document is gone keeps its row and says so: deleting it would
      // erase the operator's intent, and answering as though it were searchable
      // would be worse.
      const reason = `no knowledge source with the id "${grant.ref}" is in this tenant`;
      knowledge.push({ ref: grant.ref, docId: null, title: grant.ref, status: "MISSING", state: "UNAVAILABLE", reason });
      degradations.push({ kind: "KNOWLEDGE", ref: grant.ref, reason });
      continue;
    }
    const reason =
      row.status === "INDEXED"
        ? undefined
        : row.status === "FAILED"
          ? `indexing failed: ${row.error ?? "no reason was recorded"}`
          : `it is ${row.status.toLowerCase()} and not searchable yet`;
    knowledge.push({
      ref: grant.ref,
      docId: row.id,
      title: row.title,
      status: row.status,
      state: reason === undefined ? "READY" : "UNAVAILABLE",
      ...(reason === undefined ? {} : { reason }),
    });
    if (reason === undefined) knowledgeDocs.push({ docId: row.id, title: row.title });
    else degradations.push({ kind: "KNOWLEDGE", ref: grant.ref, reason });
  }

  const siteRefs = grants.filter((entry) => entry.kind === "SITE" && entry.enabled).map((entry) => entry.ref);
  const siteRows =
    siteRefs.length === 0
      ? []
      : await db.site.findMany({
          where: { AND: [{ tenantId }, { id: { in: siteRefs } }] },
          select: { id: true, rootUrl: true, host: true, status: true, error: true, pageCount: true },
        });
  const readySiteIds = siteRows.filter((row) => row.status === "READY").map((row) => row.id);
  const pageRows =
    readySiteIds.length === 0
      ? []
      : await db.sitePage.findMany({
          where: { AND: [{ tenantId }, { siteId: { in: readySiteIds } }] },
          select: { siteId: true, url: true, path: true, title: true, summary: true, intent: true },
          orderBy: { path: "asc" },
          // Far above the crawl cap; the limit exists so a pathological table cannot
          // make one turn read a whole site into memory.
          take: 400,
        });
  const pagesBySite = new Map<string, SitePageRef[]>();
  for (const row of pageRows) {
    const list = pagesBySite.get(row.siteId) ?? [];
    list.push({ url: row.url, path: row.path, title: row.title, summary: row.summary, intent: row.intent });
    pagesBySite.set(row.siteId, list);
  }
  const sites: ResolvedSite[] = [];
  for (const grant of grants.filter((entry) => entry.kind === "SITE")) {
    if (!grant.enabled) continue;
    const row = siteRows.find((candidate) => candidate.id === grant.ref) ?? null;
    if (row === null) {
      const reason = `no site with the id "${grant.ref}" is in this tenant`;
      sites.push({ ref: grant.ref, siteId: null, rootUrl: "", host: "", status: "MISSING", pageCount: 0, state: "UNAVAILABLE", reason, pages: [] });
      degradations.push({ kind: "SITE", ref: grant.ref, reason });
      continue;
    }
    const pages = pagesBySite.get(row.id) ?? [];
    const reason =
      row.status === "READY"
        ? pages.length === 0
          ? `the crawl of ${row.host} recorded no pages, so there is nowhere to route a visitor`
          : undefined
        : row.status === "FAILED"
          ? `the last crawl failed: ${row.error ?? "no reason was recorded"}`
          : `the site is ${row.status.toLowerCase()} and has not finished a crawl yet`;
    sites.push({
      ref: grant.ref,
      siteId: row.id,
      rootUrl: row.rootUrl,
      host: row.host,
      status: row.status,
      pageCount: pages.length,
      state: reason === undefined ? "READY" : "UNAVAILABLE",
      ...(reason === undefined ? {} : { reason }),
      pages,
    });
    if (reason !== undefined) degradations.push({ kind: "SITE", ref: grant.ref, reason });
  }

  // A skill that asks for a tool by name gets it only if that tool is READY from a
  // grant or is derivable — the skill does not widen what the operator allowed.
  return { grants, skills, toolGrants, knowledge, knowledgeDocs, sites, bodies, world, degradations };
}
