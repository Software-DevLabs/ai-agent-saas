import { HugeiconsIcon } from "@hugeicons/react";
import BotIcon from "@hugeicons/core-free-icons/BotIcon";
import Flowchart02Icon from "@hugeicons/core-free-icons/Flowchart02Icon";
import type { ActivityItem } from "@/lib/domain";
import { StatusDot } from "@/components/ui/status-dot";
import { cn, formatDuration, formatTokens, relativeTime } from "@/lib/utils";
import { activityTone, isLiveStatus } from "./tone";

/**
 * One row of agent work: who ran, what came in, what it has cost so far. The
 * duration of a live row is elapsed time, not a recorded total — the run has
 * not written one yet.
 */
export function ActivityLine({
  item,
  onOpen,
  note,
  dense = false,
}: {
  item: ActivityItem;
  onOpen?: () => void;
  /** A live "what it is doing right now" line, ahead of the input preview. */
  note?: string | null;
  dense?: boolean;
}) {
  const live = isLiveStatus(item.status);
  const title =
    item.source === "AGENT_RUN"
      ? item.agentName ?? "Agent turn"
      : item.nodeLabel ?? item.workflowName ?? "Workflow node";
  const subtitle = note ? `${note} · ${item.inputPreview}` : item.inputPreview;
  const elapsed =
    item.durationMs ??
    (live ? Math.max(0, Date.now() - new Date(item.startedAt).getTime()) : null);

  const body = (
    <>
      <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-fill text-muted-foreground shadow-inset">
        <HugeiconsIcon
          icon={item.source === "AGENT_RUN" ? BotIcon : Flowchart02Icon}
          size={14}
          strokeWidth={1.6}
        />
        <StatusDot
          tone={activityTone(item.status)}
          pulse={live}
          className="absolute -right-0.5 -top-0.5 ring-2 ring-card"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-menu text-foreground">{title}</span>
          <span className="shrink-0 font-mono text-meta uppercase text-muted-foreground/60">
            {item.source === "AGENT_RUN" ? "turn" : "node"}
          </span>
          {live ? (
            <span className="shrink-0 font-mono text-meta text-info">live</span>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-caption text-muted-foreground">{subtitle}</span>
      </span>
      <span className="flex shrink-0 items-center gap-3 font-mono text-meta tabular text-muted-foreground">
        <span className="hidden sm:inline">{formatTokens(item.tokensUsed)} tok</span>
        <span className="w-12 text-right">{formatDuration(elapsed)}</span>
        <span className="hidden w-14 text-right md:inline">{relativeTime(item.startedAt)}</span>
      </span>
    </>
  );

  const className = cn(
    "flex w-full items-center gap-2.5 text-left transition-colors",
    dense ? "px-3 py-1.5" : "px-3 py-2.5",
    onOpen && "cursor-pointer hover:bg-fill-subtle",
  );

  if (onOpen) {
    return (
      <button type="button" onClick={onOpen} className={className}>
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}
