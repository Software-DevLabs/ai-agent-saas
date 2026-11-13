import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import Loading03Icon from "@hugeicons/core-free-icons/Loading03Icon";
import { Avatar } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/ui/badge";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/states";
import { useAgentRun } from "@/lib/queries";
import { formatDate, formatDuration, formatTokens } from "@/lib/utils";
import { OutputPanel } from "./output-panel";
import { TraceList } from "./trace-list";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-fill-subtle px-2.5 py-2 shadow-inset">
      <dt className="text-meta uppercase text-muted-foreground/60">{label}</dt>
      <dd className="mt-0.5 font-mono text-body-sm tabular text-foreground">{value}</dd>
    </div>
  );
}

/**
 * The detail of one persisted agent turn. It polls only while the run is
 * RUNNING, so an open drawer on a finished run costs nothing.
 */
export function RunDrawer({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const run = useAgentRun(runId ?? undefined);
  const data = run.data;
  const error = run.error instanceof Error ? run.error.message : run.error ? String(run.error) : null;

  return (
    <Sheet
      open={runId !== null}
      onClose={onClose}
      side="right"
      title="Agent run"
      className="w-[92vw] sm:w-[540px]"
    >
      <div className="space-y-4 p-4">
        {runId !== null && run.isPending ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-52" />
              </div>
            </div>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : null}

        {error ? (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 font-mono text-caption text-destructive shadow-inset">
            {error}
          </p>
        ) : null}

        {data ? (
          <>
            <div className="flex items-start gap-3">
              <Avatar name={data.agentName} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-subheading text-foreground">{data.agentName}</p>
                  <StatusBadge status={data.status} />
                </div>
                <p className="mt-0.5 truncate font-mono text-meta text-muted-foreground">
                  {data.id} · {data.triggerSource} · {formatDate(data.startedAt)}
                </p>
              </div>
              {data.agentId ? (
                <Link
                  to={`/agents/${data.agentId}`}
                  onClick={onClose}
                  className="shrink-0 text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Agent
                </Link>
              ) : null}
            </div>

            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Tokens" value={formatTokens(data.tokensUsed)} />
              <Stat label="Rounds" value={data.stepCount} />
              <Stat label="Tools" value={data.toolCallCount} />
              <Stat
                label="Duration"
                value={formatDuration(
                  data.durationMs ??
                    (data.status === "RUNNING"
                      ? Date.now() - new Date(data.startedAt).getTime()
                      : null),
                )}
              />
            </dl>

            <div>
              <p className="text-label text-foreground">Input</p>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-fill-subtle p-3 font-mono text-caption leading-relaxed text-muted-foreground shadow-inset">
                {data.input}
              </pre>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <p className="text-label text-foreground">Steps</p>
                {data.status === "RUNNING" ? (
                  <span className="flex items-center gap-1.5 font-mono text-meta text-info">
                    <HugeiconsIcon icon={Loading03Icon} size={11} className="animate-spin" />
                    live
                  </span>
                ) : null}
              </div>
              <div className="mt-2">
                <TraceList steps={data.steps} live={data.status === "RUNNING"} />
              </div>
            </div>

            <OutputPanel
              output={data.output}
              error={data.error}
              emptyLabel={
                data.status === "RUNNING"
                  ? "The reply is written when the turn finishes."
                  : "No output was recorded."
              }
            />

            {data.conversationId || data.externalChatId ? (
              <p className="font-mono text-meta text-muted-foreground">
                thread {data.conversationId ?? data.externalChatId}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
