import { BaseEdge, getBezierPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import type { NodeRunStatus } from "@/lib/domain";

/**
 * A cable.
 *
 * Idle cables are dashed and quiet; once the box they leave has actually
 * succeeded in the run being watched, the cable turns solid and takes the
 * success colour — the same distinction a run's own node rows make, drawn on the
 * thing that carried the work. Nothing here invents a state: the status is the
 * server's `WorkflowNodeRun.status` for the source node, passed down by the board.
 */
export interface FlowEdgeData {
  status: NodeRunStatus | null;
}

const STROKE = {
  idle: "oklch(var(--muted-foreground) / 0.7)",
  active: "oklch(var(--info))",
  done: "oklch(var(--success))",
  selected: "oklch(var(--foreground) / 0.8)",
} as const;

export function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: 0.32 });
  const status = (data as FlowEdgeData | undefined)?.status ?? null;
  const tone = selected ? "selected" : status === "SUCCEEDED" ? "done" : status === "RUNNING" ? "active" : "idle";
  const stroke = STROKE[tone];
  // An id built from the edge's own id is unique per cable and survives React's
  // render ordering; `useId` produces colons, which some browsers refuse inside
  // a `url(#…)` reference.
  const arrow = `arrow-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <>
      <defs>
        <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M1 1 L9 5 L1 9 Z" fill={stroke} />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#${arrow})`}
        style={{
          stroke,
          strokeWidth: tone === "idle" ? 1.5 : 2,
          strokeLinecap: "round",
          strokeDasharray: tone === "idle" ? "5 6" : undefined,
        }}
        vectorEffect="non-scaling-stroke"
      />
    </>
  );
}

export const EDGE_TYPES = { flow: FlowEdge };
