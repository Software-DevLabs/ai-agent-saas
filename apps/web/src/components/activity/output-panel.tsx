import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";
import { cn } from "@/lib/utils";

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? "Copied" : "Copy output"}
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-fill hover:text-foreground"
    >
      <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={13} strokeWidth={1.7} />
    </button>
  );
}

/** The reply (or the failure) exactly as the run recorded it, with a real copy action. */
export function OutputPanel({
  output,
  error,
  emptyLabel = "No output was recorded.",
  className,
}: {
  output: string | null;
  error?: string | null;
  emptyLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between">
        <p className="text-label text-foreground">Output</p>
        {output ? <CopyAction text={output} /> : null}
      </div>
      {output ? (
        <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-fill-subtle p-3 font-mono text-caption leading-relaxed text-foreground shadow-inset">
          {output}
        </pre>
      ) : (
        <p className="rounded-lg bg-fill-subtle px-3 py-2.5 text-caption text-muted-foreground shadow-inset">
          {emptyLabel}
        </p>
      )}
      {error ? (
        <div className="rounded-lg bg-destructive/10 px-3 py-2 font-mono text-caption text-destructive shadow-inset">
          {error}
        </div>
      ) : null}
    </div>
  );
}
