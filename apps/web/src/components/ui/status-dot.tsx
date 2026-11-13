import { cn } from "@/lib/utils";

export type StatusTone = "idle" | "active" | "success" | "warning" | "danger" | "neutral";

const TONES: Record<StatusTone, string> = {
  idle: "bg-gray-6",
  active: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground",
};

/** A 6px state dot; `pulse` is reserved for rows that are actually moving. */
export function StatusDot({
  tone = "neutral",
  pulse = false,
  className,
}: {
  tone?: StatusTone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex h-1.5 w-1.5 shrink-0 rounded-full", TONES[tone], pulse && "animate-pulse", className)}
    />
  );
}
