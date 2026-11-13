/**
 * The public widget, end to end over HTTP — as a stranger's browser would use it.
 *
 * It creates a real widget through the console routes, loads the bundle the
 * snippet names, asks a question with an allowed `Origin`, and then reads the
 * answer back through the same projection the widget polls. The rate-limit half
 * drains the bucket with cheap invalid bodies (a request is what the bucket
 * limits) and compares the 429s it actually saw against the `rejected` counts the
 * console reads — a number that is written by the same statement that refuses.
 *
 * The turn is a real model call on the worker's `embed.turn` lane, so it needs
 * `pnpm dev:api`, `pnpm dev:worker`, Ollama, and a built bundle
 * (`pnpm --filter @saas/web build:embed`).
 */

export {};

const API = `http://127.0.0.1:${process.env.API_PORT ?? "3000"}`;
const ALLOWED = "http://localhost:5173";
const EVIL = "https://not-your-site.example";
const CAPACITY = Number(process.env.EMBED_RATE_CAPACITY ?? "20");
const problems: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) problems.push(`${label}${detail ? `: ${detail}` : ""}`);
}

async function api<T>(
  path: string,
  init?: { method?: string; body?: unknown; origin?: string },
): Promise<{ status: number; headers: Headers; body: T }> {
  const response = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init?.origin === undefined ? {} : { origin: init.origin }),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: (text === "" ? null : JSON.parse(text)) as T };
}

interface EmbedWidget {
  id: string;
  agentId: string;
  name: string;
  keyHint: string;
  origins: string[];
  status: string;
}
interface EmbedList {
  embeds: EmbedWidget[];
  bundle: { served: boolean; file: string };
}
interface EmbedCreate {
  embed: EmbedWidget;
  key: string;
  snippet: string;
  bundle: { served: boolean; file: string };
}
interface Projection {
  messageId: string;
  status: string;
  reply: string | null;
  actions: { kind: string; label: string; url: string }[];
  citations: unknown[];
  error: string | null;
}
interface Conversation {
  id: string;
  agentId: string;
  externalChatId: string | null;
  messageCount: number;
}

