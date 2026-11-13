import { loadConfigFromEnv } from "@saas/shared";
import { makeDb } from "./client.ts";
import { defaultProjectId } from "./filter.ts";

/**
 * Seeds the two launch plans, a demo tenant with one owner and one default
 * project, and the three agents the console is useless without. Idempotent:
 * run it twice and the rows end up in the same state.
 *
 * No credentials and no activity are seeded here. A connection is something a
 * user typed a real bot token into, and usage is something a real model run
 * produced — inventing either would put fiction in the database, not just the
 * UI. `pnpm activity` generates the latter through the actual API.
 */

const DEMO_EMAIL = "demo@agentsaas.local";

interface DemoAgent {
  name: string;
  systemPrompt: string;
  temperature: number;
  maxOutputTokens: number;
}

const DEMO_AGENTS: DemoAgent[] = [
  {
    name: "Support Triage",
    systemPrompt:
      "You triage inbound customer support messages. Classify the issue as billing, technical, or account, state the severity from 1 to 3, and give one next action for the agent handling it. Keep the whole reply under 60 words.",
    temperature: 0.2,
    maxOutputTokens: 400,
  },
  {
    name: "Lead Qualifier",
    systemPrompt:
      "You read an inbound sales enquiry and decide whether it is worth a human call. Report: company size signal, stated need, budget signal, and a verdict of hot, warm or cold. Be blunt and stay under 60 words.",
    temperature: 0.4,
    maxOutputTokens: 400,
  },
  {
    name: "Meeting Notes",
    systemPrompt:
      "You turn rough meeting notes into a summary with three sections: decisions, action items with owners, and open questions. Never invent an owner that is not in the notes.",
    temperature: 0.3,
    maxOutputTokens: 600,
  },
];

async function main() {
  const config = loadConfigFromEnv();
  const db = makeDb(config);
  try {
    const free = await db.plan.upsert({
      where: { name: "Free" },
      update: { tokenQuota: 500_000n, maxIntegrations: 2 },
      create: { name: "Free", monthlyPriceUsd: 0, tokenQuota: 500_000n, maxIntegrations: 2 },
    });
    const pro = await db.plan.upsert({
      where: { name: "Pro" },
      update: { tokenQuota: 5_000_000n, maxIntegrations: 10 },
      create: { name: "Pro", monthlyPriceUsd: 19, tokenQuota: 5_000_000n, maxIntegrations: 10 },
    });

    const existing = await db.user.findFirst({
      where: { email: DEMO_EMAIL },
      select: { tenantId: true, tenant: { select: { name: true } } },
    });

    let tenantId: string;
    if (existing) {
      tenantId = existing.tenantId;
      console.log(`demo tenant already present (${tenantId})`);
    } else {
      const cycleResetAt = new Date();
      cycleResetAt.setUTCMonth(cycleResetAt.getUTCMonth() + 1, 1);
      const tenant = await db.tenant.create({
        data: { name: "Demo Tenant", planId: free.id, tokenBalance: free.tokenQuota, cycleResetAt },
      });
      await db.user.create({ data: { tenantId: tenant.id, email: DEMO_EMAIL, role: "OWNER" } });
      tenantId = tenant.id;
      console.log(`seeded demo tenant ${tenant.id} on plan Free`);
    }

    // Mirrors the migration's backfill exactly: one default project per tenant,
    // deterministic id, and existing agents are never re-parented.
    const projectId = defaultProjectId(tenantId);
    await db.project.upsert({
      where: { id: projectId },
      update: {},
      create: { id: projectId, tenantId, name: "Default", isDefault: true },
    });

    for (const agent of DEMO_AGENTS) {
      const present = await db.agent.findFirst({ where: { tenantId, name: agent.name }, select: { id: true } });
      if (present) {
        console.log(`agent "${agent.name}" already exists (${present.id})`);
        continue;
      }
      const created = await db.agent.create({
        data: {
          tenantId,
          projectId,
          // Explicit, not the column default: the demo agents exist to be run,
          // and DRAFT would refuse them on any public surface.
          status: "ACTIVE",
          name: agent.name,
          systemPrompt: agent.systemPrompt,
          modelProvider: "ollama",
          modelName: config.OLLAMA_MODEL,
          temperature: agent.temperature,
          maxOutputTokens: agent.maxOutputTokens,
        },
        select: { id: true },
      });
      console.log(`seeded agent "${agent.name}" (${created.id}) on ollama/${config.OLLAMA_MODEL}`);
    }

    console.log(`plans: ${free.name} (${free.tokenQuota} tokens), ${pro.name} (${pro.tokenQuota} tokens)`);
    console.log(`project "${projectId}" owns ${await db.agent.count({ where: { tenantId, projectId } })} agents`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
