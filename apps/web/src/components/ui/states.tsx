import type { ReactNode } from "react";
import InfoIcon from "@hugeicons/core-free-icons/InfoIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-fill", className)} />;
}

/**
 * The action is a pair or nothing: a label with no handler renders a dead
 * button, and a handler with no label renders none at all — which is how three
 * pages shipped an empty state whose only call to action never appeared.
 */
type EmptyStateProps = { title: string; body: string } & (
  | { actionLabel: string; onAction: () => void }
  | { actionLabel?: undefined; onAction?: undefined }
);

export function EmptyState({ title, body, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <span className="mb-1 flex h-9 w-9 items-center justify-center rounded-lg bg-fill shadow-inset">
        <HugeiconsIcon icon={InfoIcon} size={16} className="text-muted-foreground" />
      </span>
      <h3 className="text-subheading text-foreground">{title}</h3>
      <p className="max-w-sm text-body-sm text-muted-foreground">{body}</p>
      {onAction ? (
        <Button variant="outline" size="sm" className="mt-3" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

export function QueryState({
  error,
  pending,
  isEmpty,
  empty,
  children,
}: {
  error: unknown;
  pending: boolean;
  isEmpty?: boolean;
  empty?: ReactNode;
  children: ReactNode;
}) {
  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    return (
      <div className="m-5 rounded-lg bg-destructive/10 px-4 py-3 shadow-inset">
        <p className="text-label text-destructive">Request failed</p>
        <p className="mt-1 font-mono text-caption text-muted-foreground">{message}</p>
      </div>
    );
  }
  if (pending) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (isEmpty && empty) return <>{empty}</>;
  return <>{children}</>;
}
