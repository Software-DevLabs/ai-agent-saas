import { motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import ArrowUp01Icon from "@hugeicons/core-free-icons/ArrowUp01Icon";
import { cn } from "@/lib/utils";
import { BentoCard } from "@/components/ui/card";

function CountUp({ value, format }: { value: number; format: (input: number) => string }) {
  const reduce = useReducedMotion();
  return (
    <span className="font-mono text-[26px] font-medium leading-none tabular tracking-tight">
      {reduce ? format(value) : <MotionNumber value={value} format={format} />}
    </span>
  );
}

function MotionNumber({ value, format }: { value: number; format: (input: number) => string }) {
  return (
    <motion.span
      initial={{ opacity: 0.6 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
    >
      {format(value)}
    </motion.span>
  );
}

export function StatCard({
  label,
  value,
  format,
  delta,
  icon,
  hint,
}: {
  label: string;
  value: number;
  format?: (input: number) => string;
  delta?: number;
  icon: IconSvgElement;
  hint?: string;
}) {
  const showDelta = typeof delta === "number" && Number.isFinite(delta) && Math.abs(delta) >= 0.5;
  const positive = (delta ?? 0) >= 0;
  return (
    <BentoCard className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-[12px] font-medium text-muted-foreground">{label}</p>
        <span className="flex h-7 w-7 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground transition-colors group-hover:border-foreground/20 group-hover:text-foreground">
          <HugeiconsIcon icon={icon} size={14} strokeWidth={1.6} />
        </span>
      </div>
      <div className="flex items-end gap-2">
        <CountUp value={value} format={format ?? ((input) => input.toLocaleString("en-US"))} />
        {showDelta && (
          <span
            className={cn(
              "mb-0.5 inline-flex items-center gap-0.5 font-mono text-[11px]",
              positive ? "text-success" : "text-destructive",
            )}
          >
            <HugeiconsIcon icon={positive ? ArrowUp01Icon : ArrowDown01Icon} size={11} strokeWidth={2} />
            {Math.abs(delta as number).toFixed(1)}%
          </span>
        )}
      </div>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </BentoCard>
  );
}
