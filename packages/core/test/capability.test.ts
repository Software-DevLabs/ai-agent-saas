import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { assembleTurn, DEFAULT_PROMPT_BUDGET_CHARS, prepareAgentTurn } from "../src/capability/assemble.ts";
import { loadCapabilities, type LoadedCapabilities } from "../src/capability/load.ts";
import type { ToolContext } from "../src/capability/registry.ts";
import { BUILTIN_SKILLS } from "../src/skills/catalog.ts";
import { asSkillDraft, validateSkill } from "../src/skills/validate.ts";

/**
 * The capability system's contract is about what the model *sees*, so these tests
 * read the assembled prompt and the built tools rather than any internal map.
 * Everything asserted here is a property the console will claim on screen: the
 * catalogue is a label and not the body, an unmet requirement removes the tool from
 * the provider request, and a prompt that will not fit refuses instead of trimming.
 */

const triage = BUILTIN_SKILLS[0]!;
const agent = { id: "age_1", name: "Front desk", systemPrompt: "You answer for a small hosting company." };

const emptyLoad = (): LoadedCapabilities => ({
  grants: [],
  skills: [],
  toolGrants: [],
  knowledge: [],
  knowledgeDocs: [],
  sites: [],
  bodies: new Map(),
  world: { knowledge: false, embeddings: false, site: false },
  degradations: [],
});

const ctxFor = (bodies: LoadedCapabilities["bodies"]): ToolContext => ({
  db: {} as PrismaClient,
  tenantId: "tnt_one",
  agentId: agent.id,
  skills: bodies,
  // Deliberately empty: the scope a turn may read is rebuilt from `loaded`, so a
  // caller handing over a wider list has to be ignored rather than believed.
  knowledge: { docIds: [], titles: [] },
});

const skillEntry = (over: Partial<LoadedCapabilities["skills"][number]> = {}) => ({
  key: triage.key,
  grantRef: triage.key,
  name: triage.name,
  description: triage.description,
  instructions: triage.instructions,
  requires: [] as LoadedCapabilities["skills"][number]["requires"],
  tools: [] as string[],
  core: false,
  origin: "BUILTIN" as const,
  version: 1,
  state: "READY" as const,
  ...over,
});

const bodiesFor = (skills: LoadedCapabilities["skills"]) =>
  new Map(
    skills
      .filter((skill) => skill.state === "READY")
      .map((skill) => [skill.key, { key: skill.key, name: skill.name, instructions: skill.instructions, version: skill.version ?? 0 }]),
  );

