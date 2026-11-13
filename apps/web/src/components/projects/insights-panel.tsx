import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import ChatIcon from "@hugeicons/core-free-icons/ChatIcon";
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";
import { Badge, type Tone } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { EmptyState, QueryState } from "@/components/ui/states";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { useProjectInsights } from "@/lib/queries";
import type { FeedbackRow, Sentiment } from "@/lib/domain";
import { formatDate, formatTokens } from "@/lib/utils";

/**
 * The Insights tab: what visitors asked the widgets in this project, and the label
 * a model gave each question.
 *
 * Every number here comes from `EmbedFeedback` rows the worker wrote — there is no
 * keyword counting and no local tone heuristic. A row whose `source` is not `model`
 * says UNKNOWN and names the reason (`unparseable`, `provider_failed`,
 * `balance_exhausted`), and it is rendered as "not classified" rather than as a
 * feeling, because a failed call is not evidence of a mood. The footer says what
 * the listening costs: one CLASSIFY ledger row per question, tokens from the
 * provider's own usage payload.
 */

const SENTIMENTS: Sentiment[] = ["POSITIVE", "NEUTRAL", "NEGATIVE", "UNKNOWN"];

const TONE: Record<Sentiment, Tone> = {
  POSITIVE: "success",
  NEUTRAL: "neutral",
  NEGATIVE: "danger",
  UNKNOWN: "warning",
};

const LABEL: Record<Sentiment, string> = {
  POSITIVE: "Positive",
  NEUTRAL: "Neutral",
  NEGATIVE: "Negative",
  UNKNOWN: "Unknown",
};

function SentimentBadge({ row }: { row: FeedbackRow }) {
  if (row.source !== "model") {
    return <Badge tone="neutral">not classified</Badge>;
  }
  return <Badge tone={TONE[row.sentiment]}>{LABEL[row.sentiment]}</Badge>;
}

function QuestionRow({ row }: { row: FeedbackRow }) {
  return (
    <TR className="align-top">
      <TD className="whitespace-nowrap text-[12px] text-muted-foreground">{formatDate(row.createdAt)}</TD>
      <TD className="max-w-[340px]">
        <p className="text-[12.5px] leading-relaxed">{row.question}</p>
        {row.answer !== null && (
          <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">{row.answer}</p>
        )}
      </TD>
      <TD>
        <SentimentBadge row={row} />
        {row.source !== "model" && (
          <p className="mt-1 max-w-[220px] font-mono text-[10.5px] leading-relaxed text-muted-foreground">
            {row.source}
            {row.error ? ` · ${row.error}` : ""}
          </p>
        )}
      </TD>
      <TD className="whitespace-nowrap font-mono text-[11.5px] tabular text-muted-foreground">
        {row.score === null ? "—" : row.score.toFixed(2)}
      </TD>
      <TD className="whitespace-nowrap text-[11.5px] text-muted-foreground">{row.embedName}</TD>
      <TD className="text-right font-mono text-[11.5px] tabular text-muted-foreground">{formatTokens(row.tokensUsed)}</TD>
    </TR>
  );
}

export function InsightsPanel({ projectId }: { projectId: string }) {
  const [filter, setFilter] = useState<Sentiment | "ALL">("ALL");
  const insights = useProjectInsights(projectId, filter);
  const totals = insights.data?.totals;
  const rows = insights.data?.feedback ?? [];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {SENTIMENTS.map((sentiment) => (
          <div key={sentiment} className="rounded-xl border border-border bg-card px-4 py-3 shadow-card">
            <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  sentiment === "POSITIVE"
                    ? "bg-success"
                    : sentiment === "NEGATIVE"
                      ? "bg-destructive"
                      : sentiment === "UNKNOWN"
                        ? "bg-warning"
                        : "bg-muted-foreground"
                }`}
              />
              {LABEL[sentiment]}
            </p>
            <p className="mt-1.5 font-mono text-[20px] tabular leading-none">{totals?.[sentiment] ?? 0}</p>
          </div>
        ))}
        <div className="rounded-xl border border-border bg-card px-4 py-3 shadow-card">
          <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <HugeiconsIcon icon={ChatIcon} size={12} strokeWidth={1.7} />
            Questions
          </p>
          <p className="mt-1.5 font-mono text-[20px] tabular leading-none">{totals?.total ?? 0}</p>
          <p className="mt-1 text-[10.5px] text-muted-foreground">
            across {insights.data?.embedCount ?? 0} widget{(insights.data?.embedCount ?? 0) === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Recent questions</CardTitle>
            <CardDescription>
              Each row is a public message and the label the classifier gave it. “Not classified” means the model was
              not reached or its reply could not be read — the reason is shown, and no feeling is invented.
            </CardDescription>
          </div>
          <Select
            aria-label="Filter by sentiment"
            value={filter}
            onChange={(event) => setFilter(event.target.value as Sentiment | "ALL")}
            className="h-8 w-44 text-[12px]"
          >
            <option value="ALL">All sentiments</option>
            {SENTIMENTS.map((sentiment) => (
              <option key={sentiment} value={sentiment}>
                {LABEL[sentiment]}
              </option>
            ))}
          </Select>
        </CardHeader>
        <CardContent className="p-0">
          <QueryState error={insights.error} pending={insights.isPending}>
            {(totals?.total ?? 0) === 0 ? (
              <EmptyState
                title="No questions yet"
                body="Feedback appears here after a visitor sends a message through one of this project's widgets. The label is the classifier's own judgement, recorded after the answer was delivered."
              />
            ) : rows.length === 0 ? (
              <EmptyState
                title="Nothing matches this filter"
                body={`The project has ${totals?.total ?? 0} classified question(s), but none with this sentiment. The counters above always show every label, not just the visible rows.`}
              />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>When</TH>
                    <TH>Question</TH>
                    <TH>Feeling</TH>
                    <TH>Score</TH>
                    <TH>Widget</TH>
                    <TH className="text-right">Tokens</TH>
                  </TR>
                </THead>
                <tbody>
                  {rows.map((row) => (
                    <QuestionRow key={row.id} row={row} />
                  ))}
                </tbody>
              </Table>
            )}
          </QueryState>
        </CardContent>
      </Card>

      <p className="flex items-start gap-1.5 px-1 text-[11px] leading-relaxed text-muted-foreground">
        <HugeiconsIcon icon={InformationCircleIcon} size={12} strokeWidth={1.7} className="mt-0.5 shrink-0" />
        Sentiment is a model call of its own, queued after each widget answer on the feedback.classify lane. Its tokens
        are on the ledger as CLASSIFY rows, so the cost of listening is visible and attributable.
      </p>
    </div>
  );
}
