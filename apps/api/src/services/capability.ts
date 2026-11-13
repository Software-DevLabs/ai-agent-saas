import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { badRequest, conflict, notFound } from "@saas/shared";
import {
  asSkillDraft,
  BUILTIN_SKILLS,
  effectsOf,
  getBuiltinSkill,
  getToolSpec,
  isToolKey,
  loadCapabilities,
  prepareAgentTurn,
  REQUIREMENTS,
  SKILL_DESCRIPTION_MAX,
  SKILL_INSTRUCTIONS_WARN_LINES,
  SKILL_KEY_MAX,
  SKILL_NAME_MAX,
  toolKeys,
  toStringArray,
  validateSkill,
  type CapabilitySnapshot,
  type Degradation,
  type Requirement,
  type ToolEffect,
} from "@saas/core";

/**
 * Skills and capability grants, from the console's side.
 *
 * The two halves are deliberately separate. A *skill* is content an operator
 * writes and publishes; a *grant* is the decision to hand it to one agent. An
 * agent's behaviour is the intersection, and `describeCapabilities` reports that
 * intersection through the same `loadCapabilities` a turn uses — so the list on
 * screen is the list the model saw, not a second opinion about it.
 *
 * `PUT /agents/:id/capabilities` is replace-all: the console sends the whole set
 * it is showing and the table ends up equal to it. Merging would make "I unticked
 * a skill" depend on what another tab had done in the meantime.
 */

export interface PublishedRef {
  version: number;
  hash: string;
  publishedAt: string | null;
}

export interface SkillDto {
  /** `builtin:<key>` for code-owned skills, the row id for a tenant's own. */
  id: string;
  key: string;
  name: string;
  description: string;
  origin: "BUILTIN" | "TENANT";
  status: string;
  core: boolean;
  requires: string[];
  tools: string[];
  /** The draft an editor shows. A builtin's draft is its source text. */
  instructions: string;
  latestVersion: number;
  /** The version an agent actually reads, or null when nothing is published. */
  published: PublishedRef | null;
  warnings: string[];
  updatedAt: string | null;
}

export interface GrantDto {
  kind: "SKILL" | "TOOL" | "KNOWLEDGE" | "SITE";
  ref: string;
  enabled: boolean;
  state: "READY" | "UNAVAILABLE";
  label: string;
  reason?: string;
}

export interface CapabilityView {
  agentId: string;
  grants: GrantDto[];
  catalogue: CapabilitySnapshot["skills"];
  tools: CapabilitySnapshot["tools"];
  knowledge: CapabilitySnapshot["knowledge"];
  sites: CapabilitySnapshot["sites"];
  degradations: Degradation[];
  /** Everything grantable right now, so the console renders toggles rather than a text field. */
  available: {
    skills: { key: string; name: string; description: string; origin: "BUILTIN" | "TENANT"; core: boolean; published: boolean }[];
    tools: { key: string; label: string; summary: string; effect: string }[];
    knowledge: { docId: string; title: string; kind: string; status: string; chunkCount: number; charCount: number; indexed: boolean }[];
    sites: { siteId: string; agentId: string; host: string; rootUrl: string; status: string; pageCount: number; crawledAt: string | null }[];
  };
}

export interface SkillInput {
  key?: string;
  name?: string;
  description?: string;
  instructions?: string;
  requires?: unknown;
  tools?: unknown;
  core?: boolean;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const skillSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  status: true,
  core: true,
  requires: true,
  tools: true,
  instructions: true,
  latestVersion: true,
  activeVersionId: true,
  updatedAt: true,
} as const;

type SkillRow = {
  id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  core: boolean;
  requires: unknown;
  tools: unknown;
  instructions: string;
  latestVersion: number;
  activeVersionId: string | null;
  updatedAt: Date;
};

const versionSelect = { versionNumber: true, hash: true, publishedAt: true } as const;
type VersionRow = { versionNumber: number; hash: string; publishedAt: Date };

