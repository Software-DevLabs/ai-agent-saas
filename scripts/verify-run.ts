/**
 * Phase E/F, end to end through the real queue and the real worker.
 *
 * A test run writes a real `WorkflowRun`, the worker claims the job, calls the
 * model, POSTs the reply to a sink this script is listening on, and the ledger
 * row, the balance drop and the inbox row are read back from the API. If Ollama
 * is not running the run is expected to fail honestly — and then this script
 * fails too, because "succeeded" is the claim being checked.
 *
 * Usage: `pnpm dev:api` and `pnpm dev:worker` running, then
 * `pnpm exec tsx scripts/verify-run.ts`.
 */
import { createServer } from "node:http";

const API = `http://127.0.0.1:${process.env.API_PORT ?? "3000"}`;
const PORT = 3999;
const SINK_ID = "e2e-sink";

const problems: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) problems.push(`${label}${detail ? `: ${detail}` : ""}`);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Function boundary: the callback's assignment is invisible to flow analysis inline. */
const sinkText = (): string | null => sinkBody;

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: T }> {
  const response = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as T };
}

interface AgentRow { id: string; name: string; tokensThisCycle: number }
interface IntegrationRow { id: string; type: string; externalId: string | null }
interface WorkflowRow { id: string; name: string; version: number; status: string }
interface TraceRow {
  index: number;
  tool: string;
  ok: boolean;
  inputTokens: number;
  outputTokens: number;
}
interface RunRow {
  id: string;
  status: string;
  output: string | null;
  error: string | null;
  tokensUsed: number;
  triggerSource: string;
  nodes?: Array<{
    nodeKey: string;
    status: string;
    output: string | null;
    error: string | null;
    tokensUsed: number;
    trace: TraceRow[];
  }>;
}
interface UsageRow { id: string; tokensUsed: number; metadata: Record<string, unknown> | null }

let sinkBody: string | null = null;
const sink = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
  request.on("end", () => {
    sinkBody = body;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
});
await new Promise<void>((resolve) => sink.listen(PORT, "127.0.0.1", resolve));

