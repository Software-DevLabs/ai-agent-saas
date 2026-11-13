import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

const DELAY_MS = 400;

/**
 * A label for an icon the rail is too narrow to spell out. Rendered in a portal
 * at the measured edge so it is never clipped by the sidebar's overflow, and
 * described through `aria-describedby` on the wrapper — the visible text is the
 * accessible text, not a second copy.
 */
export function Tooltip({
  label,
  side = "right",
  children,
  className,
}: {
  label: string;
  side?: "right" | "top";
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const timer = useRef<number>();
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition(
        side === "right"
          ? { left: rect.right + 8, top: rect.top + rect.height / 2 }
          : { left: rect.left + rect.width / 2, top: rect.top - 8 },
      );
    }, DELAY_MS);
  }, [side]);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setPosition(null);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <>
      <span
        ref={anchor}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-describedby={position ? id : undefined}
        className={cn("flex", className)}
      >
        {children}
      </span>
      {position
        ? createPortal(
            <span
              id={id}
              role="tooltip"
              style={{ left: position.left, top: position.top }}
              className={cn(
                "pointer-events-none fixed z-[70] whitespace-nowrap rounded-md bg-fill-inverse px-2 py-1 text-caption font-medium text-fill-inverse-foreground shadow-overlay",
                side === "right" ? "-translate-y-1/2" : "-translate-x-1/2 -translate-y-full",
              )}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
