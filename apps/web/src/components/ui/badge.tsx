import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Tone = "neutral" | "primary" | "info" | "success" | "warning" | "danger";

/** Tinted at 8–10% of the tone with the tone itself as text — colour only where it means something. */
const TONES: Record<Tone, string> = {
  neutral: "bg-foreground/5 text-muted-foreground",
  primary: "bg-info/10 text-info",
  info: "bg-info/10 text-info",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-destructive/10 text-destructive",
};

const DOTS: Record<Tone, string> = {
  neutral: "bg-muted-foreground",
  primary: "bg-info",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-[7px] px-2 text-meta font-medium shadow-inset",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  ACTIVE: "success",
  CONNECTED: "success",
  PROCESSED: "success",
  SUCCEEDED: "success",
  PAUSED: "neutral",
  QUEUED: "info",
  RUNNING: "info",
  PENDING: "neutral",
  SKIPPED: "neutral",
  DRAFT: "neutral",
  REVOKED: "neutral",
  ERROR: "danger",
  FAILED: "danger",
  DEAD: "danger",
  BLOCKED: "warning",
};

const LABELS: Record<string, string> = {
  ACTIVE: "Active",
  PAUSED: "Paused",
  ERROR: "Error",
  CONNECTED: "Connected",
  REVOKED: "Revoked",
  QUEUED: "Queued",
  PROCESSED: "Processed",
  FAILED: "Failed",
  DEAD: "Dead letter",
  RUNNING: "Running",
  SUCCEEDED: "Succeeded",
  PENDING: "Pending",
  SKIPPED: "Skipped",
  BLOCKED: "Blocked",
  DRAFT: "Draft",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = STATUS_TONES[status] ?? "neutral";
  return (
    <Badge tone={tone} className={className}>
      <span className={cn("h-1.5 w-1.5 rounded-full", DOTS[tone])} />
      {LABELS[status] ?? status}
    </Badge>
  );
}