function toSkillDto(row: SkillRow, published: VersionRow | null, warnings: string[]): SkillDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    origin: "TENANT",
    status: row.status,
    core: row.core,
    requires: toStringArray(row.requires),
    tools: toStringArray(row.tools),
    instructions: row.instructions,
    latestVersion: row.latestVersion,
    published: published === null ? null : { version: published.versionNumber, hash: published.hash, publishedAt: published.publishedAt.toISOString() },
    warnings,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toBuiltinDto(skill: (typeof BUILTIN_SKILLS)[number]): SkillDto {
  return {
    id: `builtin:${skill.key}`,
    key: skill.key,
    name: skill.name,
    description: skill.description,
    origin: "BUILTIN",
    status: "PUBLISHED",
    core: skill.core,
    requires: [...skill.requires],
    tools: [...skill.tools],
    instructions: skill.instructions,
    latestVersion: 1,
    published: { version: 1, hash: sha256(skill.instructions), publishedAt: null },
    warnings: [],
    updatedAt: null,
  };
}

/**
 * What the editor is allowed to offer, straight from the code that enforces it.
 * The console does not keep its own copy of the legal requirement names or the
 * length limits, because a second list drifts the moment the first one changes —
 * and a skill saved with an unprobeable requirement is a skill that silently never
 * becomes available.
 */
export function skillRegistry(): {
  requirements: { name: string; blurb: string }[];
  tools: { key: string; label: string; summary: string; effect: ToolEffect }[];
  limits: { keyMax: number; nameMax: number; descriptionMax: number; instructionsWarnLines: number };
} {
  return {
    requirements: REQUIREMENTS.map((name) => ({ name, blurb: UNPROVEN_HINT[name] })),
    tools: toolKeys().flatMap((key) => {
      const spec = getToolSpec(key);
      return spec === null ? [] : [{ key: spec.key, label: spec.label, summary: spec.summary, effect: spec.effect }];
    }),
    limits: {
      keyMax: SKILL_KEY_MAX,
      nameMax: SKILL_NAME_MAX,
      descriptionMax: SKILL_DESCRIPTION_MAX,
      instructionsWarnLines: SKILL_INSTRUCTIONS_WARN_LINES,
    },
  };
}

/** Says what has to be true for the requirement to be met, in the operator's terms. */
const UNPROVEN_HINT: Record<Requirement, string> = {
  knowledge: "needs at least one indexed knowledge source",
  embeddings: "needs a reachable embedding model",
  site: "needs a crawled site in this project",
};

/** Builtins first: they are part of the build, and a tenant cannot delete them. */
export async function listSkills(db: PrismaClient, tenantId: string): Promise<SkillDto[]> {
  const rows = await db.skill.findMany({ where: { AND: [{ tenantId }] }, orderBy: { key: "asc" }, select: skillSelect });
  const activeIds = rows.map((row) => row.activeVersionId).filter((id): id is string => id !== null);
  const versions =
    activeIds.length === 0
      ? []
      : await db.skillVersion.findMany({ where: { id: { in: activeIds } }, select: { id: true, ...versionSelect } });
  const byId = new Map(versions.map((version) => [version.id, version]));
  return [
    ...BUILTIN_SKILLS.map(toBuiltinDto),
    ...rows.map((row) =>
      toSkillDto(
        row,
        row.activeVersionId === null ? null : (byId.get(row.activeVersionId) ?? null),
        validateSkill(asSkillDraft({ ...row })).warnings,
      ),
    ),
  ];
}

