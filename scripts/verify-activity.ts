/**
 * Agent activity, end to end against the real database and the real model.
 *
 * The claim being checked is not "the console renders": it is that a direct turn
 * writes an `AgentRun` row *while it is still running*, that every model round
 * and tool call lands as its own `AgentRunStep`, that the row's token total is
 * the sum of the ledger rows tagged with it, and that the persisted output is
 * the reply the caller received. If Ollama is down the turn fails honestly — and
 * this script fails with it, because "it recorded the work" is the thing tested.
 *
 * Usage: `pnpm dev:api` running (and Ollama), then
 * `pnpm exec tsx scripts/verify-activity.ts`.
 */

// The file is an ESM entry point with no exports; this is what lets TS allow
// top-level `await` instead of reading it as a classic script.
export {};

const API = `http://127.0.0.1:${process.env.API_PORT ?? "3000"}`;
const DEADLINE_MS = 180_000;
const problems: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) problems.push(`${label}${detail ? `: ${detail}` : ""}`);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: T }> {
  const response = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as T };
}

interface AgentRow { id: string; name: string; status: string }
interface AgentRunRow {
  id: string;
  agentId: string;
  agentName: string;
  status: string;
  conversationId: string | null;
  input: string;
  output: string | null;
  error: string | null;
  tokensUsed: number;
  stepCount: number;
  toolCallCount: number;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
}
interface StepRow {
  id: string;
  seq: number;
  round: number;
  kind: string;
  tool: string | null;
  ok: boolean | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}
interface RunDetail extends AgentRunRow { steps: StepRow[] }
interface ActivityRow {
  id: string;
  source: string;
  status: string;
  agentId: string | null;
  agentName: string | null;
  inputPreview: string;
  tokensUsed: number;
}
interface UsageRow { id: string; tokensUsed: number; metadata: Record<string, unknown> | null }
interface Outcome {
  conversationId: string;
  reply: string;
  inputTokens: number;
  outputTokens: number;
  tokensUsed: number;
  steps: number;
  trace: Array<{ tool: string; ok: boolean }>;
  agentRunId: string | null;
}

