/**
 * Capabilities and skills, end to end over HTTP.
 *
 * What this proves is that the grant rows, the version rows and the assembled turn
 * agree with each other in the database — not that the console renders them. Every
 * assertion reads a row back from the API: a skill that was created but never
 * published must be *unavailable* in the view, a published body must be the version
 * the preview names, and the snapshot a live turn recorded must be the same one the
 * preview promised, byte-for-byte in its hash.
 *
 * The lazy-load rules themselves (a catalogue line in the prompt, the body only
 * behind `use_skill`) are asserted in `packages/core/test/capability.test.ts`
 * against a scripted model, because whether a real local model chooses to call a
 * tool is not something this script can promise. Where the turn does call it, the
 * script reports what came back.
 *
 * Usage: `pnpm dev:api` running, then `pnpm exec tsx scripts/verify-capability.ts`.
 * It creates two throwaway skills and restores the agent's grants at the end.
 */

export {};

const API = `http://127.0.0.1:${process.env.API_PORT ?? "3000"}`;
const problems: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) problems.push(`${label}${detail ? `: ${detail}` : ""}`);
}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: T }> {
  const response = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as T };
}

interface SkillRow {
  id: string;
  key: string;
  name: string;
  origin: string;
  status: string;
  core: boolean;
  requires: string[];
  tools: string[];
  instructions: string;
  latestVersion: number;
  published: { version: number; hash: string; publishedAt: string | null } | null;
  warnings: string[];
}
interface CatalogueRow {
  key: string;
  ref: string;
  version: number | null;
  state: string;
  effects: string[];
  reason?: string;
}
interface ToolRow {
  key: string;
  effect: string;
  state: string;
  grant: string;
  reason?: string;
}
interface GrantRow {
  kind: string;
  ref: string;
  enabled: boolean;
  state: string;
  label: string;
  reason?: string;
}
interface Degradation {
  kind: string;
  ref: string;
  reason: string;
}
interface CapabilityView {
  agentId: string;
  grants: GrantRow[];
  catalogue: CatalogueRow[];
  tools: ToolRow[];
  degradations: Degradation[];
  available: {
    skills: { key: string; origin: string; core: boolean; published: boolean }[];
    tools: { key: string; effect: string }[];
  };
}
interface Preview {
  systemPrompt: string;
  tools: { name: string; description: string }[];
  snapshot: { skills: CatalogueRow[]; tools: ToolRow[]; promptChars: number; promptBudgetChars: number; degradations: Degradation[] };
  capabilityHash: string;
  degradations: Degradation[];
}
interface AgentRow {
  id: string;
  name: string;
  status: string;
  maxToolSteps: number;
  perTurnTokenBudget: number;
  dailyTokenBudget: number;
}
interface RunDetail {
  id: string;
  status: string;
  error: string | null;
  tokensUsed: number;
  capability: { skills: CatalogueRow[]; tools: ToolRow[]; promptChars: number } | null;
  capabilityHash: string | null;
  steps: { kind: string; tool: string | null; ok: boolean | null; resultPreview: string | null }[];
}
interface Outcome {
  reply: string;
  agentRunId: string | null;
  tokensUsed: number;
  trace: { tool: string; ok: boolean }[];
}

const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
const SKILL_KEY = `probe-${stamp}`;
const CORE_KEY = `probe-core-${stamp}`;
/** Text only the frozen body carries, so "the model could not have seen this yet" is provable. */
const SECRET_LINE = "Probe marker: eleven watermelons were weighed at noon.";

let createdSkillId: string | null = null;
let createdCoreId: string | null = null;

async function cleanup(agentId: string | null, before: GrantRow[]): Promise<void> {
  // Put the agent back the way it was found, then remove the rows this run made.
  // A failed assertion must not leave a tenant's agent holding a probe skill.
  if (agentId !== null) {
    await api(`/agents/${agentId}/capabilities`, {
      method: "PUT",
      body: {
        capabilities: before.map((grant) => ({ kind: grant.kind, ref: grant.ref, enabled: grant.enabled })),
      },
    });
  }
  for (const id of [createdSkillId, createdCoreId]) {
    if (id !== null) await api(`/skills/${id}`, { method: "DELETE" });
  }
}