describe("assembleTurn", () => {
  it("gives an agent with no grants no catalogue and no tools", async () => {
    const loaded = emptyLoad();
    const assembly = assembleTurn(agent, loaded, ctxFor(loaded.bodies));
    expect(assembly.tools).toEqual([]);
    expect(assembly.systemPrompt).not.toMatch(/## Skills you hold/);
    expect(assembly.systemPrompt).toContain(agent.systemPrompt);
    // The output contract is not a capability: it is what makes an agent without
    // knowledge refuse to invent a page, and it is on every turn.
    expect(assembly.systemPrompt).toContain("## Answering");
    expect(assembly.degradations).toEqual([]);
    expect(assembly.retrievalScope).toEqual({ sourceIds: [], indexed: false });
  });

  it("puts the catalogue label in the prompt and the body only behind the tool", async () => {
    const skills = [skillEntry()];
    const loaded = { ...emptyLoad(), skills, bodies: bodiesFor(skills) };
    const assembly = assembleTurn(agent, loaded, ctxFor(loaded.bodies));

    expect(assembly.systemPrompt).toContain(`- ${triage.key} — ${triage.name}: ${triage.description}`);
    // The catalogue line legitimately carries the description; what must not
    // appear is the body. If this ever fails, progressive disclosure has silently
    // become "everything in the prompt", which is the cost the lazy load avoids.
    expect(assembly.systemPrompt).not.toContain("Before answering, decide three things");

    const useSkill = assembly.tools.find((tool) => tool.name === "use_skill");
    expect(useSkill).toBeDefined();
    const body = await useSkill!.execute({ key: triage.key });
    expect(body).toContain("Before answering, decide three things");
    expect(body).toContain("version 1");
  });

  it("answers an unknown skill key with the catalogue, not an exception", async () => {
    const skills = [skillEntry()];
    const loaded = { ...emptyLoad(), skills, bodies: bodiesFor(skills) };
    const useSkill = assembleTurn(agent, loaded, ctxFor(loaded.bodies)).tools[0]!;
    const result = await useSkill.execute({ key: "not-a-skill" });
    expect(result).toMatch(/^SKILL_ERROR:/);
    expect(result).toContain(triage.key);
  });

  it("omits an unmet requirement from the request and records why", async () => {
    const skills = [skillEntry({ requires: ["knowledge"] as never, state: "UNAVAILABLE", version: null, reason: "no knowledge source is indexed for this tenant yet" })];
    const loaded = {
      ...emptyLoad(),
      skills,
      bodies: new Map(),
      degradations: [{ kind: "SKILL" as const, ref: triage.key, reason: "no knowledge source is indexed for this tenant yet" }],
    };
    const assembly = assembleTurn(agent, loaded, ctxFor(loaded.bodies));

    expect(assembly.tools).toEqual([]);
    expect(assembly.systemPrompt).not.toContain(`- ${triage.key} —`);
    // The model is told what it cannot do, so it cannot offer to do it.
    expect(assembly.systemPrompt).toContain("## Not available in this turn");
    expect(assembly.systemPrompt).toContain("no knowledge source is indexed");
    expect(assembly.degradations).toHaveLength(1);
    expect(assembly.snapshot.skills[0]!.state).toBe("UNAVAILABLE");
  });

  it("drops a skill whose declared tool was not granted", async () => {
    const skills = [skillEntry({ tools: ["knowledge_search"] })];
    const loaded = { ...emptyLoad(), skills, bodies: bodiesFor(skills) };
    const assembly = assembleTurn(agent, loaded, ctxFor(loaded.bodies));

    expect(assembly.tools).toEqual([]);
    expect(assembly.systemPrompt).not.toContain(`- ${triage.key} —`);
    expect(assembly.degradations[0]!.reason).toContain("knowledge_search");
  });

  it("refuses with the offending list rather than truncating an over-budget prompt", async () => {
    const skills = [skillEntry()];
    const loaded = { ...emptyLoad(), skills, bodies: bodiesFor(skills) };
    expect(() => assembleTurn(agent, loaded, ctxFor(loaded.bodies), { promptBudgetChars: 40 })).toThrowError(
      expect.objectContaining({ code: "capability_overflow" }),
    );
    expect(DEFAULT_PROMPT_BUDGET_CHARS).toBeGreaterThan(40);
  });

  it("refuses a public surface whose core skill is unavailable", async () => {
    const skills = [skillEntry({ core: true, state: "UNAVAILABLE", version: null, reason: "no embedding model is reachable from this build yet" })];
    const loaded = { ...emptyLoad(), skills, bodies: new Map() };
    expect(() => assembleTurn(agent, loaded, ctxFor(loaded.bodies), { publicSurface: true })).toThrowError(
      expect.objectContaining({ code: "capability_unavailable" }),
    );
    // The console path still runs, degraded: only the public surface treats it as fatal.
    expect(() => assembleTurn(agent, loaded, ctxFor(loaded.bodies))).not.toThrow();
  });

  it("hashes identical grants identically and a changed grant differently", async () => {
    const skills = [skillEntry()];
    const loaded = { ...emptyLoad(), skills, bodies: bodiesFor(skills) };
    const first = assembleTurn(agent, loaded, ctxFor(loaded.bodies));
    const second = assembleTurn(agent, { ...emptyLoad(), skills: [...skills], bodies: bodiesFor(skills) }, ctxFor(bodiesFor(skills)));
    expect(first.capabilityHash).toBe(second.capabilityHash);

    const extra = [...skills, skillEntry({ key: "answer-shape", grantRef: "answer-shape", name: "Shape an answer", description: "Structure a reply" })];
    const third = assembleTurn(agent, { ...emptyLoad(), skills: extra, bodies: bodiesFor(extra) }, ctxFor(bodiesFor(extra)));
    expect(third.capabilityHash).not.toBe(first.capabilityHash);
  });

  it("lets a call-site tool win the name, so a specific implementation is not shadowed", async () => {
    const skills = [skillEntry()];
    const loaded = { ...emptyLoad(), skills, bodies: bodiesFor(skills) };
    const mine = { name: "use_skill", description: "the caller's own", parameters: { type: "object" }, execute: async () => "mine" };
    const assembly = assembleTurn(agent, loaded, ctxFor(loaded.bodies), { extraTools: [mine] });
    expect(assembly.tools).toHaveLength(1);
    expect(assembly.tools[0]!.description).toBe("the caller's own");
  });

  it("derives knowledge_search from an indexed grant, and lists the document it may read", async () => {
    const loaded = {
      ...emptyLoad(),
      knowledge: [knowledgeDocEntry()],
      knowledgeDocs: [{ docId: "kns_1", title: "Price list" }],
    };
    const assembly = assembleTurn(agent, loaded, ctxFor(loaded.bodies));
    const tool = assembly.tools.find((entry) => entry.name === "knowledge_search");
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("Price list");
    expect(assembly.snapshot.tools.find((entry) => entry.key === "knowledge_search")).toMatchObject({
      state: "READY",
      grant: "DERIVED",
      effect: "read",
    });
    expect(assembly.systemPrompt).toContain("## Knowledge you hold");
    expect(assembly.retrievalScope).toEqual({ sourceIds: ["kns_1"], indexed: true });
  });

  it("takes the readable documents from the grants, never from the context it was handed", async () => {
    const loaded = {
      ...emptyLoad(),
      knowledge: [knowledgeDocEntry()],
      knowledgeDocs: [{ docId: "kns_1", title: "Price list" }],
    };
    // A caller that tries to widen the scope with a document nobody granted has to
    // be ignored: the description is built from the granted titles, so the leak would
    // be visible in the very string the model is given.
    const widened: ToolContext = { ...ctxFor(loaded.bodies), knowledge: { docIds: ["kns_other"], titles: ["Someone else's payrolls"] } };
    const assembly = assembleTurn(agent, loaded, widened);
    const tool = assembly.tools.find((entry) => entry.name === "knowledge_search");
    expect(tool?.description).not.toContain("payrolls");
    expect(assembly.retrievalScope.sourceIds).toEqual(["kns_1"]);
  });

  it("gives no search tool for a granted document that has not finished indexing", async () => {
    const loaded = {
      ...emptyLoad(),
      knowledge: [knowledgeDocEntry({ state: "UNAVAILABLE", reason: "it is indexing and not searchable yet" })],
      knowledgeDocs: [],
      degradations: [{ kind: "KNOWLEDGE" as const, ref: "kns_1", reason: "it is indexing and not searchable yet" }],
    };
    const assembly = assembleTurn(agent, loaded, ctxFor(loaded.bodies));
    expect(assembly.tools.map((tool) => tool.name)).not.toContain("knowledge_search");
    expect(assembly.systemPrompt).toContain("## Not available in this turn");
    expect(assembly.systemPrompt).toContain("it is indexing and not searchable yet");
    expect(assembly.retrievalScope).toEqual({ sourceIds: [], indexed: false });
  });
});

const knowledgeDocEntry = (over: Partial<{ state: "READY" | "UNAVAILABLE"; reason: string }> = {}) => ({
  ref: "kns_1",
  docId: "kns_1",
  title: "Price list",
  status: "INDEXED",
  state: "READY" as const,
  ...over,
});

// --- the load path, against a fake that behaves like the tables ----------------

interface FakeRow {
  id: string;
  key: string;
  name: string;
  description: string;
  status: string;
  core: boolean;
  requires: unknown;
  tools: unknown;
  activeVersionId: string | null;
}

function fakeDb(rows: {
  grants: { kind: string; ref: string; enabled: boolean }[];
  skills?: FakeRow[];
  versions?: { id: string; versionNumber: number; instructions: string }[];
  agent?: { id: string; name: string; systemPrompt: string };
  docs?: { id: string; title: string; status: string; error: string | null }[];
}) {
  const inTenant = (tenant: unknown) => tenant === "tnt_one";
  const db = {
    agent: { findFirst: async () => (rows.agent ? { ...rows.agent } : null) },
    agentCapability: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const and = where.AND as Record<string, unknown>[];
        return inTenant(and[1]!.tenantId) ? rows.grants.map((grant) => ({ ...grant })) : [];
      },
    },
    skill: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const and = where.AND as Record<string, unknown>[];
        if (!inTenant(and[0]!.tenantId)) return [];
        const or = ((and[1] as { OR?: { id?: { in: string[] }; key?: { in: string[] } }[] }).OR ?? []) as {
          id?: { in: string[] };
          key?: { in: string[] };
        }[];
        const ids = or.flatMap((clause) => clause.id?.in ?? []);
        const keys = or.flatMap((clause) => clause.key?.in ?? []);
        return (rows.skills ?? [])
          .filter((skill) => ids.includes(skill.id) || keys.includes(skill.key))
          .map((skill) => ({ ...skill }));
      },
    },
    skillVersion: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const ids = (where.id as { in: string[] }).in;
        return (rows.versions ?? []).filter((version) => ids.includes(version.id));
      },
    },
    knowledgeDoc: {
      count: async ({ where }: { where: Record<string, unknown> }) => {
        const and = where.AND as Record<string, unknown>[];
        if (!inTenant(and[0]!.tenantId)) return 0;
        return (rows.docs ?? []).filter((doc) => doc.status === and[1]!.status).length;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const and = where.AND as Record<string, unknown>[];
        if (!inTenant(and[0]!.tenantId)) return [];
        const ids = (and[1] as { id: { in: string[] } }).id.in;
        return (rows.docs ?? []).filter((doc) => ids.includes(doc.id)).map((doc) => ({ ...doc }));
      },
    },
  };
  return db as unknown as PrismaClient;
}

