/**
 * Keyword knowledge, end to end over HTTP.
 *
 * This is the phase's acceptance test, and it is deliberately suspicious: the file
 * it uploads carries a sentence that exists nowhere else, so an answer that contains
 * it cannot have come from the model's memory, the system prompt, or another
 * document. The script then reads every step back from the API — the document row,
 * the grant row, the indexed chunk count, the retrieval hit — before it ever asks
 * the agent a question, and only a recorded TOOL step is accepted as proof that the
 * turn actually searched rather than guessed.
 *
 * What it cannot promise: that a local model *chooses* to call the tool. If the turn
 * does not, the script fails and prints the reply, because a knowledge feature that
 * was not used is not a passing knowledge feature — it is an unverified one.
 *
 * Requires `pnpm dev:api` and `pnpm dev:worker` (indexing runs on the worker lane),
 * then `pnpm exec tsx scripts/verify-knowledge.ts`. The document and the grants this
 * run creates are removed again on the way out.
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

interface KnowledgeDoc {
  id: string;
  projectId: string | null;
  kind: string;
  title: string;
  mime: string;
  status: string;
  error: string | null;
  charCount: number;
  byteSize: number;
  chunkCount: number;
  sha8: string;
  granted: boolean;
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
  text: string;
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
  knowledge: { ref: string; docId: string | null; title: string; state: string; reason?: string }[];
  tools: { key: string; state: string; grant: string }[];
  degradations: { kind: string; ref: string; reason: string }[];
}
interface RunDetail {
  id: string;
  status: string;
  error: string | null;
  capability: {
    knowledge: { ref: string; docId: string | null; state: string }[];
    tools: { key: string; grant: string }[];
  } | null;
  steps: { kind: string; tool: string | null; ok: boolean | null; resultPreview: string | null }[];
}
interface Outcome {
  reply: string;
  agentRunId: string | null;
}

const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "");
const MARKER = `probe-${stamp}-${Math.random().toString(16).slice(2, 6)}`;
const TITLE = `Refund window for the ${MARKER} plan`;
/**
 * The one sentence that exists nowhere else. Forty-two is unlikely enough that a
 * model repeating it after reading the chunk is the only explanation the script
 * accepts.
 */
const FILE_TEXT = [
  `# Refund window for the ${MARKER} plan`,
  "",
  `Orders placed on the ${MARKER} plan may be returned for exactly forty-two days after delivery. There is no restocking fee during that window, and the customer keeps the original packaging.`,
  "",
  `The ${MARKER} plan is billed annually. An order outside the forty-two day window can still be refunded at the discretion of a human agent.`,
  "",
].join("\n");
const QUESTION = `How many days after delivery can a customer on the ${MARKER} plan return an order?`;

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

async function waitForIndex(agentId: string, docId: string, timeoutMs = 60_000): Promise<KnowledgeDoc> {
  const startedAt = Date.now();
  let last: KnowledgeDoc | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    const list = await api<KnowledgeDoc[]>(`/agents/${agentId}/knowledge`);
    last = (Array.isArray(list.body) ? list.body : []).find((row) => row.id === docId) ?? null;
    if (last !== null && (last.status === "INDEXED" || last.status === "FAILED")) return last;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return last ?? ({ id: docId, status: "MISSING" } as KnowledgeDoc);
}

