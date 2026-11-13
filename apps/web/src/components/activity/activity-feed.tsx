import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ActivityItem } from "@/lib/domain";
import { EmptyState, QueryState } from "@/components/ui/states";
import { useActivity } from "@/lib/queries";
import { ActivityLine } from "./activity-line";
import { RunDrawer } from "./run-drawer";

/**
 * The merged feed of direct turns and workflow agent nodes. A direct row opens
 * the run drawer; a node row navigates to the canvas that owns it, because the
 * node's full context is the run it belongs to.
 */
export function ActivityFeed({
  agentId,
  limit = 12,
  emptyBody = "A turn from the playground, a channel message or a workflow node writes a row here.",
}: {
  agentId?: string;
  limit?: number;
  emptyBody?: string;
}) {
  const activity = useActivity(agentId ? { agentId, limit } : { limit });
  const [openRun, setOpenRun] = useState<string | null>(null);
  const navigate = useNavigate();

  const rows = activity.data ?? [];

  const open = (item: ActivityItem) => {
    if (item.source === "AGENT_RUN") return () => setOpenRun(item.id);
    if (item.projectId && item.workflowId) {
      return () => navigate(`/projects/${item.projectId}/workflows/${item.workflowId}`);
    }
    return undefined;
  };

  return (
    <>
      <QueryState
        error={activity.error}
        pending={activity.isPending}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            title={agentId ? "This agent has not run yet" : "No agent activity yet"}
            body={emptyBody}
          />
        }
      >
        <ul className="divide-y divide-border">
          {rows.map((item) => (
            <li key={`${item.source}-${item.id}`}>
              <ActivityLine item={item} onOpen={open(item)} />
            </li>
          ))}
        </ul>
      </QueryState>
      <RunDrawer runId={openRun} onClose={() => setOpenRun(null)} />
    </>
  );
}
