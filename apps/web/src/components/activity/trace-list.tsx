import { HugeiconsIcon } from "@hugeicons/react";
import Loading03Icon from "@hugeicons/core-free-icons/Loading03Icon";
import type { AgentRunStep, AgentTraceStep } from "@/lib/domain";
import { formatDuration, formatTokens } from "@/lib/utils";
import { ToolStepCard } from "./tool-step-card";

/**
 * The turn's execution trace. `steps` is the persisted per-round record from an
 * `AgentRun`; `trace` is the tool-only list carried on a live HTTP outcome.
 */
export function TraceList({
  steps,
  trace,
  live = false,
}: {
  steps?: AgentRunStep[];
  trace?: AgentTraceStep[];
  live?: boolean;
}) {
  if (steps) {
    if (steps.length === 0) {
      return (
        <p className="text-caption text-muted-foreground">
          {live ? "Waiting for the first model round…" : "No steps were recorded for this run."}
        </p>
      );
    }
    return (
      <ol className="space-y-2">
        {steps.map((step) =>
          step.kind === "MODEL" ? (
            <li
              key={step.id}
              className="flex items-center gap-2 rounded-lg bg-fill-subtle px-3 py-1.5 shadow-inset"
            >
              <span className="rounded bg-fill px-1 font-mono text-meta text-muted-foreground">
                R{step.round}
              </span>
              <span className="text-caption text-foreground">Model round</span>
              <span className="ml-auto font-mono text-meta tabular text-muted-foreground">
                {formatTokens(step.inputTokens)} in · {formatTokens(step.outputTokens)} out ·{" "}
                {formatDuration(step.durationMs)}
              </span>
            </li>
          ) : (
            <li key={step.id}>
              <ToolStepCard
                step={{
                  tool: step.tool ?? "tool",
                  argsPreview: step.argsPreview,
                  resultPreview: step.resultPreview,
                  ok: step.ok ?? false,
                  durationMs: step.durationMs,
                }}
              />
            </li>
          ),
        )}
        {live ? (
          <li className="flex items-center gap-2 px-3 py-1.5 text-caption text-muted-foreground">
            <HugeiconsIcon icon={Loading03Icon} size={12} className="animate-spin" />
            Working — the next round lands here.
          </li>
        ) : null}
      </ol>
    );
  }

  const rows = trace ?? [];
  if (rows.length === 0) {
    return <p className="text-caption text-muted-foreground">This turn called no tools.</p>;
  }
  return (
    <ol className="space-y-2">
      {rows.map((step) => (
        <li key={`${step.index}-${step.tool}`}>
          <ToolStepCard
            step={{
              tool: step.tool,
              argsPreview: step.argsPreview,
              resultPreview: step.resultPreview,
              ok: step.ok,
              durationMs: step.durationMs,
            }}
          />
        </li>
      ))}
    </ol>
  );
}
