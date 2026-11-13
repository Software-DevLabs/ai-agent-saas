import { useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useOverlay } from "@/lib/overlay";
import { cn } from "@/lib/utils";

export type SheetSide = "left" | "right" | "top" | "bottom";

const PANEL: Record<SheetSide, string> = {
  left: "inset-y-0 left-0 h-full",
  right: "inset-y-0 right-0 h-full",
  top: "inset-x-0 top-0 w-full",
  bottom: "inset-x-0 bottom-0 w-full",
};

const MOTION: Record<SheetSide, { from: string; to: string }> = {
  left: { from: "-100%", to: "0%" },
  right: { from: "100%", to: "0%" },
  top: { from: "-100%", to: "0%" },
  bottom: { from: "100%", to: "0%" },
};

/**
 * A surface that slides in from an edge. Portaled, focus-trapped and
 * scroll-locked — the mobile navigation drawer, the workflow palette on a phone
 * and the inspector below `lg` are all this component, so they cannot drift.
 */
export function Sheet({
  open,
  onClose,
  side = "left",
  title,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  side?: SheetSide;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useOverlay(open, panel, onClose);
  const reduce = useReducedMotion();
  const offset = side === "left" || side === "right" ? "x" : "y";
  const axis = (value: string) => (offset === "x" ? { x: value } : { y: value });

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="absolute inset-0 bg-scrim"
            aria-hidden="true"
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            initial={reduce ? false : axis(MOTION[side].from)}
            animate={axis(MOTION[side].to)}
            exit={reduce ? undefined : axis(MOTION[side].from)}
            transition={{ type: "spring", stiffness: 380, damping: 38 }}
            className={cn(
              "absolute flex flex-col overflow-hidden bg-background-2 text-foreground shadow-overlay outline-none",
              side === "left" || side === "right" ? "w-[288px]" : "max-h-[85vh]",
              PANEL[side],
              className,
            )}
          >
            <div className="flex h-header-default shrink-0 items-center justify-between px-4">
              <p className="text-subheading">{title}</p>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-fill hover:text-foreground"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={15} strokeWidth={1.6} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
