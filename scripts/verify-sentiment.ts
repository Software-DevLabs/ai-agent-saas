/**
 * Sentiment, end to end over HTTP — a real question, a real label, a real ledger row.
 *
 * Two questions are asked through the public widget lane: one that is plainly
 * grateful, one that is plainly fed up. The script waits for the classifier lane
 * to write its own `EmbedFeedback` rows, then reads them back through the same
 * console routes the Insights tab uses. What is asserted is what makes the page
 * trustworthy: one row per message, the label came from a model (not from a
 * fallback), the model is named, the tokens were billed as CLASSIFY rows on the
 * ledger, and the sentiment filter narrows the list without touching the counts.
 *
 * Requires `pnpm dev:api`, `pnpm dev:worker` and Ollama with the configured chat
 * model, then `pnpm exec tsx scripts/verify-sentiment.ts`.
 */

export {};

const API = `http://127.0.0.1:${process.env.API_PORT ?? "3000"}`;
const ALLOWED = "http://localhost:5173";
const SESSION = `sentiment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

interface EmbedCreate {
  embed: { id: string; name: string };
  key: string;
}
interface Projection {
  messageId: string;
  status: string;
  reply: string | null;
  error: string | null;
}
interface FeedbackRow {
  id: string;
  embedId: string;
  embedName: string;
  messageId: string;
  question: string;
  answer: string | null;
  sentiment: string;
  score: number | null;
  source: string;
  model: string | null;
  error: string | null;
  tokensUsed: number;
  createdAt: string;
}
interface Insights {
  scope: string;
  scopeId: string;
  embedCount: number;
  totals: { POSITIVE: number; NEUTRAL: number; NEGATIVE: number; UNKNOWN: number; total: number };
  feedback: FeedbackRow[];
}
interface UsageEvent {
  id: string;
  kind: string;
  tokensUsed: number;
  metadata: Record<string, unknown>;
}

const POSITIVE_QUESTION = "Thank you so much — the new dashboard is exactly what we needed, you have been wonderful.";
const NEGATIVE_QUESTION =
  "This is the third time I have asked and nobody has answered. Why is checkout still broken? I am sick of waiting.";

let widgetId: string | null = null;

async function cleanup(): Promise<void> {
  if (widgetId !== null) await api(`/embeds/${widgetId}`, { method: "DELETE" });
}

async function ask(key: string, message: string): Promise<string> {
  const res = await api<{ messageId?: string; error?: string }>(`/embed/v1/message?key=${encodeURIComponent(key)}`, {
    method: "POST",
    origin: ALLOWED,
    body: { sessionId: SESSION, message },
  });
  if (res.status !== 202 || typeof res.body.messageId !== "string") {
    throw new Error(`the question was not accepted (${res.status} ${res.body?.error ?? ""})`);
  }
  return res.body.messageId;
}

async function pollAnswer(key: string, messageId: string, timeoutMs = 150_000): Promise<Projection | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const res = await api<Projection>(
      `/embed/v1/message/${messageId}?key=${encodeURIComponent(key)}&session=${encodeURIComponent(SESSION)}`,
      { origin: ALLOWED },
    );
    if (res.status === 200 && (res.body.status === "ANSWERED" || res.body.status === "FAILED")) return res.body;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}

/**
 * The classifier is a separate lane, so it finishes after the answer. This waits
 * for the *rows*, not for a checkmark: what the Insights tab will show is read
 * back from the same endpoint, so a label that never reached the table cannot be
 * mistaken for one that did.
 */
async function waitForFeedback(expected: string[], timeoutMs = 120_000): Promise<FeedbackRow[]> {
  const startedAt = Date.now();
  let last: FeedbackRow[] = [];
  while (Date.now() - startedAt < timeoutMs) {
    const res = await api<Insights>(`/embeds/${widgetId}/insights?limit=20`);
    last = Array.isArray(res.body?.feedback) ? res.body.feedback : [];
    if (expected.every((messageId) => last.some((row) => row.messageId === messageId))) return last;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return last;
}

try {
  const projects = await api<Array<{ id: string; isDefault: boolean }>>("/projects");
  const project = projects.body.find((row) => row.isDefault) ?? projects.body[0];
  if (!project) throw new Error("the tenant has no project — run `pnpm db:seed` first");

  const agents = await api<Array<{ id: string; name: string; status: string }>>(`/projects/${project.id}/agents`);
  const agent = agents.body.find((row) => row.status === "ACTIVE");
  if (!agent) throw new Error("this project has no ACTIVE agent — activate one before verifying sentiment");

  const created = await api<EmbedCreate>(`/agents/${agent.id}/embeds`, {
    method: "POST",
    body: { name: `Sentiment check ${new Date().toISOString().slice(11, 19)}`, origins: [ALLOWED] },
  });
  check("the console creates a widget to ask through", created.status === 201 && typeof created.body.key === "string", `${created.status}`);
  widgetId = created.body?.embed?.id ?? null;
  const key = created.body?.key ?? "";
  if (widgetId === null || key === "") throw new Error("the widget was not created");

  const before = await api<Insights>(`/projects/${project.id}/insights?limit=100`);
  const beforeTotal = before.body?.totals?.total ?? 0;

  // --- two real questions, on the worker's public lane -------------------------

  const positiveId = await ask(key, POSITIVE_QUESTION);
  check("the grateful question is accepted with 202", positiveId !== "", positiveId);
  const negativeId = await ask(key, NEGATIVE_QUESTION);
  check("the frustrated question is accepted with 202", negativeId !== "", negativeId);

  const positiveAnswer = await pollAnswer(key, positiveId);
  check("the first answer is ANSWERED", positiveAnswer?.status === "ANSWERED", `${positiveAnswer?.status ?? "timed out"}${positiveAnswer?.error ? ` — ${positiveAnswer.error}` : ""}`);
  const negativeAnswer = await pollAnswer(key, negativeId);
  check("the second answer is ANSWERED", negativeAnswer?.status === "ANSWERED", `${negativeAnswer?.status ?? "timed out"}${negativeAnswer?.error ? ` — ${negativeAnswer.error}` : ""}`);
  if (positiveAnswer?.status !== "ANSWERED" || negativeAnswer?.status !== "ANSWERED") {
    throw new Error("a widget turn did not finish — is `pnpm dev:worker` running with Ollama up?");
  }

  // --- the classifier's own rows, read back through the console route ----------

  const rows = await waitForFeedback([positiveId, negativeId]);
  check("one feedback row per embed message", rows.length === 2, `${rows.length} row(s)`);
  check("…and they are the two messages that were asked", rows.map((row) => row.messageId).sort().join(",") === [positiveId, negativeId].sort().join(","), rows.map((row) => row.messageId).join(","));

  const positiveRow = rows.find((row) => row.messageId === positiveId);
  const negativeRow = rows.find((row) => row.messageId === negativeId);
  check("every row names the model that judged it", rows.every((row) => typeof row.model === "string" && row.model.length > 0), rows.map((row) => row.model ?? "none").join(", "));
  check("every row came from a real model classification, not a fallback", rows.every((row) => row.source === "model"), rows.map((row) => `${row.sentiment}:${row.source}`).join(", "));
  check("every row cost tokens (the call happened)", rows.every((row) => row.tokensUsed > 0), rows.map((row) => `${row.tokensUsed}`).join(", "));
  check(
    "scores are the model's own, and inside 0–1 when present",
    rows.every((row) => row.score === null || (Number.isFinite(row.score) && row.score >= 0 && row.score <= 1)),
    rows.map((row) => (row.score === null ? "—" : row.score.toFixed(2))).join(", "),
  );
  check("…and each row carries the question it judged", rows.every((row) => row.question.trim().length > 0), rows.map((row) => row.question.slice(0, 40)).join(" | "));

  check(
    "the grateful question was read as POSITIVE",
    positiveRow?.sentiment === "POSITIVE",
    positiveRow === undefined ? "no row" : `${positiveRow.sentiment} (${positiveRow.model ?? "?"}, score ${positiveRow.score ?? "—"})`,
  );
  check(
    "the frustrated question was read as NEGATIVE",
    negativeRow?.sentiment === "NEGATIVE",
    negativeRow === undefined ? "no row" : `${negativeRow.sentiment} (${negativeRow.model ?? "?"}, score ${negativeRow.score ?? "—"})`,
  );

  // --- counts and the filter, from the project route the Insights tab calls ----

  const projectView = await api<Insights>(`/projects/${project.id}/insights?limit=100`);
  check("the project view counts the new rows", (projectView.body?.totals?.total ?? 0) === beforeTotal + 2, `${projectView.body?.totals?.total ?? 0} vs ${beforeTotal} before`);
  check("…in the tenant the session belongs to", projectView.body?.scope === "project" && projectView.body?.scopeId === project.id, projectView.body?.scope ?? "none");
  const projectRows = (projectView.body?.feedback ?? []).filter((row) => row.messageId === positiveId || row.messageId === negativeId);
  check("…and lists them with their widget's name", projectRows.length === 2 && projectRows.every((row) => row.embedName === created.body.embed.name), projectRows.map((row) => row.embedName).join(", "));

  const filtered = await api<Insights>(`/projects/${project.id}/insights?sentiment=POSITIVE&limit=100`);
  check("the sentiment filter narrows the list", (filtered.body?.feedback ?? []).every((row) => row.sentiment === "POSITIVE"), `${(filtered.body?.feedback ?? []).length} row(s)`);
  check("…without rewriting the counters", JSON.stringify(filtered.body?.totals) === JSON.stringify(projectView.body?.totals), `${filtered.body?.totals?.total ?? "?"} vs ${projectView.body?.totals?.total ?? "?"}`);

  const widgetView = await api<Insights>(`/embeds/${widgetId}/insights?limit=20`);
  check("the widget view counts exactly its own two messages", widgetView.body?.totals?.total === 2, `${widgetView.body?.totals?.total ?? 0}`);
  check("…with one row per sentiment present", (widgetView.body?.totals?.POSITIVE ?? 0) + (widgetView.body?.totals?.NEUTRAL ?? 0) + (widgetView.body?.totals?.NEGATIVE ?? 0) + (widgetView.body?.totals?.UNKNOWN ?? 0) === 2, JSON.stringify(widgetView.body?.totals ?? {}));

  // --- the cost of listening is on the ledger ---------------------------------

  const usage = await api<UsageEvent[]>("/usage?take=200");
  const classifyRows = (Array.isArray(usage.body) ? usage.body : []).filter(
    (event) => event.kind === "CLASSIFY" && [positiveId, negativeId].includes(String(event.metadata?.messageId ?? "")),
  );
  check("the ledger has one CLASSIFY row per judged question", classifyRows.length === 2, `${classifyRows.length} row(s)`);
  check("…with the provider's tokens on it", classifyRows.every((event) => event.tokensUsed > 0), classifyRows.map((event) => event.tokensUsed).join(", "));
  check(
    "…and the label it paid for",
    classifyRows.every((event) => rows.some((row) => row.messageId === event.metadata?.messageId && row.sentiment === event.metadata?.sentiment)),
    classifyRows.map((event) => `${String(event.metadata?.messageId).slice(0, 8)}:${String(event.metadata?.sentiment)}`).join(", "),
  );

  console.log(`\nwidget: ${widgetId} · ${rows.length} label(s) · ${classifyRows.reduce((sum, event) => sum + event.tokensUsed, 0)} classify token(s)`);
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
  console.log("\nclean — every public question got a model-read label, the counts and filter agree with the rows, and the listening is on the ledger");
}
