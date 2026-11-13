import type { PrismaClient } from "@prisma/client";
import { createAgentRunObserver, prepareAgentTurn, runAgentTurn } from "@saas/core";
import type { AgentTurnInput, AgentTurnOutcome } from "@saas/core";
import { resolveProvider } from "@saas/providers";
import type { ProviderConfig } from "@saas/providers";
import { makeQueryEmbedder } from "./embedding.ts";

/**
 * The console's door into the one agent turn `@saas/core` owns.
 *
 * This file exists so `POST /agents/:id/run` and the playground keep their exact
 * call signature while the worker — which cannot import from the API — runs the
 * identical sequence. Two implementations of provider + ledger + quota is how a
 * graph run starts costing something different from a playground message.
 *
 * The assembly happens here, before the turn, so an agent that cannot be assembled
 * (a prompt over budget, a core skill missing on a public surface) answers with a
 * refusal instead of a billed round that would have run on a prompt nobody judged.
 */

export type RunInput = AgentTurnInput;
export type RunOutcome = AgentTurnOutcome & {
  /** The activity row this turn wrote, or null when the observer could not start one. */
  agentRunId: string | null;
};

export interface RunSurface {
  /** A public surface refuses a draft agent and an unusable core skill. */
  publicSurface?: boolean;
}

export async function runAgent(
  db: PrismaClient,
  tenantId: string,
  agentId: string,
  input: RunInput,
  providerConfig: ProviderConfig,
  surface: RunSurface = {},
): Promise<RunOutcome> {
  const publicSurface = surface.publicSurface ?? false;
  const assembly = await prepareAgentTurn(db, tenantId, agentId, {
    publicSurface,
    embedQuery: makeQueryEmbedder(providerConfig),
  });
  const store = createAgentRunObserver(db, tenantId);
  let agentRunId: string | null = null;
  const outcome = await runAgentTurn(
    db,
    tenantId,
    agentId,
    {
      ...input,
      assembly,
      requireActive: input.requireActive ?? publicSurface,
      triggerSource: input.triggerSource ?? "playground",
    },
    (selection) =>
      resolveProvider(selection.provider, { config: { ...providerConfig, ollamaModel: selection.model } }),
    {
      ...store,
      start: async (info) => {
        agentRunId = await store.start(info);
        return agentRunId;
      },
    },
  );
  return { ...outcome, agentRunId };
}
