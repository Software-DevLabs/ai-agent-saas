import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import ArrowRight02Icon from "@hugeicons/core-free-icons/ArrowRight02Icon";
import type { ActivityItem } from "@/lib/domain";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StatusDot } from "@/components/ui/status-dot";
import { useActivity, useAgentRun } from "@/lib/queries";
import { ActivityLine } from "./activity-line";
import { RunDrawer } from "./run-drawer";
import { isLiveStatus } from "./tone";

/**
 * A running row reads its own step list so the board can say what the agent is
 * doing right now, not merely that it is busy. Finished rows do not poll.
 */
function LiveRow({ item, onOpen }: { item: ActivityItem; onOpen?: () => void }) {
  const live = isLiveStatus(item.status);
  const detail = useAgentRun(live && item.source === "AGENT_RUN" ? item.id : undefined);
  const steps = detail.data?.steps ?? [];
  const last = steps[steps.length - 1];
  const note = live
    ? item.source !== "AGENT_RUN"
      ? "running"
      : last
        ? last.kind === "TOOL"
          ? `calling ${last.tool}`
          : `round ${last.round} answered`
        : "starting the turn"
    : null;

  return <ActivityLine item={item} note={note} onOpen={onOpen} dense />;
}

/**
 * The live board on Overview: which agents are working, what the current step
 * is, and what the most recent finished turns produced.
 */
export function LiveAgentsStrip() {
  const activity = useActivity({ limit: 8 });
  const [openRun, setOpenRun] = useState<string | null>(null);
  const navigate = useNavigate();

  const rows = activity.data ?? [];
  const running = rows.filter((row) => isLiveStatus(row.status));
  const finished = rows.filter((row) => !isLiveStatus(row.status));
  const shown = running.length > 0 ? [...running, ...finished.slice(0, 2)] : finished.slice(0, 5);

  const open = (item: ActivityItem) => {
    if (item.source === "AGENT_RUN") return () => setOpenRun(item.id);
    if (item.projectId && item.workflowId) {
      return () => navigate(`/projects/${item.projectId}/workflows/${item.workflowId}`);
    }
    return undefined;
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-start gap-2.5">
          <StatusDot tone={running.length > 0 ? "active" : "idle"} pulse={running.length > 0} className="mt-1" />
          <div className="min-w-0">
            <CardTitle>Agent activity</CardTitle>
            <CardDescription>
              {running.length > 0
                ? `${running.length} agent ${running.length === 1 ? "turn" : "turns"} running now`
                : "Nothing running — the last turns below are finished."}
            </CardDescription>
          </div>
        </div>
        <Link
          to="/runs?tab=activity"
          className="flex items-center gap-1 text-caption text-muted-foreground transition-colors hover:text-foreground"
        >
          All runs
          <HugeiconsIcon icon={ArrowRight02Icon} size={13} strokeWidth={1.7} />
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        {activity.error ? (
          <p className="px-5 py-6 text-center text-caption text-muted-foreground">
            The activity feed could not be read: {String(activity.error)}.
          </p>
        ) : shown.length === 0 ? (
          <p className="px-5 py-6 text-center text-caption text-muted-foreground">
            {activity.isPending
              ? "Reading the last turns…"
              : "No agent has run yet — send a message from the Playground to see a live turn here."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((item) => (
              <li key={`${item.source}-${item.id}`}>
                <LiveRow item={item} onOpen={open(item)} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <RunDrawer runId={openRun} onClose={() => setOpenRun(null)} />
    </Card>
  );
}
