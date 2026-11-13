import type { PrismaClient } from "@prisma/client";
import { tenantWhere } from "@saas/db";
import { SENTIMENTS, type Sentiment } from "@saas/core";
import { requireEmbed } from "./embeds.ts";

/**
 * What visitors asked, and how they felt asking it.
 *
 * This reads `EmbedFeedback` — rows the worker wrote from a model's own label —
 * and nothing else. No score is computed here, no sentiment is inferred from a
 * message the classifier never saw: an unanswered question simply has no row yet,
 * and a row that says UNKNOWN says why in `source`.
 *
 * Scope is always the project or the widget the caller resolved first; the
 * feedback query is narrowed by the embed ids that belong to it, so a row from
 * another widget in the same tenant cannot be counted by mistake.
 */

export interface FeedbackDto {
  id: string;
  embedId: string;
  embedName: string;
  messageId: string;
  question: string;
  answer: string | null;
  sentiment: Sentiment;
  score: number | null;
  source: string;
  model: string | null;
  error: string | null;
  tokensUsed: number;
  createdAt: string;
}

export type SentimentTotals = Record<Sentiment, number> & { total: number };

export interface InsightsView {
  scope: "project" | "embed";
  scopeId: string;
  /** Widgets whose feedback is counted. One for the widget view. */
  embedCount: number;
  totals: SentimentTotals;
  feedback: FeedbackDto[];
}

export interface InsightsOptions {
  limit: number;
  /** A filter on the listed rows *and* on nothing else — totals always count every row. */
  sentiment?: Sentiment;
}

type FeedbackRow = {
  id: string;
  embedId: string;
  messageId: string;
  question: string;
  answer: string | null;
  sentiment: string;
  score: number | null;
  source: string;
  model: string | null;
  error: string | null;
  tokensUsed: number;
  createdAt: Date;
};

const feedbackSelect = {
  id: true,
  embedId: true,
  messageId: true,
  question: true,
  answer: true,
  sentiment: true,
  score: true,
  source: true,
  model: true,
  error: true,
  tokensUsed: true,
  createdAt: true,
} as const;

function toDto(row: FeedbackRow, embedName: string): FeedbackDto {
  return {
    id: row.id,
    embedId: row.embedId,
    embedName,
    messageId: row.messageId,
    question: row.question,
    answer: row.answer,
    sentiment: row.sentiment as Sentiment,
    score: row.score,
    source: row.source,
    model: row.model,
    error: row.error,
    tokensUsed: row.tokensUsed,
    createdAt: row.createdAt.toISOString(),
  };
}

async function readInsights(
  db: PrismaClient,
  tenantId: string,
  scope: "project" | "embed",
  scopeId: string,
  embeds: Array<{ id: string; name: string }>,
  options: InsightsOptions,
): Promise<InsightsView> {
  const empty: SentimentTotals = { POSITIVE: 0, NEUTRAL: 0, NEGATIVE: 0, UNKNOWN: 0, total: 0 };
  if (embeds.length === 0) {
    return { scope, scopeId, embedCount: 0, totals: empty, feedback: [] };
  }

  const embedId = { in: embeds.map((row) => row.id) };
  const [total, ...perSentiment] = await Promise.all([
    db.embedFeedback.count({ where: tenantWhere(tenantId, { embedId }) }),
    ...SENTIMENTS.map((sentiment) =>
      db.embedFeedback.count({ where: tenantWhere(tenantId, { embedId, sentiment }) }),
    ),
  ]);
  const totals = { ...empty, total };
  SENTIMENTS.forEach((sentiment, index) => {
    totals[sentiment] = perSentiment[index] ?? 0;
  });

  const rows = (await db.embedFeedback.findMany({
    where: tenantWhere(tenantId, { embedId, ...(options.sentiment === undefined ? {} : { sentiment: options.sentiment }) }),
    orderBy: { createdAt: "desc" },
    take: options.limit,
    select: feedbackSelect,
  })) as unknown as FeedbackRow[];
  const names = new Map(embeds.map((row) => [row.id, row.name]));

  return {
    scope,
    scopeId,
    embedCount: embeds.length,
    totals,
    feedback: rows.map((row) => toDto(row, names.get(row.embedId) ?? row.embedId)),
  };
}

export async function projectInsights(
  db: PrismaClient,
  tenantId: string,
  projectId: string,
  options: InsightsOptions,
): Promise<InsightsView> {
  const embeds = await db.embed.findMany({
    where: tenantWhere(tenantId, { projectId }),
    select: { id: true, name: true },
  });
  return readInsights(db, tenantId, "project", projectId, embeds, options);
}

export async function embedInsights(
  db: PrismaClient,
  tenantId: string,
  embedId: string,
  options: InsightsOptions,
): Promise<InsightsView> {
  const embed = await requireEmbed(db, tenantId, embedId);
  return readInsights(db, tenantId, "embed", embed.id, [{ id: embed.id, name: embed.name }], options);
}
