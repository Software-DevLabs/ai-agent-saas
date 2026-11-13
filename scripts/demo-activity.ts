import { loadConfigFromEnv } from "@saas/shared";

/**
 * Real activity through the real API: every run below goes to the Ollama
 * daemon, and the tokens, messages, ledger rows and inbox entries it produces
 * are what the console then displays. Nothing here writes to the database
 * directly — if this script cannot reach the API it fails rather than
 * fabricating a row.
 *
 * Usage: `pnpm dev:api` in one terminal, `pnpm activity` in another.
 */
const config = loadConfigFromEnv();
const base = `http://127.0.0.1:${config.PORT}`;

interface AgentRow {
  id: string;
  name: string;
  status: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface RunOutcome {
  reply: string;
  inputTokens: number;
  outputTokens: number;
  tokensUsed: number;
  durationMs: number;
  conversationId: string;
}

const PROMPTS: Record<string, string[]> = {
  "Support Triage": [
    "Customer message: I was charged twice this month and your app still shows my card as cancelled. I need this fixed today, this is the third time.",
    "Customer message: How do I add a teammate to my workspace? I can't find the invite button anywhere.",
  ],
  "Lead Qualifier": [
    "Enquiry: We are a 40 person logistics company, we handle about 300 inbound messages a day and currently answer them manually. Budget approved for Q4, want a pilot next month.",
    "Enquiry: just curious what this does, no timeline yet, we are a two person shop.",
  ],
  "Meeting Notes": [
    "Notes from standup: Ana says the telegram poller is done but long polling drops under load. Raj will move the ledger writes into the worker this week. We agreed to ship the console Friday. Open on whether redis is worth it yet. Sam owns the copy review.",
    "Notes: kickoff with the client. They want intake via whatsapp and a sheet of every resolved ticket. Ana will scope two agents. Client sends branding by Thursday.",
  ],
};

const agents = await get<AgentRow[]>("/agents");
if (agents.length === 0) throw new Error("no agents in this tenant — run `pnpm db:seed` first");

let totalTokens = 0;
let runs = 0;

for (const agent of agents) {
  const prompts = PROMPTS[agent.name];
  if (!prompts) {
    console.log(`skipping "${agent.name}" — no prompt for it in this script`);
    continue;
  }
  for (const message of prompts) {
    const outcome = await post<RunOutcome>(`/agents/${agent.id}/run`, { message });
    totalTokens += outcome.tokensUsed;
    runs += 1;
    console.log(
      `${agent.name}: ${outcome.tokensUsed} tokens (in ${outcome.inputTokens} / out ${outcome.outputTokens}) in ${(outcome.durationMs / 1000).toFixed(1)}s\n  ${outcome.reply.replace(/\s+/g, " ").slice(0, 150)}`,
    );
  }
}

const overview = await get<{ tokensUsedThisCycle: number; tokensRemaining: number; messagesToday: number }>("/overview");
console.log(
  JSON.stringify(
    {
      runs,
      totalTokens,
      tokensUsedThisCycle: overview.tokensUsedThisCycle,
      tokensRemaining: overview.tokensRemaining,
      messagesToday: overview.messagesToday,
    },
    null,
    2,
  ),
);