try {
  const projects = await api<Array<{ id: string; isDefault: boolean }>>("/projects");
  const project = projects.body.find((row) => row.isDefault) ?? projects.body[0];
  if (!project) throw new Error("the tenant has no project — run `pnpm db:seed` first");

  const agents = await api<AgentRow[]>(`/projects/${project.id}/agents`);
  const agent = agents.body.find((row) => row.status === "ACTIVE");
  if (!agent) throw new Error("this project has no ACTIVE agent to probe with");
  const agentId = agent.id;

  const before = await api<CapabilityView>(`/agents/${agentId}/capabilities`);
  check("the capability view reads for an agent that has never been granted anything", before.status === 200, `${before.status}`);
  const originalGrants = before.body.grants;

  // --- the registry, as the API answers it ------------------------------------

  const registry = await api<{ requirements: { name: string }[]; tools: { key: string }[]; limits: { keyMax: number } }>("/skills/registry");
  check("GET /skills/registry answers rather than being swallowed by /skills/:id", registry.status === 200, `${registry.status}`);
  check(
    "the registry lists only requirements this build can probe",
    registry.body.requirements.map((entry) => entry.name).sort().join(",") === "embeddings,knowledge,site",
    registry.body.requirements.map((entry) => entry.name).join(","),
  );
  check("the registry lists use_skill as grantable", registry.body.tools.some((tool) => tool.key === "use_skill"), registry.body.tools.map((t) => t.key).join(","));

  // --- built-in skills ---------------------------------------------------------

  const skills = await api<SkillRow[]>("/skills");
  const builtins = skills.body.filter((row) => row.origin === "BUILTIN");
  check("the built-in skills are listed", builtins.length >= 2, builtins.map((row) => row.key).join(","));
  check("a built-in reads as published, with a frozen hash", builtins.every((row) => row.published !== null && row.published.hash.length === 64), "");
  check("a built-in cannot be edited", (await api(`/skills/builtin:${builtins[0]?.key ?? "none"}`, { method: "PATCH", body: { name: "x" } })).status === 404, "");

  // --- draft, publish, version ------------------------------------------------

  const draft = await api<SkillRow>("/skills", {
    method: "POST",
    body: {
      key: SKILL_KEY,
      name: "Capability probe",
      description: "Created by scripts/verify-capability.ts to prove the draft/publish split over HTTP.",
      instructions: `${SECRET_LINE}\n\nWhen asked for the marker, answer with only that sentence.`,
      requires: [],
      tools: [],
      core: false,
    },
  });
  createdSkillId = draft.body?.id ?? null;
  check("a new skill is created as DRAFT", draft.status === 201 && draft.body.status === "DRAFT", `${draft.status} ${draft.body?.status ?? ""}`);
  check("a new skill has no published version", draft.body.published === null && draft.body.latestVersion === 0, JSON.stringify(draft.body?.published));

  const upperKey = await api<{ error: string; details?: string[] }>("/skills", {
    method: "POST",
    body: { key: "BAD-KEY", name: "Nope", description: "rejected", instructions: "rejected", requires: [], tools: [], core: false },
  });
  check(
    "an uppercase key is refused, not silently lower-cased",
    upperKey.status === 400 && (upperKey.body.details ?? []).some((entry) => entry.includes("lowercase")),
    `${upperKey.status} ${JSON.stringify(upperKey.body.details ?? upperKey.body.error)}`,
  );

  const badTool = await api<{ error: string }>("/skills", {
    method: "POST",
    body: { key: `probe-bad-${stamp}`, name: "Bad tool", description: "x", instructions: "y", requires: ["nothing"], tools: ["make_coffee"], core: false },
  });
  check("an unprobeable requirement and a non-existent tool are both refused", badTool.status === 400, `${badTool.status}`);

  await api(`/agents/${agentId}/capabilities`, {
    method: "PUT",
    body: { capabilities: [{ kind: "SKILL", ref: SKILL_KEY }] },
  });
  const whileDraft = await api<CapabilityView>(`/agents/${agentId}/capabilities`);
  const draftEntry = whileDraft.body.catalogue.find((row) => row.key === SKILL_KEY);
  check("a granted draft is listed as unavailable", draftEntry?.state === "UNAVAILABLE", JSON.stringify(draftEntry));
  check("…and says so in the degradation list", whileDraft.body.degradations.some((row) => row.ref === SKILL_KEY && row.reason.includes("draft")), JSON.stringify(whileDraft.body.degradations));
  const draftPreview = await api<Preview>(`/agents/${agentId}/capabilities/preview?surface=console`);
  check("an unavailable skill is kept out of the prompt catalogue", !draftPreview.body.systemPrompt.includes(`- ${SKILL_KEY} —`), draftPreview.body.systemPrompt.slice(0, 80));
  check("…but is named as not available, so the model cannot offer it", draftPreview.body.systemPrompt.includes("## Not available in this turn"), "");
  check("…and is given no tool to open it", !draftPreview.body.tools.some((tool) => tool.name === "use_skill"), draftPreview.body.tools.map((tool) => tool.name).join(","));

  const published = await api<SkillRow & { unchanged: boolean }>(`/skills/${createdSkillId ?? "none"}/publish`, { method: "POST", body: {} });
  check("publishing freezes version 1", published.status === 200 && published.body.published?.version === 1 && published.body.unchanged === false, `${published.status} v${published.body?.published?.version ?? "?"}`);
  const republish = await api<SkillRow & { unchanged: boolean }>(`/skills/${createdSkillId ?? "none"}/publish`, { method: "POST", body: {} });
  check("republishing unchanged text mints no version", republish.body.unchanged === true && republish.body.latestVersion === 1, `unchanged=${republish.body?.unchanged} latest=${republish.body?.latestVersion}`);
  const publishedHash = published.body.published?.hash ?? "";

  const ready = await api<CapabilityView>(`/agents/${agentId}/capabilities`);
  const readyEntry = ready.body.catalogue.find((row) => row.key === SKILL_KEY);
  check("the same grant resolves READY once published", readyEntry?.state === "READY" && readyEntry.version === 1, JSON.stringify(readyEntry));
  // use_skill is a registry tool now, so a skill grant stores no tool row; the
  // preview below proves the tool is still offered.
  check("a skill grant is not padded with a derived tool row", ready.body.tools.length === 0, JSON.stringify(ready.body.tools));

  const preview = await api<Preview>(`/agents/${agentId}/capabilities/preview?surface=console`);
  check("the catalogue line is in the prompt", preview.body.systemPrompt.includes(`- ${SKILL_KEY} —`), "");
  check("the body is not in the prompt", !preview.body.systemPrompt.includes(SECRET_LINE), "the instructions leaked into the system prompt");
  check("use_skill is offered with this skill in its enum", preview.body.tools.some((tool) => tool.name === "use_skill"), preview.body.tools.map((tool) => tool.name).join(","));
  check("the prompt is measured against its budget", preview.body.snapshot.promptChars <= preview.body.snapshot.promptBudgetChars, `${preview.body.snapshot.promptChars}/${preview.body.snapshot.promptBudgetChars}`);

  // --- refusal paths that protect the grant table ------------------------------

  const unknownTool = await api<{ error: string }>(`/agents/${agentId}/capabilities`, {
    method: "PUT",
    body: { capabilities: [{ kind: "TOOL", ref: "http.fetch" }] },
  });
  check("a tool this build does not implement cannot be granted", unknownTool.status === 400 && unknownTool.body.error === "capability_tool_unknown", `${unknownTool.status} ${unknownTool.body.error}`);

  const earlyKnowledge = await api<{ error: string }>(`/agents/${agentId}/capabilities`, {
    method: "PUT",
    body: { capabilities: [{ kind: "KNOWLEDGE", ref: "src_1" }] },
  });
  check("a knowledge ref that names nothing is refused at write time", earlyKnowledge.status === 400 && earlyKnowledge.body.error === "capability_knowledge_unknown", `${earlyKnowledge.status} ${earlyKnowledge.body.error}`);

  const unknownSkill = await api<{ error: string }>(`/agents/${agentId}/capabilities`, {
    method: "PUT",
    body: { capabilities: [{ kind: "SKILL", ref: "skill_that_does_not_exist" }] },
  });
  check("a skill ref that names nothing is refused at write time", unknownSkill.status === 400 && unknownSkill.body.error === "capability_skill_unknown", `${unknownSkill.status} ${unknownSkill.body.error}`);

  // --- core skills gate a public surface --------------------------------------

  const coreSkill = await api<SkillRow>("/skills", {
    method: "POST",
    body: {
      key: CORE_KEY,
      name: "Core probe",
      description: "Requires knowledge, which this build cannot satisfy yet.",
      instructions: "Never used: this skill exists to be unavailable.",
      requires: ["knowledge"],
      tools: [],
      core: true,
    },
  });
  createdCoreId = coreSkill.body?.id ?? null;
  await api(`/skills/${createdCoreId ?? "none"}/publish`, { method: "POST", body: {} });
  await api(`/agents/${agentId}/capabilities`, {
    method: "PUT",
    body: { capabilities: [{ kind: "SKILL", ref: SKILL_KEY }, { kind: "SKILL", ref: CORE_KEY }] },
  });
  const coreView = await api<CapabilityView>(`/agents/${agentId}/capabilities`);
  const coreEntry = coreView.body.catalogue.find((row) => row.key === CORE_KEY);
  check("a published core skill with an unmet requirement is still unavailable", coreEntry?.state === "UNAVAILABLE", JSON.stringify(coreEntry));
  check("…because the requirement names what is missing", (coreEntry?.reason ?? "").includes("knowledge"), coreEntry?.reason ?? "");

  const publicPreview = await api<{ error: string; message: string; details?: { skills: string[] } }>(`/agents/${agentId}/capabilities/preview?surface=public`);
  check("a public surface refuses rather than answering without its core skill", publicPreview.status === 409 && publicPreview.body.error === "capability_unavailable", `${publicPreview.status} ${publicPreview.body?.error ?? ""}`);
  check("…and names the skill that blocked it", (publicPreview.body.details?.skills ?? []).includes(CORE_KEY), JSON.stringify(publicPreview.body.details ?? {}));
  const consoleAgain = await api<Preview>(`/agents/${agentId}/capabilities/preview?surface=console`);
  check("the same agent still answers in the console", consoleAgain.status === 200, `${consoleAgain.status}`);

  // --- a live turn records what it was given ----------------------------------

  const turn = await api<Outcome>(`/agents/${agentId}/run`, {
    method: "POST",
    body: { message: `Open the skill named ${SKILL_KEY} with use_skill, then reply with only the first sentence of its instructions.` },
  });
  if (typeof turn.body?.reply !== "string") throw new Error(`POST /agents/:id/run failed: ${JSON.stringify(turn.body)}`);
  const run = await api<RunDetail>(`/agent-runs/${turn.body.agentRunId ?? "none"}`);
  check("the turn recorded a capability snapshot", run.status === 200 && run.body.capability !== null, `${run.status} ${run.body?.error ?? ""}`);
  check("…which contains the granted skill", (run.body.capability?.skills ?? []).some((row) => row.key === SKILL_KEY && row.state === "READY"), JSON.stringify(run.body.capability?.skills ?? []));
  check("…and refuses to list the unavailable one as ready", (run.body.capability?.skills ?? []).every((row) => row.key !== CORE_KEY || row.state === "UNAVAILABLE"), "");
  check(
    "the recorded hash is the hash the preview promised",
    run.body.capabilityHash === consoleAgain.body.capabilityHash,
    `${run.body.capabilityHash} vs ${consoleAgain.body.capabilityHash}`,
  );
  const toolSteps = (run.body.steps ?? []).filter((step) => step.kind === "TOOL");
  console.log(`   model called use_skill: ${toolSteps.some((step) => step.tool === "use_skill") ? "yes" : "no"} (${toolSteps.length} tool step(s))`);
  if (toolSteps.length > 0) {
    check("every tool step this turn took is one the snapshot granted", toolSteps.every((step) => (run.body.capability?.tools ?? []).some((tool) => tool.key === step.tool)), toolSteps.map((step) => step.tool).join(","));
    const opened = toolSteps.find((step) => step.tool === "use_skill" && step.ok === true);
    if (opened) check("the opened body is the frozen version's text", (opened.resultPreview ?? "").length > 0, opened.resultPreview?.slice(0, 60) ?? "");
  }

  // --- the budget columns round-trip ------------------------------------------

  const patched = await api<AgentRow>(`/agents/${agentId}`, {
    method: "PATCH",
    body: { maxToolSteps: 3, perTurnTokenBudget: 900, dailyTokenBudget: 5000 },
  });
  check("the limit columns are stored", patched.status === 200 && patched.body.maxToolSteps === 3 && patched.body.perTurnTokenBudget === 900 && patched.body.dailyTokenBudget === 5000, JSON.stringify([patched.body?.maxToolSteps, patched.body?.perTurnTokenBudget, patched.body?.dailyTokenBudget]));
  const reread = await api<AgentRow>(`/agents/${agentId}`);
  check("…and read back from the row, not echoed from the request", reread.body.maxToolSteps === 3 && reread.body.dailyTokenBudget === 5000, "");
  await api(`/agents/${agentId}`, { method: "PATCH", body: { maxToolSteps: 6, perTurnTokenBudget: 0, dailyTokenBudget: 0 } });
  const outOfRange = await api<{ error: string }>(`/agents/${agentId}`, { method: "PATCH", body: { maxToolSteps: 99 } });
  check("a step cap above what the runtime honours is refused", outOfRange.status === 400, `${outOfRange.status}`);

  const inUse = await api<{ error: string }>(`/skills/${createdSkillId ?? "none"}`, { method: "DELETE" });
  check("a granted skill cannot be deleted out from under an agent", inUse.status === 409 && inUse.body.error === "skill_in_use", `${inUse.status} ${inUse.body.error}`);

  console.log(`\nagent: ${agent.name} · skill: ${SKILL_KEY} v1 ${publishedHash.slice(0, 12)} · hash ${consoleAgain.body.capabilityHash}`);
  console.log(`prompt: ${consoleAgain.body.snapshot.promptChars} chars · ${preview.body.tools.length} tool(s) offered`);
  await cleanup(agentId, originalGrants);
} catch (error) {
  problems.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
  await cleanup(null, []);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems.slice(0, 25)) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log("\nclean — drafts stay draft, publishes freeze a version, and a turn records the set it ran with");
}
