import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one heading every console page opens with: what this page is, one line of
 * why it exists, and the actions that operate on it. Actions wrap under the
 * title on narrow screens instead of shrinking to unreadable labels.
 */
export function PageHeader({
  title,
  description,
  actions,
  meta,
  leading,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  /** An avatar or kind glyph for detail pages; omitted on list pages. */
  leading?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="flex min-w-0 items-start gap-3">
        {leading}
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-display text-foreground">{title}</h1>
            {meta}
          </div>
          {description ? (
            <div className="max-w-2xl text-body text-muted-foreground">{description}</div>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div> : null}
    </header>
  );
}
