/**
 * Semantic retrieval, end to end over HTTP — and honest about the daemon.
 *
 * The phase has one precondition that cannot be faked: an embedding model has to be
 * pulled. So this script asks Ollama first, before it touches a row, and when the
 * model is missing it fails with the exact command to fix it rather than letting the
 * search quietly fall back to keyword and calling that a pass. Only after that does
 * it upload a real file, wait for the worker's embed lane to record its own row, and
 * demand `backend:"vector"` from the same question the keyword phase answered.
 *
 * It also checks the two facts that keep the fallback observable: a query neither
 * engine can match reports `none` *and* says both engines were tried, and the embed
 * lane writes no `UsageEvent` — because Ollama reports no usage for embeddings and a
 * made-up number would be worse than none.
 *
 * Requires `pnpm dev:api`, `pnpm dev:worker`, and `ollama pull nomic-embed-text`,
 * then `pnpm exec tsx scripts/verify-embeddings.ts`.
 */

export {};

const API = `http://127.0.0.1:${process.env.API_PORT ?? "3000"}`;
const OLLAMA = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
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

interface KnowledgeDoc {
  id: string;
  title: string;
  status: string;
  error: string | null;
  chunkCount: number;
  sha8: string;
  granted: boolean;
  embedding: { model: string; dim: number; chunks: number; at: string } | null;
  embeddingError: string | null;
}
interface KnowledgeWrite {
  doc: KnowledgeDoc;
  duplicate: boolean;
  granted: boolean;
  queued: boolean;
  queue: string;
}
interface SearchHit {
  chunkId: string;
  docId: string;
  seq: number;
  title: string;
  snippet: string;
  score: number;
  backend: string;
}
interface KnowledgeSearch {
  query: string;
  backend: string;
  hits: SearchHit[];
  searched: number;
  note: string;
}
interface GrantRow {
  kind: string;
  ref: string;
  enabled: boolean;
}
interface CapabilityView {
  grants: GrantRow[];
}
interface UsageEvent {
  id: string;
  kind: string;
  createdAt: string;
}

const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
const MARKER = `semantic-${stamp}-${Math.random().toString(16).slice(2, 6)}`;
const TITLE = `Warranty for the ${MARKER} plan`;
const FILE_TEXT = [
  `# Warranty for the ${MARKER} plan`,
  "",
  `The ${MARKER} plan carries a thirty-seven month hardware warranty from the invoice date. Coverage includes accidental liquid damage but excludes theft.`,
  "",
  `Claims must be opened by a human agent; replacements ship within five business days of approval.`,
  "",
].join("\n");
const QUESTION = `How long is the hardware warranty on the ${MARKER} plan, and does it cover liquid damage?`;

let createdDocId: string | null = null;

async function cleanup(agentId: string | null, before: GrantRow[]): Promise<void> {
  if (agentId !== null) {
    await api(`/agents/${agentId}/capabilities`, {
      method: "PUT",
      body: { capabilities: before.map((grant) => ({ kind: grant.kind, ref: grant.ref, enabled: grant.enabled })) },
    });
  }
  if (createdDocId !== null) await api(`/knowledge/${createdDocId}`, { method: "DELETE" });
}

async function upload(agentId: string, content: string, filename: string, title: string): Promise<{ status: number; body: KnowledgeWrite }> {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "text/markdown" }), filename);
  form.append("title", title);
  const response = await fetch(`${API}/agents/${agentId}/knowledge/upload`, { method: "POST", body: form });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as KnowledgeWrite };
}

async function waitFor(agentId: string, docId: string, done: (doc: KnowledgeDoc) => boolean, timeoutMs: number): Promise<KnowledgeDoc | null> {
  const startedAt = Date.now();
  let last: KnowledgeDoc | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    const list = await api<KnowledgeDoc[]>(`/agents/${agentId}/knowledge`);
    last = (Array.isArray(list.body) ? list.body : []).find((row) => row.id === docId) ?? null;
    if (last !== null && (done(last) || last.status === "FAILED")) return last;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return last;
}

/**
 * The daemon's own answer about the model. `/api/show` is the only honest source:
 * a missing tag is a 404, and a chat model would answer with no `embedding`
 * capability. Nothing is inferred from the model's name.
 */
