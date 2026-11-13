import { useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useOverlay } from "@/lib/overlay";
import { Button } from "./button";

/**
 * A modal in a portal, so it covers the viewport rather than whatever filtered
 * or transformed ancestor happened to render it. Escape, Tab containment, body
 * scroll lock and focus return all come from `useOverlay`.
 */
export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useOverlay(open, panel, onClose);
  const reduce = useReducedMotion();

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div className="absolute inset-0 bg-scrim" onClick={onClose} aria-hidden="true" />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            initial={reduce ? false : { opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, y: 8, scale: 0.985 }}
            transition={{ type: "spring", stiffness: 340, damping: 30 }}
            className={`relative flex max-h-[85vh] w-full flex-col ${width} rounded-xl bg-background-2 text-foreground shadow-overlay outline-none`}
          >
            <div className="space-y-1 px-5 pt-5">
              <h2 className="text-heading">{title}</h2>
              {description ? <p className="text-body-sm text-muted-foreground">{description}</p> : null}
            </div>
            {children ? <div className="mt-4 min-h-0 overflow-y-auto px-5">{children}</div> : null}
            <div className="mt-5 flex justify-end gap-2 px-5 pb-5">{footer}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? "destructive" : "primary"} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        {danger && <HugeiconsIcon icon={AlertCircleIcon} size={18} className="mt-0.5 text-destructive" />}
        <p className="text-body-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </Dialog>
  );
}
