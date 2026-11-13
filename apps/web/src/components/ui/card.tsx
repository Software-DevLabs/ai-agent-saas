import type { HTMLAttributes, ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { HTMLMotionProps } from "motion/react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("min-w-0 rounded-xl bg-card text-card-foreground shadow-raised", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  // Wraps rather than squeezes: a header carrying tabs or filters stays legible
  // down to a phone instead of pushing its controls off the card.
  return <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-5 pt-5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-sm font-semibold tracking-tight", className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("mt-1 text-[13px] leading-relaxed text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pb-5 pt-4", className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-2 border-t px-5 py-3.5", className)} {...props} />;
}

/**
 * The bento tile: a card that reacts to the pointer with a spring rather than a
 * colour change, so hover stays quiet. The 1px highlight along the top edge is
 * the reference design's tell that a surface is raised, not painted.
 */
export function BentoCard({
  className,
  interactive = true,
  children,
  ...props
}: HTMLMotionProps<"div"> & { interactive?: boolean; children?: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={false}
      whileHover={interactive && !reduce ? { y: -2 } : undefined}
      transition={{ type: "spring", stiffness: 320, damping: 28 }}
      className={cn(
        "group relative overflow-hidden rounded-xl bg-card p-5 text-card-foreground shadow-raised transition-shadow duration-300",
        interactive && "hover:shadow-overlay",
        className,
      )}
      {...props}
    >
      {children}
    </motion.div>
  );
}