export async function getSkill(db: PrismaClient, tenantId: string, id: string): Promise<SkillDto> {
  const builtin = getBuiltinSkill(id.startsWith("builtin:") ? id.slice("builtin:".length) : id);
  if (id.startsWith("builtin:")) {
    if (builtin === null) throw notFound("skill_not_found", `no built-in skill "${id}"`);
    return toBuiltinDto(builtin);
  }
  const row = await db.skill.findFirst({ where: { AND: [{ id }, { tenantId }] }, select: skillSelect });
  if (row === null) {
    if (builtin !== null) return toBuiltinDto(builtin);
    throw notFound("skill_not_found", `skill ${id} is not in this tenant`);
  }
  const version =
    row.activeVersionId === null
      ? null
      : await db.skillVersion.findFirst({ where: { id: row.activeVersionId }, select: versionSelect });
  return toSkillDto(row, version, validateSkill(asSkillDraft({ ...row })).warnings);
}

/** Only a row this tenant owns, and only through `updateMany` so the clause stays load-bearing. */
async function requireSkill(db: PrismaClient, tenantId: string, id: string): Promise<SkillRow> {
  const row = await db.skill.findFirst({ where: { AND: [{ id }, { tenantId }] }, select: skillSelect });
  if (row === null) throw notFound("skill_not_found", `skill ${id} is not in this tenant`);
  return row;
}

export async function createSkill(db: PrismaClient, tenantId: string, input: SkillInput): Promise<SkillDto> {
  const draft = asSkillDraft(input);
  const validation = validateSkill(draft);
  if (validation.errors.length > 0) {
    throw badRequest("skill_invalid", `the skill cannot be saved: ${validation.errors.join("; ")}`, validation.errors);
  }
  const created = await db.skill.create({
    data: {
      tenantId,
      key: draft.key,
      name: draft.name,
      description: draft.description,
      instructions: draft.instructions,
      requires: draft.requires,
      tools: draft.tools,
      core: draft.core,
      status: "DRAFT",
    },
    select: { id: true },
  });
  return getSkill(db, tenantId, created.id);
}

/**
 * The key never changes: it is what the model types, what a grant stores and what
 * a run's snapshot names. Renaming it would silently repoint every agent that was
 * granted the old one, so a new key means a new skill.
 */
export async function updateSkill(
  db: PrismaClient,
  tenantId: string,
  id: string,
  input: SkillInput,
): Promise<SkillDto> {
  const existing = await requireSkill(db, tenantId, id);
  const draft = asSkillDraft({ ...existing, ...prune(input), key: existing.key });
  const validation = validateSkill(draft);
  if (validation.errors.length > 0) {
    throw badRequest("skill_invalid", `the skill cannot be saved: ${validation.errors.join("; ")}`, validation.errors);
  }
  await db.skill.updateMany({
    where: { AND: [{ id: existing.id }, { tenantId }] },
    data: {
      name: draft.name,
      description: draft.description,
      instructions: draft.instructions,
      requires: draft.requires,
      tools: draft.tools,
      core: draft.core,
    },
  });
  return getSkill(db, tenantId, id);
}

/**
 * Publish = freeze. The version row is what an agent reads, so an edit only
 * becomes live here, and republishing unchanged text says `unchanged: true`
 * rather than minting a version that differs from its predecessor in nothing but
 * its number.
 */
export async function publishSkill(
  db: PrismaClient,
  tenantId: string,
  id: string,
): Promise<SkillDto & { unchanged: boolean }> {
  const row = await requireSkill(db, tenantId, id);
  const draft = asSkillDraft({ ...row });
  const validation = validateSkill(draft);
  if (validation.errors.length > 0) {
    throw badRequest("skill_unpublishable", `this skill cannot be published: ${validation.errors.join("; ")}`, validation.errors);
  }
  const hash = sha256(draft.instructions);
  const active =
    row.activeVersionId === null
      ? null
      : await db.skillVersion.findFirst({ where: { id: row.activeVersionId }, select: { hash: true } });
  if (active !== null && active.hash === hash && row.status === "PUBLISHED") {
    return { ...(await getSkill(db, tenantId, id)), unchanged: true };
  }
  const versionNumber = row.latestVersion + 1;
  const version = await db.skillVersion.create({
    data: { skillId: row.id, versionNumber, instructions: draft.instructions, requires: draft.requires, tools: draft.tools, hash },
    select: { id: true },
  });
  await db.skill.updateMany({
    where: { AND: [{ id: row.id }, { tenantId }] },
    data: { status: "PUBLISHED", latestVersion: versionNumber, activeVersionId: version.id },
  });
  return { ...(await getSkill(db, tenantId, id)), unchanged: false };
}

