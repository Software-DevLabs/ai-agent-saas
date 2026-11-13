import { HugeiconsIcon } from "@hugeicons/react";
import Alert01Icon from "@hugeicons/core-free-icons/Alert01Icon";
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import type { GraphIssue, WorkflowValidation } from "@/lib/domain";
import { cn } from "@/lib/utils";

/**
 * The server's own report, verbatim.
 *
 * Every line here is an issue the API returned from `packages/core` — the same
 * rules the worker will apply before it runs a node. Nothing is filtered to
 * keep the panel short, because a graph that "looked valid" and then refused to
 * activate is the failure mode this console is not allowed to produce.
 */
export function IssuesPanel({
  report,
  pending,
  onPick,
  highlighted,
}: {
  report: WorkflowValidation | null;
  pending: boolean;
  onPick: (issue: GraphIssue) => void;
  highlighted?: string;
}) {
  if (pending) {
    return <p className="text-[12px] text-muted-foreground">Checking the graph…</p>;
  }

  if (!report) {
    return (
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Validate to check every rule: cables, cycles, ownership and direction. Saving works whether or not the graph
        passes — an unfinished canvas is a thing you should be able to keep.
      </p>
    );
  }

  if (report.issues.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-success">
        <HugeiconsIcon icon={CheckmarkCircle02Icon} size={14} strokeWidth={1.7} />
        No issues. Every rule the server checks passes.
        {report.order.length > 0 && (
          <span className="ml-1 font-mono text-[11px] font-normal text-muted-foreground">
            runs {report.order.join(" → ")}
          </span>
        )}
      </p>
    );
  }

  return (
    <ul className="space-y-1">
      {report.issues.map((issue, index) => (
        <li key={`${issue.code}:${issue.path ?? issue.nodeKey ?? index}`}>
          <button
            type="button"
            onClick={() => onPick(issue)}
            disabled={!issue.nodeKey}
            className={cn(
              "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
              issue.nodeKey ? "hover:bg-accent" : "cursor-default",
              highlighted && highlighted === issue.nodeKey && "bg-accent",
            )}
          >
            <HugeiconsIcon
              icon={issue.level === "error" ? Alert01Icon : Alert02Icon}
              size={13}
              strokeWidth={1.8}
              className={cn("mt-0.5 shrink-0", issue.level === "error" ? "text-destructive" : "text-warning")}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] leading-snug">{issue.message}</span>
              <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                {issue.code}
                {issue.path ? ` · ${issue.path}` : ""}
                {issue.nodeKey ? ` · ${issue.nodeKey}` : ""}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