describe("loadCapabilities", () => {
  it("reads nothing for an agent with no grant rows", async () => {
    const db = fakeDb({ grants: [] });
    const loaded = await loadCapabilities(db, "tnt_one", "age_1");
    expect(loaded.skills).toEqual([]);
    expect(loaded.bodies.size).toBe(0);
    expect(loaded.degradations).toEqual([]);
  });

  it("resolves a builtin by key and keeps its body loadable", async () => {
    const db = fakeDb({ grants: [{ kind: "SKILL", ref: triage.key, enabled: true }] });
    const loaded = await loadCapabilities(db, "tnt_one", "age_1");
    expect(loaded.skills[0]).toMatchObject({ key: triage.key, origin: "BUILTIN", state: "READY", version: 1 });
    expect(loaded.bodies.get(triage.key)?.instructions).toContain("Before answering, decide three things");
  });

  it("skips a disabled grant without degrading it", async () => {
    const db = fakeDb({ grants: [{ kind: "SKILL", ref: triage.key, enabled: false }] });
    const loaded = await loadCapabilities(db, "tnt_one", "age_1");
    expect(loaded.skills).toEqual([]);
    expect(loaded.degradations).toEqual([]);
  });

  it("refuses to read a draft skill's body, and says it is not published", async () => {
    const db = fakeDb({
      grants: [{ kind: "SKILL", ref: "skl_1", enabled: true }],
      skills: [
        {
          id: "skl_1",
          key: "refund-tone",
          name: "Refund tone",
          description: "How to talk about a refund",
          status: "DRAFT",
          core: false,
          requires: [],
          tools: [],
          activeVersionId: "skv_1",
        },
      ],
      versions: [{ id: "skv_1", versionNumber: 1, instructions: "this text must not reach a draft skill" }],
    });
    const loaded = await loadCapabilities(db, "tnt_one", "age_1");
    expect(loaded.skills[0]).toMatchObject({ state: "UNAVAILABLE", reason: "this skill is draft, not published" });
    expect(loaded.bodies.size).toBe(0);
  });

  it("reads the published version, not the tenant's row, and freezes its number", async () => {
    const db = fakeDb({
      grants: [{ kind: "SKILL", ref: "refund-tone", enabled: true }],
      skills: [
        {
          id: "skl_1",
          key: "refund-tone",
          name: "Refund tone",
          description: "How to talk about a refund",
          status: "PUBLISHED",
          core: false,
          requires: [],
          tools: [],
          activeVersionId: "skv_3",
        },
      ],
      versions: [{ id: "skv_3", versionNumber: 3, instructions: "quote the policy, then the date" }],
    });
    const loaded = await loadCapabilities(db, "tnt_one", "age_1");
    expect(loaded.bodies.get("refund-tone")).toMatchObject({ version: 3, instructions: "quote the policy, then the date" });
  });

  it("names a grant that points at nothing", async () => {
    const db = fakeDb({ grants: [{ kind: "SKILL", ref: "gone", enabled: true }] });
    const loaded = await loadCapabilities(db, "tnt_one", "age_1");
    expect(loaded.degradations[0]!.reason).toContain('no skill named "gone"');
  });

  it("degrades a tool the registry does not have", async () => {
    const db = fakeDb({ grants: [{ kind: "TOOL", ref: "book_a_flight", enabled: true }] });
    const loaded = await loadCapabilities(db, "tnt_one", "age_1");
    expect(loaded.toolGrants[0]!.state).toBe("UNAVAILABLE");
    expect(loaded.degradations[0]!.reason).toContain("registry has no tool");
  });

  it("degrades a knowledge grant whose document is not indexed, with the status that says why", async () => {
    const db = fakeDb({
      grants: [{ kind: "KNOWLEDGE", ref: "kns_pending", enabled: true }],
      docs: [{ id: "kns_pending", title: "Price list", status: "PENDING", error: null }],
    });
    const loaded = await loadCapabilities(db, "tnt_one", "age_1");
    expect(loaded.knowledge[0]).toMatchObject({ state: "UNAVAILABLE", status: "PENDING", title: "Price list" });
    expect(loaded.knowledgeDocs).toEqual([]);
    expect(loaded.degradations[0]).toMatchObject({ kind: "KNOWLEDGE", reason: "it is pending and not searchable yet" });
  });

  it("reports a failed index as the failure it was, with the recorded reason", async () => {
    const db = fakeDb({
      grants: [{ kind: "KNOWLEDGE", ref: "kns_1", enabled: true }],
      docs: [{ id: "kns_1", title: "Terms", status: "FAILED", error: "the document has no text left after chunking" }],
    });
    const loaded = await loadCapabilities(db, "tnt_one", "age_1");
    expect(loaded.degradations[0]!.reason).toContain("indexing failed: the document has no text left after chunking");
  });

  it("names a knowledge grant whose document is gone", async () => {
    const db = fakeDb({ grants: [{ kind: "KNOWLEDGE", ref: "kns_gone", enabled: true }] });
    const loaded = await loadCapabilities(db, "tnt_one", "age_1");
    expect(loaded.knowledge[0]).toMatchObject({ docId: null, state: "UNAVAILABLE" });
    expect(loaded.degradations[0]!.reason).toContain('no knowledge source with the id "kns_gone"');
  });

  it("probes the world for an indexed document and reads the requirement as met", async () => {
    const db = fakeDb({
      grants: [{ kind: "KNOWLEDGE", ref: "kns_1", enabled: true }],
      docs: [{ id: "kns_1", title: "Terms", status: "INDEXED", error: null }],
    });
    const loaded = await loadCapabilities(db, "tnt_one", "age_1");
    expect(loaded.world.knowledge).toBe(true);
    expect(loaded.knowledge[0]!.state).toBe("READY");
    expect(loaded.knowledgeDocs).toEqual([{ docId: "kns_1", title: "Terms" }]);
    expect(loaded.degradations).toEqual([]);
  });
});