export async function setSkillStatus(
  db: PrismaClient,
  tenantId: string,
  id: string,
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED",
): Promise<SkillDto> {
  const row = await requireSkill(db, tenantId, id);
  if (status === "PUBLISHED" && row.activeVersionId === null) {
    // Turning the badge on without a body would put a label in the catalogue with
    // nothing behind it. Publish first; that is the action that means something.
    throw conflict("skill_unpublished", `skill ${row.key} has no published version — publish it before activating it`);
  }
  await db.skill.updateMany({ where: { AND: [{ id: row.id }, { tenantId }] }, data: { status } });
  return getSkill(db, tenantId, id);
}

export async function deleteSkill(db: PrismaClient, tenantId: string, id: string): Promise<void> {
  const row = await requireSkill(db, tenantId, id);
  const granted = await db.agentCapability.count({
    where: { AND: [{ tenantId }, { kind: "SKILL" }, { OR: [{ ref: row.id }, { ref: row.key }] }] },
  });
  if (granted > 0) throw conflict("skill_in_use", `this skill is granted to ${granted} agent(s); remove those grants first`);
  await db.skill.delete({ where: { id: row.id } });
}

const prune = (input: SkillInput): SkillInput =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as SkillInput;

// --- grants ------------------------------------------------------------------

export interface GrantInput {
  kind: "SKILL" | "TOOL" | "KNOWLEDGE" | "SITE";
  ref: string;
  enabled?: boolean;
}

/**
 * A grant has to name something that exists *now*. The console cannot store a
 * typo and find out at run time: a `TOOL` ref has to be in this build's registry, a
 * `SKILL` ref has to be a skill this tenant owns, and a `KNOWLEDGE` ref has to be a
 * document in this tenant — whether that document is *searchable yet* is a separate
 * question the view answers with a state and a reason, not one settled by a 400.
 */
async function assertResolvable(db: PrismaClient, tenantId: string, grant: GrantInput): Promise<void> {
  const ref = grant.ref.trim();
  if (ref === "") throw badRequest("capability_ref_required", "a capability grant needs a ref");
  if (grant.kind === "TOOL") {
    if (!isToolKey(ref)) {
      throw badRequest("capability_tool_unknown", `this build's registry has no tool "${ref}" — available: ${toolKeys().join(", ")}`);
    }
    return;
  }
  if (grant.kind === "KNOWLEDGE") {
    const doc = await db.knowledgeDoc.findFirst({ where: { AND: [{ tenantId }, { id: ref }] }, select: { id: true } });
    if (doc === null) throw badRequest("capability_knowledge_unknown", `no knowledge document "${ref}" is in this tenant`);
    return;
  }
  if (grant.kind === "SITE") {
    const site = await db.site.findFirst({ where: { AND: [{ tenantId }, { id: ref }] }, select: { id: true } });
    if (site === null) throw badRequest("capability_site_unknown", `no crawled site "${ref}" is in this tenant`);
    return;
  }
  if (getBuiltinSkill(ref) !== null) return;
  const row = await db.skill.findFirst({
    where: { AND: [{ tenantId }, { OR: [{ id: ref }, { key: ref }] }] },
    select: { id: true },
  });
  if (row === null) throw badRequest("capability_skill_unknown", `no skill "${ref}" exists in this tenant`);
}