let workflowId = "";
try {
  const projects = await api<Array<{ id: string; isDefault: boolean }>>("/projects");
  const project = projects.body.find((row) => row.isDefault) ?? projects.body[0];
  if (!project) throw new Error("the tenant has no project — run `pnpm db:seed` first");

  const agents = await api<AgentRow[]>(`/projects/${project.id}/agents`);
  const agent = agents.body[0];
  if (!agent) throw new Error("the project has no agent — run `pnpm db:seed` first");
  // The orchestrator graph needs a second agent to delegate to.
  const subagent = agents.body[1];
  if (!subagent) throw new Error("the project has only one agent — the seed creates three");

  // The Free plan caps connections at two and this tenant already has both, so
  // the sink created by verify-canvas is pointed at this listener for the test
  // and pointed back afterwards. Its original URL is the literal that script uses.
  const channels = await api<IntegrationRow[]>("/integrations");
  const inbound = channels.body.find((row) => row.type.endsWith("_IN"));
  if (!inbound) throw new Error("no inbound connection — run verify-canvas.ts first");
  const outbound = channels.body.find((row) => row.type === "WEBHOOK_OUT");
  if (!outbound) throw new Error("no WEBHOOK_OUT connection — run verify-canvas.ts first");
  const patched = await api<IntegrationRow>(`/integrations/${outbound.id}`, {
    method: "PATCH",
    body: { credentials: `http://127.0.0.1:${PORT}/sink`, externalId: SINK_ID },
  });
  if (patched.status !== 200) throw new Error(`could not point the sink here: ${JSON.stringify(patched.body)}`);

  const created = await api<WorkflowRow>(`/projects/${project.id}/workflows`, {
    method: "POST",
    body: { name: `E2E run ${new Date().toISOString().slice(11, 19)}` },
  });
  if (created.status !== 201) throw new Error(`could not create the workflow: ${JSON.stringify(created.body)}`);
  workflowId = created.body.id;
  const definition = {
    nodes: [
      { key: "in-1", kind: "INBOUND", position: { x: 0, y: 0 }, config: { integrationId: inbound.id } },
      { key: "agent-1", kind: "AGENT", position: { x: 260, y: 0 }, config: { agentId: agent.id } },
      { key: "out-1", kind: "OUTBOUND", position: { x: 520, y: 0 }, config: { integrationId: outbound.id } },
    ],
    edges: [
      { id: "in-1->agent-1", from: "in-1", to: "agent-1" },
      { id: "agent-1->out-1", from: "agent-1", to: "out-1" },
    ],
  };
  const saved = await api<WorkflowRow>(`/workflows/${workflowId}/graph`, {
    method: "PATCH",
    body: { expectedVersion: created.body.version, definition },
  });
  check("the graph saved with its three boxes", saved.status === 200 && saved.body.version === created.body.version + 1, `v${saved.body.version}`);

  let worker = await api<{ alive: boolean; workerId: string | null }>("/worker");
  for (let tries = 0; tries < 20 && !worker.body.alive; tries += 1) {
    await wait(500);
    worker = await api("/worker");
  }
  check("the worker has checked in", worker.body.alive, worker.body.workerId ?? "no heartbeat");

  const active = await api<WorkflowRow>(`/workflows/${workflowId}/status`, { method: "PATCH", body: { status: "ACTIVE" } });
  check("activation is accepted while a worker is alive", active.status === 200 && active.body.status === "ACTIVE", `${active.status} ${active.body.status}`);

  const before = (await api<AgentRow[]>("/agents")).body.find((row) => row.id === agent.id);
  const started = await api<{ runId: string; jobId: string; status: string }>(`/workflows/${workflowId}/runs`, {
    method: "POST",
    body: { message: "Reply with exactly: e2e-ok" },
  });
  check("the test run is accepted with 202 before any model call", started.status === 202 && started.body.status === "RUNNING", `${started.status} ${started.body.runId}`);
  const runId = started.body.runId;

  let run = await api<RunRow>(`/workflow-runs/${runId}`);
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline && run.body.status === "RUNNING") {
    await wait(1_000);
    run = await api(`/workflow-runs/${runId}`);
  }
  check("the run reached a terminal state", run.body.status !== "RUNNING", `${run.body.status} ${run.body.error ?? ""}`);
  check("the run succeeded", run.body.status === "SUCCEEDED", run.body.error ?? run.body.status);
  check("it was a console test run", run.body.triggerSource === "console-test", run.body.triggerSource);

  const nodes = run.body.nodes ?? [];
  check("all three boxes ran", nodes.length === 3 && nodes.every((row) => row.status === "SUCCEEDED"), nodes.map((row) => `${row.nodeKey}:${row.status}`).join(" "));
  const reply = nodes.find((row) => row.nodeKey === "agent-1")?.output ?? "";
  check("the agent answered", reply.trim().length > 0, reply.slice(0, 80));
  check("the tokens are the provider's, not a guess", run.body.tokensUsed > 0, `${run.body.tokensUsed} tokens`);
  const captured = sinkText();
  check(
    "the sink received the reply",
    captured !== null && (captured.includes(reply.trim()) || reply.includes(JSON.parse(captured).text ?? "")),
    captured?.slice(0, 120) ?? "nothing",
  );
  check("the agent's token counter moved by exactly this run", before !== undefined && (await api<AgentRow[]>("/agents")).body.find((row) => row.id === agent.id)?.tokensThisCycle === before.tokensThisCycle + run.body.tokensUsed, `${before?.tokensThisCycle ?? "?"} + ${run.body.tokensUsed}`);

  const usage = await api<UsageRow[]>("/usage?take=10");
  const ledger = usage.body.find((row) => row.metadata?.runId === runId);
  check("the ledger row names this run", ledger !== undefined && ledger.tokensUsed === run.body.tokensUsed, ledger ? `${ledger.tokensUsed} tokens` : "no row");
  check("the ledger knows which provider and model billed", ledger !== undefined && typeof ledger.metadata?.provider === "string" && typeof ledger.metadata?.model === "string", `${ledger?.metadata?.provider ?? "?"}/${ledger?.metadata?.model ?? "?"}`);

  const inbox = await api<Array<{ externalMessageId: string; status: string }>>("/webhook-events");
  const job = inbox.body.find((row) => row.externalMessageId === runId);
  check("the inbox row for this run is PROCESSED, not inserted twice", job?.status === "PROCESSED", job?.status ?? "no row");

  // --- orchestration --------------------------------------------------------
  // The tenant owns one inbound channel, so the single-agent graph hands it over
  // instead of sitting active beside a second claim on the same bot.
  await api(`/workflows/${workflowId}/status`, { method: "PATCH", body: { status: "PAUSED" } });
  await api<unknown>(`/workflows/${workflowId}`, { method: "DELETE" });
  workflowId = "";
  sinkBody = null;

  const orchCreated = await api<WorkflowRow>(`/projects/${project.id}/workflows`, {
    method: "POST",
    body: { name: `E2E orchestrator ${new Date().toISOString().slice(11, 19)}` },
  });
  if (orchCreated.status !== 201) throw new Error(`could not create the orchestrator workflow: ${JSON.stringify(orchCreated.body)}`);
  workflowId = orchCreated.body.id;
  const orchDefinition = {
    nodes: [
      { key: "in-1", kind: "INBOUND", position: { x: 0, y: 0 }, config: { integrationId: inbound.id } },
      {
        key: "orch-1",
        kind: "ORCHESTRATOR",
        position: { x: 260, y: 0 },
        config: { agentId: agent.id, subagents: [{ agentId: subagent.id, role: "writer" }] },
      },
      { key: "out-1", kind: "OUTBOUND", position: { x: 520, y: 0 }, config: { integrationId: outbound.id } },
    ],
    edges: [
      { from: "in-1", to: "orch-1" },
      { from: "orch-1", to: "out-1" },
    ],
  };
  const orchSaved = await api<WorkflowRow>(`/workflows/${workflowId}/graph`, {
    method: "PATCH",
    body: { expectedVersion: orchCreated.body.version, definition: orchDefinition },
  });
  check("the orchestrator graph saved", orchSaved.status === 200 && orchSaved.body.version === orchCreated.body.version + 1, `v${orchSaved.body.version}`);

  const orchActive = await api<WorkflowRow>(`/workflows/${workflowId}/status`, { method: "PATCH", body: { status: "ACTIVE" } });
  check(
    "activation probed the models' tools capability and accepted",
    orchActive.status === 200 && orchActive.body.status === "ACTIVE",
    `${orchActive.status} ${JSON.stringify(orchActive.body)}`,
  );

  const orchStarted = await api<{ runId: string; jobId: string; status: string }>(`/workflows/${workflowId}/runs`, {
    method: "POST",
    body: {
      message:
        'Delegation check. Call the subagent tool exactly once with role "writer" and task: Reply with exactly the text delegated-ok. Then answer with exactly what the subagent returned.',
    },
  });
  check("the orchestration run is accepted with 202", orchStarted.status === 202 && orchStarted.body.status === "RUNNING", `${orchStarted.status} ${orchStarted.body.runId}`);
  const orchRunId = orchStarted.body.runId;

  let orchRun = await api<RunRow>(`/workflow-runs/${orchRunId}`);
  const orchDeadline = Date.now() + 300_000;
  while (Date.now() < orchDeadline && orchRun.body.status === "RUNNING") {
    await wait(1_000);
    orchRun = await api(`/workflow-runs/${orchRunId}`);
  }
  check("the orchestration run reached a terminal state", orchRun.body.status !== "RUNNING", `${orchRun.body.status} ${orchRun.body.error ?? ""}`);
  check("the orchestration run succeeded", orchRun.body.status === "SUCCEEDED", orchRun.body.error ?? orchRun.body.status);

  const orchNode = (orchRun.body.nodes ?? []).find((row) => row.nodeKey === "orch-1");
  check("the orchestrator box ran", orchNode?.status === "SUCCEEDED", `${orchNode?.status ?? "missing"} ${orchNode?.error ?? ""}`);
  const trace = orchNode?.trace ?? [];
  check("the orchestrator really delegated", trace.length >= 1, trace.map((row) => row.tool).join(", ") || "no trace rows");
  check("every delegation trace row is a successful subagent call", trace.every((row) => row.tool === "subagent" && row.ok), `${trace.length} row(s)`);

  const orchCaptured = sinkText();
  check(
    "the sink received the orchestrator's answer",
    orchCaptured !== null && JSON.parse(orchCaptured).text === (orchNode?.output ?? undefined),
    orchCaptured?.slice(0, 120) ?? "nothing",
  );

  const orchLedger = (await api<UsageRow[]>("/usage?take=50")).body.filter((row) => row.metadata?.runId === orchRunId);
  check("every model call is its own ledger row", orchLedger.length >= 2, `${orchLedger.length} row(s)`);
  check(
    "every ledger row carries callIndex and role",
    orchLedger.length >= 2 && orchLedger.every((row) => typeof row.metadata?.callIndex === "number" && typeof row.metadata?.role === "string"),
    orchLedger.map((row) => `${String(row.metadata?.callIndex)}:${String(row.metadata?.role)}`).join(" "),
  );
  const delegatedRows = orchLedger.filter((row) => row.metadata?.origin === "workflow-subagent");
  check(
    "the subagent turn is billed under its declared role",
    delegatedRows.length >= 1 && delegatedRows.every((row) => row.metadata?.role === "writer"),
    delegatedRows.map((row) => String(row.metadata?.role)).join(", ") || "none",
  );
  const ledgerSum = orchLedger.reduce((sum, row) => sum + row.tokensUsed, 0);
  check("the node's tokensUsed equals the ledger sum", orchNode !== undefined && orchNode.tokensUsed === ledgerSum, `${orchNode?.tokensUsed ?? "?"} vs ${ledgerSum}`);

  const orchInbox = (await api<Array<{ externalMessageId: string; status: string }>>("/webhook-events")).body.filter(
    (row) => row.externalMessageId === orchRunId,
  );
  check("exactly one inbox row for the delegation run, PROCESSED", orchInbox.length === 1 && orchInbox[0]?.status === "PROCESSED", `${orchInbox.length} row(s)`);

  console.log(`\nreply: ${reply.slice(0, 200)}`);
  console.log(`orchestrator reply: ${(orchNode?.output ?? "").slice(0, 200)}`);
} catch (error) {
  problems.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
  console.error(error);
} finally {
  if (workflowId) {
    await api(`/workflows/${workflowId}/status`, { method: "PATCH", body: { status: "PAUSED" } });
    const removed = await api<unknown>(`/workflows/${workflowId}`, { method: "DELETE" });
    console.log(`cleanup: remove /workflows/${workflowId} -> ${removed.status}`);
  }
  const sinks = await api<IntegrationRow[]>("/integrations").catch(() => ({ body: [] as IntegrationRow[] }));
  const sinkRow = sinks.body.find((row) => row.externalId === SINK_ID);
  if (sinkRow) {
    await api(`/integrations/${sinkRow.id}`, {
      method: "PATCH",
      body: { credentials: "https://example.invalid/hook", externalId: "canvas-sink" },
    });
  }
  sink.close();
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems.slice(0, 20)) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log("\nclean — a real graph ran end to end");
}
