import { Link } from "react-router-dom";
import { EmptyState, QueryState } from "@/components/ui/states";
import { StatusDot } from "@/components/ui/status-dot";
import { THead, TR, Table, TD, TH } from "@/components/ui/table";
import { useWorkflowRunsTenant } from "@/lib/queries";
import { formatDate, formatDuration, formatTokens } from "@/lib/utils";
import { activityTone, isLiveStatus } from "./tone";

/**
 * Every workflow run in the tenant, newest first. A row links to the canvas that
 * owns it only when that workflow still exists — a deleted graph has no board to
 * open, and the run's own name snapshot stays on screen either way.
 */
export function WorkflowRunsTable({ limit = 40 }: { limit?: number }) {
  const runs = useWorkflowRunsTenant({ limit });
  const rows = runs.data ?? [];

  return (
    <QueryState
      error={runs.error}
      pending={runs.isPending}
      isEmpty={rows.length === 0}
      empty={
        <EmptyState
          title="No workflow runs yet"
          body="Start a run from an ACTIVE graph, or let a channel message reach a workflow trigger."
        />
      }
    >
      <Table>
        <THead>
          <TR>
            <TH className="w-8"> </TH>
            <TH>Workflow</TH>
            <TH className="hidden md:table-cell">Trigger</TH>
            <TH>Input</TH>
            <TH className="hidden sm:table-cell">Tokens</TH>
            <TH className="hidden lg:table-cell">Duration</TH>
            <TH>Started</TH>
          </TR>
        </THead>
        <tbody>
          {rows.map((run) => {
            const live = isLiveStatus(run.status);
            return (
              <TR key={run.id}>
                <TD>
                  <StatusDot tone={activityTone(run.status)} pulse={live} />
                </TD>
                <TD>
                  {run.projectId ? (
                    <Link
                      to={`/projects/${run.projectId}/workflows/${run.workflowId}`}
                      className="max-w-[180px] truncate text-body-sm hover:underline"
                    >
                      {run.workflowName ?? run.workflowId}
                    </Link>
                  ) : (
                    <span className="max-w-[180px] truncate text-body-sm text-muted-foreground">
                      {run.workflowName ?? "deleted workflow"}
                    </span>
                  )}
                </TD>
                <TD className="hidden md:table-cell">
                  <span className="font-mono text-meta text-muted-foreground">{run.triggerSource}</span>
                </TD>
                <TD>
                  <span className="block max-w-[280px] truncate text-body-sm text-muted-foreground">{run.input}</span>
                </TD>
                <TD className="hidden font-mono tabular text-body-sm sm:table-cell">
                  {formatTokens(run.tokensUsed)}
                </TD>
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
  );
}
