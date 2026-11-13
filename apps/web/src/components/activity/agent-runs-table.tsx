import { useState } from "react";
import { EmptyState, QueryState } from "@/components/ui/states";
import { StatusDot } from "@/components/ui/status-dot";
import { THead, TR, Table, TD, TH } from "@/components/ui/table";
import { useAgentRuns } from "@/lib/queries";
import { formatDate, formatDuration, formatTokens } from "@/lib/utils";
import { activityTone, isLiveStatus } from "./tone";
import { RunDrawer } from "./run-drawer";

/**
 * Every persisted direct turn, newest first. Clicking a row opens the drawer
 * with the rounds and tool calls that turn recorded.
 */
export function AgentRunsTable({ limit = 40 }: { limit?: number }) {
  const runs = useAgentRuns({ limit });
  const [openRun, setOpenRun] = useState<string | null>(null);
  const rows = runs.data ?? [];

  return (
    <>
      <QueryState
        error={runs.error}
        pending={runs.isPending}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            title="No agent runs yet"
            body="A playground message or a channel reply writes an AgentRun row the moment the turn starts."
          />
        }
      >
        <Table>
          <THead>
            <TR>
              <TH className="w-8"> </TH>
              <TH>Agent</TH>
              <TH className="hidden md:table-cell">Source</TH>
              <TH>Input</TH>
              <TH className="hidden sm:table-cell">Tokens</TH>
              <TH className="hidden sm:table-cell">Rounds</TH>
              <TH className="hidden lg:table-cell">Tools</TH>
              <TH className="hidden lg:table-cell">Duration</TH>
              <TH>Started</TH>
            </TR>
          </THead>
          <tbody>
            {rows.map((run) => {
              const live = isLiveStatus(run.status);
              return (
                <TR
                  key={run.id}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open run ${run.id}`}
                  onClick={() => setOpenRun(run.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setOpenRun(run.id);
                    }
                  }}
                  className="cursor-pointer outline-none"
                >
                  <TD>
                    <StatusDot tone={activityTone(run.status)} pulse={live} />
                  </TD>
                  <TD>
                    <span className="max-w-[160px] truncate text-body-sm">{run.agentName}</span>
                  </TD>
                  <TD className="hidden md:table-cell">
                    <span className="font-mono text-meta text-muted-foreground">{run.triggerSource}</span>
                  </TD>
                  <TD>
                    <span className="block max-w-[280px] truncate text-body-sm text-muted-foreground">
                      {run.input}
                    </span>
                  </TD>
                  <TD className="hidden font-mono tabular text-body-sm sm:table-cell">
                    {formatTokens(run.tokensUsed)}
                  </TD>
                  <TD className="hidden font-mono tabular text-body-sm sm:table-cell">{run.stepCount}</TD>
                  <TD className="hidden font-mono tabular text-body-sm lg:table-cell">{run.toolCallCount}</TD>
                  <TD className="hidden font-mono tabular text-body-sm lg:table-cell">
                    {formatDuration(
                      run.durationMs ??
                        (live ? Math.max(0, Date.now() - new Date(run.startedAt).getTime()) : null),
                    )}
                  </TD>
                  <TD>
                    <span className="whitespace-nowrap font-mono text-meta text-muted-foreground">
                      {formatDate(run.startedAt)}
                    </span>
                  </TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      </QueryState>
      <RunDrawer runId={openRun} onClose={() => setOpenRun(null)} />
    </>
  );
}
