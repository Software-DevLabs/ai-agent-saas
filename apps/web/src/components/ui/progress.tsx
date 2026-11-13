import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

export function Progress({
  value,
  tone = "primary",
  className,
}: {
  /** 0..1 */
  value: number;
  tone?: "primary" | "success" | "warning" | "danger";
  className?: string;
}) {
  const reduce = useReducedMotion();
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const fill =
    tone === "danger"
      ? "bg-destructive"
      : tone === "warning"
        ? "bg-warning"
        : tone === "success"
          ? "bg-success"
          : "bg-primary";
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <motion.div
        initial={false}
        animate={{ width: reduce ? `${clamped * 100}%` : `${clamped * 100}%` }}
        transition={{ type: "spring", stiffness: 140, damping: 24 }}
        className={cn("h-full rounded-full", fill)}
      />
    </div>
  );
}
