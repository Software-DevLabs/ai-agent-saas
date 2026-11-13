import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** A key cap: the shortcuts the console accepts, shown the way the reference does. */
export function Kbd({ className, children, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border bg-fill-subtle px-1 font-mono text-meta font-normal text-muted-foreground shadow-inset",
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
