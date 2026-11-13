import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import Moon02Icon from "@hugeicons/core-free-icons/Moon02Icon";
import Sun03Icon from "@hugeicons/core-free-icons/Sun03Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSidebar } from "../layout/sidebar-provider";
import { useTenant } from "@/lib/queries";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Avatar } from "./avatar";

/**
 * The workspace menu at the bottom of the rail. There is no signed-in user yet,
 * so it shows the tenant the API actually scoped the session to and the actions
 * that work today — nothing pretends to switch accounts.
 */
export function UserMenu({ collapsed }: { collapsed: boolean }) {
  const tenant = useTenant();
  const { theme, toggle } = useTheme();
  const { LinkComponent } = useSidebar();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const name = tenant.data?.name ?? "Workspace";

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 rounded-md p-1.5 text-left transition-colors hover:bg-fill",
          collapsed && "justify-center",
        )}
      >
        <Avatar name={tenant.data?.name} size="sm" />
        {!collapsed && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-menu text-foreground">{name}</span>
            <span className="block truncate text-caption text-muted-foreground">{tenant.data?.planName ?? "—"}</span>
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.14 }}
            className="absolute bottom-full left-0 z-40 mb-2 w-56 overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-overlay"
          >
            <div className="px-2.5 py-2">
              <p className="truncate text-menu">{name}</p>
              <p className="truncate text-caption text-muted-foreground">{tenant.data?.planName ?? "loading"}</p>
            </div>
            <div className="my-1 h-px bg-border" />
            <LinkComponent
              to="/settings"
              onClick={() => setOpen(false)}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-body-sm text-muted-foreground transition-colors hover:bg-fill hover:text-foreground"
            >
              Settings
            </LinkComponent>
            <LinkComponent
              to="/billing"
              onClick={() => setOpen(false)}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-body-sm text-muted-foreground transition-colors hover:bg-fill hover:text-foreground"
            >
              Billing
            </LinkComponent>
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              role="menuitem"
              onClick={toggle}
              className="flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-body-sm text-muted-foreground transition-colors hover:bg-fill hover:text-foreground"
            >
              <HugeiconsIcon icon={theme === "dark" ? Sun03Icon : Moon02Icon} size={15} strokeWidth={1.6} />
              {theme === "dark" ? "Light theme" : "Dark theme"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