describe("prepareAgentTurn", () => {
  it("assembles from the rows, so the console and the worker share one prompt", async () => {
    const db = fakeDb({
      agent: { id: "age_1", name: "Front desk", systemPrompt: "You answer for a small hosting company." },
      grants: [{ kind: "SKILL", ref: triage.key, enabled: true }],
    });
    const assembly = await prepareAgentTurn(db, "tnt_one", "age_1");
    expect(assembly.systemPrompt).toContain("- triage — ");
    expect(assembly.tools.map((tool) => tool.name)).toEqual(["use_skill"]);
    expect(assembly.snapshot.promptChars).toBe(assembly.systemPrompt.length);
  });

  it("refuses an agent that is not in the tenant", async () => {
    const db = fakeDb({ grants: [] });
    await expect(prepareAgentTurn(db, "tnt_one", "age_gone")).rejects.toMatchObject({ code: "agent_not_found", status: 404 });
  });
});

describe("validateSkill", () => {
  it("rejects the keys a model could not type reliably", () => {
    expect(validateSkill(asSkillDraft({ key: "-lead", name: "n", description: "d", instructions: "i" })).errors).toContain(
      "key must not start with a hyphen",
    );
    expect(validateSkill(asSkillDraft({ key: "double--hyphen", name: "n", description: "d", instructions: "i" })).errors.some((e) => e.includes("double hyphen"))).toBe(true);
    expect(validateSkill(asSkillDraft({ key: "UPPER", name: "n", description: "d", instructions: "i" })).errors.join()).toContain("lowercase");
    expect(validateSkill(asSkillDraft({ key: triage.key, name: "n", description: "d", instructions: "i" })).errors.join()).toContain("built-in");
  });

  it("warns about size and refuses about structure", () => {
    const instructions = Array.from({ length: 600 }, () => "one instruction").join("\n");
    const long = validateSkill(asSkillDraft({ key: "notes", name: "n", description: "d", instructions }));
    expect(long.errors).toEqual([]);
    // The count is the split it measures, and the warning is the whole point: a
    // long body is not illegal, it is expensive every time the model opens it.
    expect(long.warnings.join(" ")).toContain(`${instructions.split("\n").length} lines`);
    expect(long.warnings.join(" ")).toContain("loaded into context");

    const noBody = validateSkill(asSkillDraft({ key: "notes", name: "n", description: "d", instructions: "  " }));
    expect(noBody.errors).toContain("instructions are required");
  });
});
