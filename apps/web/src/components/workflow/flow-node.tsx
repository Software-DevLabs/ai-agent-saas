import { memo, useContext } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import Alert01Icon from "@hugeicons/core-free-icons/Alert01Icon";
import AiNetworkIcon from "@hugeicons/core-free-icons/AiNetworkIcon";
import BotIcon from "@hugeicons/core-free-icons/BotIcon";
import LoginIcon from "@hugeicons/core-free-icons/LoginIcon";
import LogoutIcon from "@hugeicons/core-free-icons/LogoutIcon";
import { CanvasContext, KIND_LABEL } from "@/lib/graph-flow";
import type { FlowNodeData } from "@/lib/graph-flow";
import type { NodeKind, NodeRunStatus } from "@/lib/domain";
import { cn } from "@/lib/utils";

/**
 * One box on the canvas.
 *
 * It shows the *reference*, not a copy of it: the row's real name while the row
 * exists, and the id plus a "deleted" marker when it does not. A node that kept
 * displaying "Triage" after the agent was deleted would be the lie this console
 * is not allowed to tell — the graph still points at a gone row, so the box says
 * so, and `level()` from the server's report puts the mark on it.
 *
 * The footer is the last run's verdict for this box, if a run is being watched.
 * Cables leave from the bottom edge and land on the top edge; the sockets stay
 * invisible until the box is hovered so the card reads as a card, but they are
 * real handles — a press there is a cable, not a drag.
 */

const KIND_ICON: Record<NodeKind, IconSvgElement> = {
  INBOUND: LoginIcon,
  AGENT: BotIcon,
  OUTBOUND: LogoutIcon,
  ORCHESTRATOR: AiNetworkIcon,
};

const STATUS_TONE: Record<NodeRunStatus, string> = {
  PENDING: "text-muted-foreground",
  RUNNING: "text-info",
  SUCCEEDED: "text-success",
  FAILED: "text-destructive",
  SKIPPED: "text-muted-foreground",
};

function duration(ms: number): string {
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${ms} ms`;
}

function Handles({ kind }: { kind: NodeKind }) {
  // `!z-10` keeps the socket above the card that shares this wrapper: the handle
  // straddles the card's edge, and without it the card would swallow the half of
  // the hit area a person actually presses.
  const socket =
    "!z-10 !h-3 !w-3 !rounded-full !border-2 !border-background !bg-foreground/30 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus:opacity-100";
  return (
    <>
      {kind !== "INBOUND" && <Handle type="target" position={Position.Top} className={socket} />}
      {kind !== "OUTBOUND" && <Handle type="source" position={Position.Bottom} className={socket} />}
    </>
  );
}

export const FlowNode = memo(function FlowNode({ id, data, selected }: NodeProps) {
  const node = data as unknown as FlowNodeData;
  const { ref, level, runNode } = useContext(CanvasContext);
  const info = ref(node.refId, node.kind);
  const issue = level(id);
  const live = runNode(id);
  const title = node.label.trim() !== "" ? node.label.trim() : (info?.name ?? "Missing row");

  return (
    <div className="group relative w-[274px]">
      <Handles kind={node.kind} />
      <div
        data-status={live?.status.toLowerCase() ?? "idle"}
        className={cn(
          "relative overflow-hidden rounded-xl border bg-card text-card-foreground shadow-card transition-[border-color,box-shadow] duration-200",
          "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-transparent before:content-['']",
          "data-[status=running]:before:bg-info data-[status=succeeded]:before:bg-success data-[status=failed]:before:bg-destructive",
          selected ? "border-foreground/35 shadow-pop" : "border-border",
          issue === "error" && "border-destructive/60",
          issue === "warning" && "border-warning/60",
        )}
        title={KIND_LABEL[node.kind]}
      >
        <div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
          <HugeiconsIcon icon={KIND_ICON[node.kind]} size={14} strokeWidth={1.6} className="shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight">{title}</p>
          {issue !== null && (
            <HugeiconsIcon
              icon={Alert01Icon}
              size={13}
              strokeWidth={1.8}
              className={issue === "error" ? "text-destructive" : "text-warning"}
            />
          )}
          <span className="shrink-0 rounded border border-border px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            {KIND_LABEL[node.kind]}
          </span>
        </div>

        <div className="px-3 pb-2.5">
          <p className="truncate text-[12px] leading-tight text-muted-foreground">
            {info?.name ?? `${node.refId} · deleted`}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] leading-tight text-muted-foreground/80">
            {info === null
              ? "row deleted"
              : node.kind === "ORCHESTRATOR"
                ? `${node.subagents.length} subagent${node.subagents.length === 1 ? "" : "s"} · ${info.meta}`
                : (info.channelType ?? info.meta)}
          </p>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5">
          <span
            className={cn(
              "text-[10px] font-medium uppercase tracking-wide",
              live ? STATUS_TONE[live.status] : "text-muted-foreground",
            )}
          >
            {live ? live.status.toLowerCase() : "not run"}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {live !== null && live.tokensUsed > 0 ? `${live.tokensUsed} t` : ""}
            {live?.tokensUsed && live.durationMs != null ? " · " : ""}
            {live?.durationMs != null ? duration(live.durationMs) : ""}
          </span>
        </div>
      </div>
    </div>
  );
});

export const NODE_TYPES = { saas: FlowNode };