async function embedModelState(): Promise<{ ok: boolean; reason: string }> {
  let response: Response;
  try {
    response = await fetch(`${OLLAMA}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { ok: false, reason: `ollama is not reachable at ${OLLAMA} (${error instanceof Error ? error.message : String(error)}) — start it, then retry` };
  }
  if (!response.ok) return { ok: false, reason: `${OLLAMA}/api/show answered HTTP ${response.status} for "${EMBED_MODEL}"` };
  const payload = (await response.json().catch(() => ({}))) as { capabilities?: unknown };
  const capabilities = Array.isArray(payload.capabilities) ? payload.capabilities : [];
  if (!capabilities.includes("embedding")) {
    return { ok: false, reason: `"${EMBED_MODEL}" is not installed as an embedding model (capabilities: ${JSON.stringify(capabilities)})` };
  }
  return { ok: true, reason: "declares the embedding capability" };
}

try {
  // --- precondition: the model, before any row is written ---------------------

  const model = await embedModelState();
  if (!model.ok) {
    console.error(`\nFAIL the embedding model is unavailable — ${model.reason}`);
    console.error(`\nPull it, then rerun this script:\n\n    ollama pull ${EMBED_MODEL}\n`);
    process.exit(1);
  }
  console.log(`ok   ${EMBED_MODEL} ${model.reason}`);

  const projects = await api<Array<{ id: string; isDefault: boolean }>>("/projects");
  const project = projects.body.find((row) => row.isDefault) ?? projects.body[0];
  if (!project) throw new Error("the tenant has no project — run `pnpm db:seed` first");

  const agents = await api<Array<{ id: string; name: string; status: string }>>(`/projects/${project.id}/agents`);
  const agent = agents.body.find((row) => row.status === "ACTIVE");
  if (!agent) throw new Error("this project has no ACTIVE agent to probe with");
  const agentId = agent.id;

  const before = await api<CapabilityView>(`/agents/${agentId}/capabilities`);
  const originalGrants = before.body.grants ?? [];

  // The embed lane must not bill. Snapshot the ledger before the upload; anything
  // that appears after it would mean a usage row was invented for an unmetered call.
  const usageBefore = await api<UsageEvent[]>("/usage?take=200");
  const knownUsage = new Set((Array.isArray(usageBefore.body) ? usageBefore.body : []).map((row) => row.id));

  // --- a real file, indexed and then embedded ---------------------------------

  const uploaded = await upload(agentId, FILE_TEXT, `semantic-${stamp}.md`, TITLE);
  check("a markdown upload is accepted with 201", uploaded.status === 201, `${uploaded.status}`);
  createdDocId = uploaded.body?.doc?.id ?? null;

  const indexed = await waitFor(agentId, createdDocId ?? "none", (doc) => doc.status === "INDEXED", 60_000);
  check("the worker indexed the document", indexed?.status === "INDEXED", `${indexed?.status ?? "missing"}${indexed?.error ? ` — ${indexed.error}` : ""}`);
  if (indexed?.status !== "INDEXED") throw new Error("indexing did not finish — is `pnpm dev:worker` running?");

  const embedded = await waitFor(agentId, createdDocId ?? "none", (doc) => doc.embedding !== null || doc.embeddingError !== null, 120_000);
  if (embedded?.embeddingError != null) {
    check("the embed lane recorded a success", false, embedded.embeddingError);
  } else {
    check("the embed lane recorded its own row on the document", embedded?.embedding != null, JSON.stringify(embedded?.embedding ?? null));
  }
  check("…for the configured model", embedded?.embedding?.model === EMBED_MODEL, embedded?.embedding?.model ?? "none");
  check("…with a positive dimension", (embedded?.embedding?.dim ?? 0) > 0, `${embedded?.embedding?.dim ?? 0}d`);
  check(
    "…covering every indexed chunk",
    embedded?.embedding?.chunks === embedded?.chunkCount,
    `${embedded?.embedding?.chunks ?? "?"} embedded vs ${embedded?.chunkCount ?? "?"} chunks`,
  );
  if (embedded?.embedding == null) throw new Error("no embedding row was recorded — check the worker log for the embed lane");

  // --- the same question P2 answered, now answered by the vector engine -------

  const search = await api<KnowledgeSearch>(`/agents/${agentId}/knowledge/search?q=${encodeURIComponent(QUESTION)}&limit=3`);
  check("the search endpoint answers with the vector backend", search.status === 200 && search.body.backend === "vector", `${search.status} ${search.body?.backend ?? ""}`);
  check("the note names the hybrid chain", search.body?.note?.includes("matched by vector") === true, search.body?.note ?? "");
  const hit = search.body.hits[0];
  check("the top hit is the uploaded document", hit?.docId === createdDocId, hit?.docId ?? "none");
  check("…and it clears the similarity floor", (hit?.score ?? 0) >= 0.6, `score ${hit?.score?.toFixed(3) ?? "?"}`);
  check("…with the warranty passage", (hit?.snippet ?? "").includes("thirty-seven"), hit?.snippet?.slice(0, 90) ?? "no hit");
  console.log(`   hit: [${hit?.seq ?? "?"}] ${hit?.chunkId ?? "none"} score ${hit?.score?.toFixed(3) ?? "?"}`);

  // --- the floor holds, and the fallback is visible rather than silent --------

  const noise = await api<KnowledgeSearch>(`/agents/${agentId}/knowledge/search?q=${encodeURIComponent(`zzqxv-${stamp}`)}&limit=3`);
  check("an unmatchable query reports backend:none rather than noise", noise.body?.backend === "none" && noise.body.hits.length === 0, `${noise.body?.backend} ${noise.body?.hits?.length} hit(s)`);
  check("…and says both engines were tried", noise.body?.note?.includes("tried vector, then keyword") === true, noise.body?.note ?? "");

  // --- unmetered means the ledger does not move --------------------------------

  const usageAfter = await api<UsageEvent[]>("/usage?take=200");
  const fresh = (Array.isArray(usageAfter.body) ? usageAfter.body : []).filter((row) => !knownUsage.has(row.id));
  check("the embed lane wrote no UsageEvent", fresh.length === 0, fresh.map((row) => row.kind).join(", ") || "none");

  console.log(`\nagent: ${agent.name} · doc: ${createdDocId} ${indexed.sha8} · ${indexed.chunkCount} chunk(s) · ${embedded.embedding.dim}d ${embedded.embedding.model}`);
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
  console.log("\nclean — the embed lane wrote real vectors, the same question now answers by vector, and nothing was billed");
}