export async function describeCapabilities(db: PrismaClient, tenantId: string, agentId: string): Promise<CapabilityView> {
  const agent = await db.agent.findFirst({ where: { AND: [{ id: agentId }, { tenantId }] }, select: { id: true, projectId: true } });
  if (agent === null) throw notFound("agent_not_found", `agent ${agentId} is not in this tenant`);

  const loaded = await loadCapabilities(db, tenantId, agentId);
  const rows = await db.agentCapability.findMany({
    where: { AND: [{ agentId }, { tenantId }] },
    orderBy: [{ kind: "asc" }, { ref: "asc" }],
    select: { kind: true, ref: true, enabled: true },
  });
  const byRef = new Map(loaded.skills.map((skill) => [skill.grantRef, skill]));
  const toolByRef = new Map(loaded.toolGrants.map((grant) => [grant.ref, grant]));
  const knowledgeByRef = new Map(loaded.knowledge.map((doc) => [doc.ref, doc]));
  const siteByRef = new Map(loaded.sites.map((site) => [site.ref, site]));
  const degraded = new Map(loaded.degradations.map((entry) => [entry.ref, entry.reason]));

  const published = await db.skill.findMany({
    where: { AND: [{ tenantId }, { status: "PUBLISHED" }] },
    select: { key: true, name: true, description: true, core: true, activeVersionId: true },
  });
  const docs = await db.knowledgeDoc.findMany({
    where: { AND: [{ tenantId }] },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, kind: true, status: true, chunkCount: true, charCount: true },
  });
  const projectSites = await db.site.findMany({
    where: { AND: [{ tenantId }, { projectId: agent.projectId }] },
    orderBy: { host: "asc" },
    select: { id: true, agentId: true, host: true, rootUrl: true, status: true, pageCount: true, crawledAt: true },
  });

  return {
    agentId,
    grants: rows.map((row) => {
      // One resolved entry per kind, and only ever the kind's own: a document and a
      // skill cannot share a ref, but reading the wrong list would report a healthy
      // grant as broken, which is the failure this table exists to avoid.
      const skill = row.kind === "SKILL" ? byRef.get(row.ref) : undefined;
      const tool = row.kind === "TOOL" ? toolByRef.get(row.ref) : undefined;
      const doc = row.kind === "KNOWLEDGE" ? knowledgeByRef.get(row.ref) : undefined;
      const site = row.kind === "SITE" ? siteByRef.get(row.ref) : undefined;
      const state = skill?.state ?? tool?.state ?? doc?.state ?? site?.state;
      const reason = degraded.get(row.ref) ?? skill?.reason ?? tool?.reason ?? doc?.reason ?? site?.reason;
      const label =
        row.kind === "TOOL"
          ? (getToolSpec(row.ref)?.label ?? row.ref)
          : row.kind === "KNOWLEDGE"
            ? (doc?.title ?? row.ref)
            : row.kind === "SITE"
              ? (site?.host ?? row.ref)
              : (skill?.name ?? row.ref);
      return {
        kind: row.kind as GrantDto["kind"],
        ref: row.ref,
        enabled: row.enabled,
        label,
        state: row.enabled && state === "READY" ? "READY" : "UNAVAILABLE",
        ...(row.enabled ? {} : { reason: "this grant is turned off" }),
        ...(row.enabled && reason !== undefined ? { reason } : {}),
      };
    }),
    catalogue: loaded.skills.map((skill) => ({
      key: skill.key,
      ref: skill.grantRef,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      origin: skill.origin,
      core: skill.core,
      effects: effectsOf(skill.tools),
      state: skill.state,
      ...(skill.reason === undefined ? {} : { reason: skill.reason }),
    })),
    tools: loaded.toolGrants.map((grant) => ({
      key: grant.ref,
      effect: grant.spec?.effect ?? "read",
      state: grant.state,
      grant: "GRANTED" as const,
      ...(grant.reason === undefined ? {} : { reason: grant.reason }),
    })),
    degradations: loaded.degradations,
    knowledge: loaded.knowledge.map((doc) => ({
      ref: doc.ref,
      docId: doc.docId,
      title: doc.title,
      state: doc.state,
      ...(doc.reason === undefined ? {} : { reason: doc.reason }),
    })),
    sites: loaded.sites.map((site) => ({
      ref: site.ref,
      siteId: site.siteId,
      host: site.host,
      rootUrl: site.rootUrl,
      pageCount: site.pages.length,
      state: site.state,
      ...(site.reason === undefined ? {} : { reason: site.reason }),
    })),
    available: {
      skills: [
        ...BUILTIN_SKILLS.map((skill) => ({
          key: skill.key,
          name: skill.name,
          description: skill.description,
          origin: "BUILTIN" as const,
          core: skill.core,
          published: true,
        })),
        ...published.map((skill) => ({
          key: skill.key,
          name: skill.name,
          description: skill.description,
          origin: "TENANT" as const,
          core: skill.core,
          published: skill.activeVersionId !== null,
        })),
      ],
      tools: toolKeys().flatMap((key) => {
        const spec = getToolSpec(key);
        return spec === null ? [] : [{ key: spec.key, label: spec.label, summary: spec.summary, effect: spec.effect }];
      }),
      // Every document the tenant owns, searchable or not: the tickable list is the
      // one that shows a still-indexing file with its status rather than hiding it
      // until the worker gets there.
      knowledge: docs.map((doc) => ({
        docId: doc.id,
        title: doc.title,
        kind: doc.kind,
        status: doc.status,
        chunkCount: doc.chunkCount,
        charCount: doc.charCount,
        indexed: doc.status === "INDEXED",
      })),
      sites: projectSites.map((site) => ({
        siteId: site.id,
        agentId: site.agentId,
        host: site.host,
        rootUrl: site.rootUrl,
        status: site.status,
        pageCount: site.pageCount,
        crawledAt: site.crawledAt === null ? null : site.crawledAt.toISOString(),
      })),
    },
  };
}

