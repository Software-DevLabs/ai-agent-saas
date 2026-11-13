import { useEffect, useRef, useState } from "react";
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";

/**
 * A pre-formatted payload with a real copy action. The button only says
 * "Copied" after the clipboard write resolved; a refused write stays a copy
 * button and the browser's own clipboard error is not swallowed into a lie.
 */
export function CodeBlock({ code, className }: { code: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className={cn("group relative rounded-md bg-fill-subtle p-2.5 shadow-inset", className)}>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-muted-foreground">
        {code}
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "Copied" : "Copy to clipboard"}
        className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-fill hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={13} strokeWidth={1.7} />
      </button>
    </div>
  );
}