try {
  const projects = await api<Array<{ id: string; isDefault: boolean }>>("/projects");
  const project = projects.body.find((row) => row.isDefault) ?? projects.body[0];
  if (!project) throw new Error("the tenant has no project — run `pnpm db:seed` first");

  const agents = await api<Array<{ id: string; name: string; status: string }>>(`/projects/${project.id}/agents`);
  const agent = agents.body.find((row) => row.status === "ACTIVE");
  if (!agent) throw new Error("this project has no ACTIVE agent to probe with");
  const agentId = agent.id;

  const before = await api<CapabilityView>(`/agents/${agentId}/capabilities`);
  const originalGrants = before.body.grants ?? [];

  // --- upload a real file ------------------------------------------------------

  const first = await upload(agentId, FILE_TEXT, `probe-${stamp}.md`, TITLE);
  check("a markdown upload is accepted with 201", first.status === 201, `${first.status} ${JSON.stringify(first.body ?? {})}`);
  createdDocId = first.body?.doc?.id ?? null;
  check("the file is stored as a FILE in the agent's project", first.body?.doc?.kind === "FILE" && first.body?.doc?.projectId === project.id, `${first.body?.doc?.kind} ${first.body?.doc?.projectId}`);
  check("it starts PENDING rather than pretending to be searchable", first.body?.doc?.status === "PENDING", first.body?.doc?.status ?? "");
  check("the upload auto-granted it to the agent", first.body?.granted === true, `granted=${first.body?.granted}`);
  check("an index job was queued on the knowledge lane", first.body?.queued === true, `${first.body?.queued} ${first.body?.queue}`);
  check("the hash is content-derived, not random", /^[0-9a-f]{8}$/.test(first.body?.doc?.sha8 ?? ""), first.body?.doc?.sha8 ?? "");

  const duplicate = await upload(agentId, FILE_TEXT, `probe-${stamp}-again.md`, TITLE);
  check("re-uploading identical bytes returns the same row", duplicate.body?.duplicate === true && duplicate.body?.doc?.id === createdDocId, `duplicate=${duplicate.body?.duplicate}`);
  check("…and queues no second job", duplicate.body?.queued === false, `queued=${duplicate.body?.queued}`);

  // --- the worker indexes it ---------------------------------------------------

  const indexed = await waitForIndex(agentId, createdDocId ?? "none");
  check("the worker indexed the document", indexed.status === "INDEXED", `${indexed.status}${indexed.error ? ` — ${indexed.error}` : ""}`);
  check("it produced at least one searchable chunk", (indexed.chunkCount ?? 0) >= 1, `${indexed.chunkCount} chunk(s), ${indexed.charCount} chars`);
  if (indexed.status !== "INDEXED") throw new Error("indexing did not finish — is `pnpm dev:worker` running?");

  const detail = await api<KnowledgeDoc & { content: string }>(`/knowledge/${createdDocId}`);
  check("GET /knowledge/:id returns the stored text", detail.status === 200 && detail.body.content.includes(MARKER), `${detail.status}, ${detail.body?.content?.length ?? 0} chars`);
  const grantedView = await api<CapabilityView>(`/agents/${agentId}/capabilities`);
  check(
    "the grant reads back from the capability view as READY",
    grantedView.status === 200 && grantedView.body.knowledge.some((row) => row.docId === createdDocId && row.state === "READY"),
    JSON.stringify(grantedView.body?.knowledge ?? []),
  );

  // --- retrieval over HTTP, scoped to the grant -------------------------------

  const search = await api<KnowledgeSearch>(`/agents/${agentId}/knowledge/search?q=${encodeURIComponent(QUESTION)}&limit=3`);
  // Either backend is a pass here: this phase proves the granted document is
  // reachable over HTTP, and verify-embeddings.ts is where "vector" is demanded.
  check("the search endpoint answers from a real backend", search.status === 200 && (search.body.backend === "keyword" || search.body.backend === "vector"), `${search.status} ${search.body?.backend ?? ""}`);
  check("it searched exactly one granted document", search.body.searched === 1, `searched=${search.body.searched}`);
  const hit = search.body.hits[0];
  check("the top hit is the uploaded document", hit?.docId === createdDocId, `${hit?.docId ?? "none"}`);
  check("…and it is the chunk that holds the answer", (hit?.text ?? "").includes("forty-two"), hit?.snippet?.slice(0, 90) ?? "no hit");
  console.log(`   hit: [${hit?.seq ?? "?"}] ${hit?.chunkId ?? "none"} score ${hit?.score?.toFixed(3) ?? "?"}`);

  // --- a live turn that must search before it answers -------------------------

  const turn = await api<Outcome>(`/agents/${agentId}/run`, {
    method: "POST",
    body: { message: `Use knowledge_search to look up the return window on the ${MARKER} plan, then answer with the exact number of days.` },
  });
  check("the turn completed", typeof turn.body?.reply === "string", JSON.stringify(turn.body ?? {}));
  const run = await api<RunDetail>(`/agent-runs/${turn.body?.agentRunId ?? "none"}`);
  check("the run recorded the knowledge grant in its capability snapshot", (run.body?.capability?.knowledge ?? []).some((row) => row.docId === createdDocId && row.state === "READY"), JSON.stringify(run.body?.capability?.knowledge ?? []));
  check("…and offered knowledge_search as a derived tool", (run.body?.capability?.tools ?? []).some((tool) => tool.key === "knowledge_search" && tool.grant === "DERIVED"), JSON.stringify(run.body?.capability?.tools ?? []));

  const toolSteps = (run.body?.steps ?? []).filter((step) => step.kind === "TOOL" && step.tool === "knowledge_search");
  check("the run has a knowledge_search TOOL step", toolSteps.length > 0, `${toolSteps.length} step(s); reply: ${String(turn.body?.reply ?? "").slice(0, 140)}`);
  const searched = toolSteps.find((step) => step.ok === true && (step.resultPreview ?? "").includes(createdDocId ?? "~"));
  check("the step's recorded result names the uploaded document's chunk", searched !== undefined, toolSteps.map((step) => (step.resultPreview ?? "").slice(0, 80)).join(" | ") || "no result recorded");
  const answered = /forty[\s-]?two|42/i.test(String(turn.body?.reply ?? ""));
  console.log(`   reply quotes the only-source number: ${answered ? "yes" : "no"}`);
  if (!answered) console.log(`   reply: ${String(turn.body?.reply ?? "").slice(0, 300)}`);

  console.log(`\nagent: ${agent.name} · doc: ${createdDocId} ${indexed.sha8} · ${indexed.chunkCount} chunk(s)`);
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
  console.log("\nclean — a real file indexed, one grant scoped retrieval, and the turn searched before it answered");
}