export async function replaceCapabilities(
  db: PrismaClient,
  tenantId: string,
  agentId: string,
  input: GrantInput[],
): Promise<CapabilityView> {
  const agent = await db.agent.findFirst({ where: { AND: [{ id: agentId }, { tenantId }] }, select: { id: true } });
  if (agent === null) throw notFound("agent_not_found", `agent ${agentId} is not in this tenant`);

  const seen = new Set<string>();
  for (const grant of input) {
    await assertResolvable(db, tenantId, grant);
    const identity = `${grant.kind}:${grant.ref.trim()}`;
    if (seen.has(identity)) throw badRequest("capability_duplicate", `${identity} is listed twice`);
    seen.add(identity);
  }

  await db.$transaction(async (tx) => {
    await tx.agentCapability.deleteMany({ where: { AND: [{ agentId }, { tenantId }] } });
    for (const grant of input) {
      await tx.agentCapability.create({
        data: { tenantId, agentId, kind: grant.kind, ref: grant.ref.trim(), enabled: grant.enabled ?? true, config: {} },
      });
    }
  });
  return describeCapabilities(db, tenantId, agentId);
}

/**
 * The dry run: the exact prompt and tool list `runAgentTurn` would send, with no
 * provider call and nothing billed. It calls the same `prepareAgentTurn` the run
 * path calls, which is what makes it a preview rather than a guess about one.
 */
export async function previewAssembly(db: PrismaClient, tenantId: string, agentId: string, publicSurface = false) {
  const assembly = await prepareAgentTurn(db, tenantId, agentId, { publicSurface });
  return {
    systemPrompt: assembly.systemPrompt,
    tools: assembly.tools.map((tool) => ({ name: tool.name, description: tool.description })),
    snapshot: assembly.snapshot,
    capabilityHash: assembly.capabilityHash,
    degradations: assembly.degradations,
  };
}