try {
  const projects = await api<Array<{ id: string; isDefault: boolean }>>("/projects");
  const project = projects.body.find((row) => row.isDefault) ?? projects.body[0];
  if (!project) throw new Error("the tenant has no project — run `pnpm db:seed` first");

  const agents = await api<AgentRow[]>(`/projects/${project.id}/agents`);
  const agent = agents.body.find((row) => row.status === "ACTIVE") ?? agents.body[0];
  if (!agent) throw new Error("the project has no agent — run `pnpm db:seed` first");

  const prompt = `Activity check ${new Date().toISOString().slice(11, 19)}. Reply with exactly: activity-ok`;

  // The POST is synchronous and the run row is written when the turn starts, so
  // the poll below races it: observing the same row in RUNNING is the only way
  // to prove the console would have shown live progress rather than history.
  // The turn's promise is never awaited inside the loop — that would wait for
  // the turn to end and the race would always be lost.
  let turnSettled = false;
  const posted = api<Outcome>(`/agents/${agent.id}/run`, { method: "POST", body: { message: prompt } })
    .then((response) => response.body);
  posted.then(
    () => { turnSettled = true; },
    () => { turnSettled = true; },
  );

  let seenRunning: AgentRunRow | null = null;
  const pollDeadline = Date.now() + DEADLINE_MS;
  while (Date.now() < pollDeadline && !turnSettled) {
    const live = await api<AgentRunRow[]>(`/agents/${agent.id}/runs?status=RUNNING&limit=1`);
    if (live.body.length > 0) {
      seenRunning = live.body[0] ?? null;
      break;
    }
    await wait(60);
  }
  check("a run row existed while the turn was still in flight", seenRunning !== null, seenRunning?.id ?? "never observed RUNNING");

  const outcome = await posted;
  // A refused turn answers with an error envelope, not an outcome; say so with
  // the body rather than crashing three lines later.
  if (typeof outcome.reply !== "string") throw new Error(`POST /agents/${agent.id}/run failed: ${JSON.stringify(outcome)}`);
  check("the turn succeeded", outcome.reply.trim().length > 0, `reply="${outcome.reply.slice(0, 40)}"`);
  check("the response names its activity row", outcome.agentRunId !== null, outcome.agentRunId ?? "agentRunId was null");
  check(
    "the in-flight row is the row the turn finished as",
    seenRunning === null || outcome.agentRunId === seenRunning.id,
    `${seenRunning?.id ?? "n/a"} vs ${outcome.agentRunId ?? "n/a"}`,
  );

  let run = await api<RunDetail>(`/agent-runs/${outcome.agentRunId ?? "none"}`);
  const detailDeadline = Date.now() + 30_000;
  while (run.status === 200 && run.body.status === "RUNNING" && Date.now() < detailDeadline) {
    await wait(500);
    run = await api<RunDetail>(`/agent-runs/${outcome.agentRunId ?? "none"}`);
  }
  check("the run row reached a terminal state", run.status === 200 && run.body.status !== "RUNNING", `${run.status} ${run.body?.status ?? ""} ${run.body?.error ?? ""}`);
  check("the persisted output is the reply that was returned", run.body.output === outcome.reply, `${String(run.body.output).slice(0, 40)}`);
  check("the run carries the conversation it wrote to", run.body.conversationId === outcome.conversationId, run.body.conversationId ?? "null");
  check("the run snapshots the agent's name at the time it ran", run.body.agentName === agent.name, run.body.agentName ?? "null");
  check("the run row closed as SUCCEEDED", run.body.status === "SUCCEEDED", `${run.body.status} ${run.body.error ?? ""}`);
  const modelSteps = run.body.steps.filter((row) => row.kind === "MODEL");
  const toolSteps = run.body.steps.filter((row) => row.kind === "TOOL");
  // `stepCount` is the model rounds the turn billed; the row set also holds one
  // row per tool call, so the two numbers are meant to differ.
  check("at least one model round was recorded", modelSteps.length >= 1, `${modelSteps.length} round(s)`);
  check("the run's round count is what the turn billed", run.body.stepCount === outcome.steps, `${run.body.stepCount} vs ${outcome.steps}`);
  check("every round and every tool call is its own step row", run.body.steps.length === outcome.steps + outcome.trace.length, `${run.body.steps.length} rows vs ${outcome.steps}+${outcome.trace.length}`);
  check("the tool rows are the calls the caller saw", toolSteps.length === outcome.trace.length, `${toolSteps.length} vs ${outcome.trace.length}`);
  check("the run's tool counter matches its tool rows", run.body.toolCallCount === toolSteps.length, `${run.body.toolCallCount} vs ${toolSteps.length}`);
  check("the step sequence is contiguous from 1", run.body.steps.every((row, index) => row.seq === index + 1), run.body.steps.map((row) => row.seq).join(","));
  check("the first step is a model round", run.body.steps[0]?.kind === "MODEL", run.body.steps[0]?.kind ?? "none");
  check("model rounds carry the tokens that were billed", modelSteps.every((row) => row.inputTokens + row.outputTokens > 0), `${modelSteps.length} round(s)`);
  check("every step timed itself", run.body.steps.every((row) => row.durationMs >= 0), `${run.body.steps.length} step(s)`);
  check("the run's own token total is the sum of its steps", run.body.tokensUsed === run.body.steps.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0), `${run.body.tokensUsed}`);
  check("the run row reports the same total as the response", run.body.tokensUsed === outcome.tokensUsed, `${run.body.tokensUsed} vs ${outcome.tokensUsed}`);

  const ledger = await api<UsageRow[]>("/usage?take=500");
  const rows = ledger.body.filter((row) => row.metadata?.agentRunId === outcome.agentRunId);
  check("every ledger row for this turn is tagged with its run id", rows.length >= 1, `${rows.length} row(s)`);
  check(
    "the run's tokens are exactly the ledger rows it produced",
    rows.reduce((sum, row) => sum + row.tokensUsed, 0) === run.body.tokensUsed,
    `${rows.reduce((sum, row) => sum + row.tokensUsed, 0)} vs ${run.body.tokensUsed}`,
  );

  const feed = await api<ActivityRow[]>("/activity?limit=50");
  const item = feed.body.find((row) => row.id === outcome.agentRunId);
  check("the merged feed shows this turn as an AGENT_RUN", item?.source === "AGENT_RUN", item?.source ?? "not in the feed");
  check("the feed row's preview is the message that was sent", item !== undefined && item.inputPreview.includes("activity-ok"), item?.inputPreview.slice(0, 60) ?? "");
  check("the feed row is terminal, like the row it came from", item?.status === run.body.status, `${item?.status ?? "?"} vs ${run.body.status}`);

  const scoped = await api<ActivityRow[]>(`/activity?agentId=${agent.id}&limit=50`);
  check("the feed filter never returns another agent's work", scoped.body.every((row) => row.agentId === agent.id), `${scoped.body.length} row(s)`);
  check("the filtered feed still holds this turn", scoped.body.some((row) => row.id === outcome.agentRunId), "");

  const runs = await api<AgentRunRow[]>("/agent-runs?limit=5");
  check("the tenant-wide list honours the limit it was given", runs.body.length <= 5, `${runs.body.length} row(s)`);
  check("the tenant-wide list holds this turn", runs.body.some((row) => row.id === outcome.agentRunId), runs.body.map((row) => row.id).join(","));
  check("every listed run names the agent that ran, from its own snapshot", runs.body.every((row) => row.agentName.length > 0), "");
  const one = await api<AgentRunRow[]>("/agent-runs?limit=1");
  check("limit=1 is one row, not a page", one.body.length === 1, `${one.body.length} row(s)`);
  const missing = await api<{ error: string }>("/agent-runs/run_that_does_not_exist");
  check("an unknown run id is a 404, not an empty drawer", missing.status === 404 && missing.body.error === "run_not_found", `${missing.status}`);

  const workflows = await api<Array<{ id: string; projectId: string | null }>>("/workflow-runs?limit=20");
  check("workflow runs answer with a project id or an honest null", workflows.status === 200 && workflows.body.every((row) => "projectId" in row), `${workflows.body.length} row(s)`);

  console.log(`\nagent: ${agent.name} · run: ${outcome.agentRunId} · ${run.body.tokensUsed} tokens · ${run.body.steps.length} step(s)`);
  for (const step of run.body.steps) {
    console.log(`  ${String(step.seq).padStart(2)}. ${step.kind}${step.tool ? ` ${step.tool}` : ""} · ${step.inputTokens}+${step.outputTokens} · ${step.durationMs}ms`);
  }
} catch (error) {
  problems.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems.slice(0, 20)) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log("\nclean — a live turn recorded every round it ran");
}
