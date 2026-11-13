import { HugeiconsIcon } from "@hugeicons/react";
import FunctionIcon from "@hugeicons/core-free-icons/FunctionIcon";
import { cn, formatDuration } from "@/lib/utils";

const PRE =
  "max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-muted-foreground";

/** One executed tool call, with the previews the run recorded for it. */
export function ToolStepCard({
  step,
}: {
  step: {
    tool: string;
    argsPreview: string | null;
    resultPreview: string | null;
    ok: boolean;
    durationMs?: number | null;
  };
}) {
  return (
    <div className="overflow-hidden rounded-lg bg-fill-subtle shadow-inset">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <HugeiconsIcon icon={FunctionIcon} size={13} strokeWidth={1.7} className="text-muted-foreground" />
        <span className="truncate font-mono text-caption text-foreground">{step.tool}</span>
        <span
          className={cn(
            "rounded px-1 font-mono text-meta",
            step.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
          )}
        >
          {step.ok ? "ok" : "failed"}
        </span>
        <span className="ml-auto font-mono text-meta tabular text-muted-foreground">
          {formatDuration(step.durationMs ?? null)}
        </span>
      </div>
      <div className="grid gap-2 border-t px-3 py-2 sm:grid-cols-2">
        <div className="min-w-0">
          <p className="text-meta uppercase text-muted-foreground/60">Arguments</p>
          <pre className={PRE}>{step.argsPreview || "—"}</pre>
        </div>
        <div className="min-w-0">
          <p className="text-meta uppercase text-muted-foreground/60">Result</p>
          <pre className={PRE}>{step.resultPreview || "—"}</pre>
        </div>
      </div>
    </div>
  );
}