const FORBIDDEN = ["systemPrompt", "tokensUsed", "costUsdEstimate", "conversationId", "tenantId", "projectId", "trace", "steps"];
const SESSION = `verify-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let widgetId: string | null = null;

async function cleanup(): Promise<void> {
  if (widgetId !== null) await api(`/embeds/${widgetId}`, { method: "DELETE" });
}

async function ask(key: string, message: string): Promise<{ status: number; headers: Headers; body: { messageId?: string } }> {
  return api<{ messageId?: string }>(`/embed/v1/message?key=${encodeURIComponent(key)}`, {
    method: "POST",
    origin: ALLOWED,
    body: { sessionId: SESSION, message },
  });
}

async function poll(key: string, messageId: string, timeoutMs = 150_000): Promise<{ projection: Projection | null; raw: string }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const res = await api<Projection>(
      `/embed/v1/message/${messageId}?key=${encodeURIComponent(key)}&session=${encodeURIComponent(SESSION)}`,
      { origin: ALLOWED },
    );
    if (res.status === 200 && (res.body.status === "ANSWERED" || res.body.status === "FAILED")) {
      return { projection: res.body, raw: JSON.stringify(res.body) };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return { projection: null, raw: "" };
}

try {
  const projects = await api<Array<{ id: string; isDefault: boolean }>>("/projects");
  const project = projects.body.find((row) => row.isDefault) ?? projects.body[0];
  if (!project) throw new Error("the tenant has no project — run `pnpm db:seed` first");

  const agents = await api<Array<{ id: string; name: string; status: string }>>(`/projects/${project.id}/agents`);
  const agent = agents.body.find((row) => row.status === "ACTIVE");
  if (!agent) throw new Error("this project has no ACTIVE agent — the public surface refuses a draft on purpose");

  // --- a real widget, over the console routes ---------------------------------

  const created = await api<EmbedCreate>(`/agents/${agent.id}/embeds`, {
    method: "POST",
    body: { name: `Verify widget ${new Date().toISOString().slice(11, 19)}`, origins: [ALLOWED] },
  });
  check("the console creates a widget and returns its key once", created.status === 201 && created.body.key?.startsWith("emb_"), `${created.status}`);
  widgetId = created.body?.embed?.id ?? null;
  const key = created.body?.key ?? "";
  const bundle = created.body?.bundle;

  check("the bundle is built and the snippet names its versioned file", bundle?.served === true, bundle?.file ?? "not served");
  check("…and the snippet carries the key", created.body?.snippet?.includes(`data-key="${key}"`) === true, created.body?.snippet ?? "");
  if (bundle?.served !== true) {
    throw new Error("build the widget first: `pnpm --filter @saas/web build:embed`, then restart the API");
  }

  const listed = await api<EmbedList>(`/agents/${agent.id}/embeds`);
  const row = listed.body.embeds.find((entry) => entry.id === widgetId);
  check("the list reads the row back with the hint, not the key", row !== undefined && row.keyHint.startsWith("emb_"), row?.keyHint ?? "missing");
  check("…and the JSON holds no raw key", !JSON.stringify(listed.body).includes(key), JSON.stringify(listed.body).includes(key) ? "raw key present in list" : "list carries only the hint");

  const served = await fetch(`${API}/embed/${bundle.file}`);
  const js = await served.text();
  check("the API serves the bundle the snippet names", served.status === 200 && js.length > 1_000, `${served.status} ${js.length} bytes`);

  // --- the origin gate, as the browser sees it --------------------------------

  const allowedConfig = await api<{ agent: string; ready: boolean }>(`/embed/v1/config?key=${encodeURIComponent(key)}`, {
    origin: ALLOWED,
  });
  check("an allowed origin reads the config", allowedConfig.status === 200 && allowedConfig.body.ready === true, `${allowedConfig.status}`);
  check("…with its own origin in the CORS header", allowedConfig.headers.get("access-control-allow-origin") === ALLOWED, allowedConfig.headers.get("access-control-allow-origin") ?? "none");

  const evilConfig = await api<{ error?: string }>(`/embed/v1/config?key=${encodeURIComponent(key)}`, { origin: EVIL });
  check("a foreign origin is refused", evilConfig.status === 403, `${evilConfig.status}`);
  check("…and receives no access-control-allow-origin header", evilConfig.headers.get("access-control-allow-origin") === null, evilConfig.headers.get("access-control-allow-origin") ?? "none");

  const unknown = await api<{ error?: string }>(`/embed/v1/config?key=emb_thiskeydoesnotexistatall`, { origin: ALLOWED });
  check("an unknown key is a 404, not a fallback", unknown.status === 404 && unknown.body.error === "embed_not_found", `${unknown.status}`);

  // --- a real turn, through the worker's lane ---------------------------------

  const first = await ask(key, "Where can I find the login page?");
  check("a question from an allowed origin is accepted with 202", first.status === 202 && typeof first.body.messageId === "string", `${first.status}`);
  if (first.status !== 202) throw new Error("the message was not accepted — is the API's embed limiter wired?");
  const firstPoll = await poll(key, first.body.messageId ?? "");
  const projection = firstPoll.projection;
  check("the worker answered before the poll gave up", projection?.status === "ANSWERED", `${projection?.status ?? "timed out"}${projection?.error ? ` — ${projection.error}` : ""}`);
  check("…with a non-empty reply", (projection?.reply ?? "").trim().length > 0, projection?.reply?.slice(0, 80) ?? "");
  check(
    "…and exactly the six public fields",
    projection !== null && Object.keys(projection).sort().join(",") === "actions,citations,error,messageId,reply,status",
    projection === null ? "none" : Object.keys(projection).sort().join(","),
  );
  for (const field of FORBIDDEN) {
    if (firstPoll.raw.includes(`"${field}"`)) check(`the projection hides ${field}`, false, "present in the response");
  }
  check("the projection hides every operator field", FORBIDDEN.every((field) => !firstPoll.raw.includes(`"${field}"`)), FORBIDDEN.filter((field) => firstPoll.raw.includes(`"${field}"`)).join(", ") || "none");

  // --- one session, one thread -------------------------------------------------

  const chatId = `embed:${widgetId}:${SESSION}`;
  const conversations = await api<Conversation[]>(`/conversations?agentId=${agent.id}`);
  const thread = conversations.body.find((entry) => entry.externalChatId === chatId);
  check("the turn opened the session's own thread", thread !== undefined, chatId);
  check("…and it holds the question and the answer", (thread?.messageCount ?? 0) === 2, `${thread?.messageCount ?? 0} message(s)`);

  const second = await ask(key, "Thanks — what else can you help with?");
  check("a second question in the same session is accepted", second.status === 202, `${second.status}`);
  if (second.status === 202) {
    const secondPoll = await poll(key, second.body.messageId ?? "");
    check("…and answered", secondPoll.projection?.status === "ANSWERED", secondPoll.projection?.status ?? "timed out");
  }
  const conversationsAfter = await api<Conversation[]>(`/conversations?agentId=${agent.id}`);
  const sameThread = conversationsAfter.body.filter((entry) => entry.externalChatId === chatId);
  check("both questions landed in one conversation, not two", sameThread.length === 1, `${sameThread.length} thread(s)`);
  check("…with four messages (two questions, two answers)", (sameThread[0]?.messageCount ?? 0) === 4, `${sameThread[0]?.messageCount ?? 0}`);

  // --- the bucket refuses, and the refusal is a row ---------------------------

  let refused = 0;
  for (let i = 0; i < CAPACITY + 5; i += 1) {
    // Valid session, empty message: refused by validation (400) while the bucket
    // is healthy, refused by the bucket (429) once it is not.
    const res = await api(`/embed/v1/message?key=${encodeURIComponent(key)}`, {
      method: "POST",
      origin: ALLOWED,
      body: { sessionId: SESSION, message: "" },
    });
    if (res.status === 429) refused += 1;
  }
  const rates = await api<{ rates: Array<{ rejected: number; tokens: number }> }>(`/embeds/${widgetId}/rates`);
  const rejected = (rates.body?.rates ?? []).reduce((sum, bucket) => sum + bucket.rejected, 0);
  check("the bucket eventually refuses", refused > 0, `${refused} of ${CAPACITY + 5} refused`);
  check("…and every 429 is a counted row, not a log line", rejected === refused, `${rejected} recorded vs ${refused} observed`);

  console.log(`\nwidget: ${widgetId} · agent: ${agent.name} · ${refused} refusal(s) · thread ${thread?.id ?? "?"}`);
  await cleanup();
} catch (error) {
  problems.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
  await cleanup();
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems.slice(0, 25)) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log("\nclean — a stranger's origin got a real answer through the projection, one session stayed one thread, and every 429 was counted");
}
