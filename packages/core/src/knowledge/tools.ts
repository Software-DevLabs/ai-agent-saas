import type { PrismaClient } from "@prisma/client";
import type { AgentTool } from "../agent-run.ts";
import type { TurnRecord, ToolSpec } from "../capability/registry.ts";
import type { ToolContext } from "../capability/registry.ts";
import { searchKnowledge, type QueryEmbedder, type SearchHit, type VectorQuery } from "./search.ts";

/**
 * The `knowledge_search` tool — the only way an agent reads the documents it was
 * given.
 *
 * What makes this a capability rather than a helper function is that the scope
 * comes from the assembly, not from the model: the arguments are a question and a
 * count, never a document id. A model that can name its own sources is a model that
 * can be told to read somebody else's, so the document list is fixed when the turn
 * is built and the query runs against nothing else.
 */

/** Bound on what one search can add to the prompt, in characters across all hits. */
export const MAX_TOOL_RESULT_CHARS = 6_000;

const PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "The question or the words to look for, in the document's own language.",
    },
    limit: { type: "integer", minimum: 1, maximum: 12, description: "How many passages to return. Default 5." },
  },
  required: ["query"],
};

export function formatHits(query: string, hits: SearchHit[], backend: string): string {
  if (hits.length === 0) {
    return `NO_MATCHES: nothing in this agent's documents answers "${query}". Say what you do not have and what would settle it — do not invent an answer.`;
  }
  const lines: string[] = [
    `${backend.toUpperCase()} retrieval — ${hits.length} passage(s) for "${query}". Answer only from what follows; the bracketed title is the source.`,
    "",
  ];
  let used = 0;
  for (const [index, hit] of hits.entries()) {
    const block = `[${index + 1}] "${hit.title}" · chunk ${hit.seq + 1} of ${hit.docId} (score ${hit.score.toFixed(3)})\n${hit.text}`;
    if (used + block.length > MAX_TOOL_RESULT_CHARS) {
      lines.push(`… ${(hits.length - index).toString()} further passage(s) left out of the token budget.`);
      break;
    }
    used += block.length;
    lines.push(block, "");
  }
  return lines.join("\n").trim();
}

/** The tool body, split out so a test can hand it a fake client and a known scope. */
export function buildKnowledgeSearchTool(
  db: PrismaClient,
  tenantId: string,
  docIds: string[],
  titles: string[],
  embed?: QueryEmbedder,
  record?: TurnRecord,
): AgentTool {
  const scope = { tenantId, docIds };
  return {
    name: "knowledge_search",
    description:
      `Search this agent's own knowledge base — the ${docIds.length} document(s) it was given${
        titles.length > 0 ? ` (${titles.slice(0, 6).join(", ")}${titles.length > 6 ? ", …" : ""})` : ""
      }. Use it before answering anything about a fact, a policy, a price or a page: it is the only place those details live.`,
    parameters: PARAMETERS,
    execute: async (values) => {
      const query = typeof values.query === "string" ? values.query.trim() : "";
      if (query === "") return 'TOOL_ERROR: "query" is required and must not be blank.';
      const limit = typeof values.limit === "number" && Number.isFinite(values.limit) ? Math.trunc(values.limit) : undefined;
      const vector = await bestEffortVector(embed, query);
      const found = await searchKnowledge(db, { ...scope, ...(limit === undefined ? {} : { limit }) }, query, vector);
      // The passages that were actually returned are the sources; a citation for a
      // document the search did not surface would be an invented one.
      record?.citations?.(
        found.hits.map((hit) => ({
          docId: hit.docId,
          title: hit.title,
          chunkId: hit.chunkId,
          ...(hit.pageUrl === undefined ? {} : { url: hit.pageUrl }),
        })),
      );
      return formatHits(query, found.hits, found.backend);
    },
  };
}

/**
 * A daemon that is down, or a model that is not pulled, is a reason to answer from
 * the keyword index — not a reason to fail a turn the model can still complete. The
 * engine that answered travels in the result, so the fallback is visible rather
 * than silent.
 */
async function bestEffortVector(embed: QueryEmbedder | undefined, query: string): Promise<VectorQuery | undefined> {
  if (embed === undefined) return undefined;
  try {
    return (await embed(query)) ?? undefined;
  } catch {
    return undefined;
  }
}

export const knowledgeSearchSpec: ToolSpec = {
  key: "knowledge_search",
  label: "Search its documents",
  summary:
    "Full-text search over the knowledge sources this agent has been given. The document list is decided when the turn is assembled, so the model can ask for words but never for files.",
  effect: "read",
  requires: ["knowledge"],
  parameters: PARAMETERS,
  build(ctx, unmet) {
    const docIds = ctx.knowledge.docIds;
    if (docIds.length === 0) {
      unmet("no indexed knowledge source is granted to this agent, so there is nothing to search");
      return null;
    }
    return buildKnowledgeSearchTool(ctx.db, ctx.tenantId, docIds, ctx.knowledge.titles, ctx.embed, ctx.record);
  },
};
