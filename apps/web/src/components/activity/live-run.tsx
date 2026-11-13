import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import Loading03Icon from "@hugeicons/core-free-icons/Loading03Icon";
import type { RunOutcome } from "@/lib/domain";
import { Button } from "@/components/ui/button";
import { useAgentRun, useAgentRuns } from "@/lib/queries";
import { formatDuration, formatTokens } from "@/lib/utils";
import { RunDrawer } from "./run-drawer";
import { TraceList } from "./trace-list";

function lastNote(kind: string | undefined, tool: string | null, round: number | undefined): string {
  if (kind === "TOOL") return `calling ${tool ?? "a tool"}`;
  if (kind === "MODEL") return `round ${round ?? "?"} answered`;
  return "starting the turn";
}

/**
 * The in-flight turn. The run row is created by the API as the turn starts, so
 * the console can show real progress (rounds, tools, tokens) while the HTTP
 * request is still open — no invented spinner.
 */
export function LiveRun({ agentId }: { agentId: string }) {
  const runs = useAgentRuns({ agentId, limit: 1 });
  const live = runs.data?.[0];
  const running = live?.status === "RUNNING" ? live : null;
  const detail = useAgentRun(running?.id);
  const steps = detail.data?.steps ?? [];
  const last = steps[steps.length - 1];

  return (
    <div className="flex gap-2.5">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-fill text-muted-foreground shadow-inset">
        <HugeiconsIcon icon={Loading03Icon} size={12} strokeWidth={1.6} className="animate-spin" />
      </span>
      <div className="max-w-[76%] space-y-1 rounded-xl bg-fill-subtle px-3.5 py-2.5 shadow-inset">
        <p className="text-body-sm text-foreground">
          {running ? lastNote(last?.kind, last?.tool ?? null, last?.round) : "working on it…"}
        </p>
        {running ? (
          <p className="font-mono text-meta tabular text-muted-foreground">
            {running.stepCount} rounds · {running.toolCallCount} tools · {formatTokens(running.tokensUsed)} tok ·{" "}
            {formatDuration(Math.max(0, Date.now() - new Date(running.startedAt).getTime()))}
          </p>
        ) : (
          <p className="font-mono text-meta text-muted-foreground">the run row has not appeared yet</p>
        )}
      </div>
    </div>
  );
}

/** What the last answered turn actually did — rounds, tool calls, cost. */
export function LastRunCard({ outcome }: { outcome: RunOutcome }) {
  const [openRun, setOpenRun] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <dl className="space-y-2 text-[12.5px]">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Model rounds</dt>
          <dd className="font-mono tabular">{outcome.steps}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Tool calls</dt>
          <dd className="font-mono tabular">{outcome.trace.length}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Tokens</dt>
          <dd className="font-mono tabular">
            {formatTokens(outcome.inputTokens)} in · {formatTokens(outcome.outputTokens)} out
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Latency</dt>
          <dd className="font-mono tabular">{formatDuration(outcome.durationMs)}</dd>
        </div>
      </dl>
      <TraceList trace={outcome.trace} />
      {outcome.agentRunId ? (
        <Button variant="outline" size="sm" className="w-full" onClick={() => setOpenRun(outcome.agentRunId)}>
          Open persisted run
        </Button>
      ) : (
        <p className="text-caption text-muted-foreground">
          This turn has no activity row — the API could not start one, so only the reply was recorded.
        </p>
      )}
      <RunDrawer runId={openRun} onClose={() => setOpenRun(null)} />
    </div>
  );
}
