import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import ArrowDown01Icon from "@hugeicons/core-free-icons/ArrowDown01Icon";
import BotIcon from "@hugeicons/core-free-icons/BotIcon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import GaugeIcon from "@hugeicons/core-free-icons/GaugeIcon";
import PanelLeftCloseIcon from "@hugeicons/core-free-icons/PanelLeftCloseIcon";
import PanelLeftOpenIcon from "@hugeicons/core-free-icons/PanelLeftOpenIcon";
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import { NAV_SECTIONS, activeNavItem } from "./nav";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useSidebar,
} from "./sidebar-provider";
import { Avatar } from "@/components/ui/avatar";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import { UserMenu } from "@/components/ui/user-menu";
import { useTenant } from "@/lib/queries";
import { cn } from "@/lib/utils";

const RESIZE_STEP = 16;
/** A click that never moved must not rewrite the stored width. */
const DRAG_THRESHOLD = 5;

const CREATE_ITEMS = [
  { to: "/agents?new=1", label: "New agent", icon: BotIcon },
  { to: "/skills?new=1", label: "New skill", icon: Task01Icon },
  { to: "/projects?new=1", label: "New project", icon: Folder01Icon },
  { to: "/playground", label: "Open playground", icon: GaugeIcon },
] as const;

export function Sidebar({
  mobile = false,
  onOpenPalette,
}: {
  mobile?: boolean;
  onOpenPalette: () => void;
}) {
  const {
    collapsed: storedCollapsed,
    width,
    setWidth,
    toggleCollapsed,
    setMobileOpen,
    resizing,
    setResizing,
    LinkComponent,
  } = useSidebar();
  // The drawer always shows the full labels; only the desktop rail can collapse.
  const collapsed = mobile ? false : storedCollapsed;
  const tenant = useTenant();
  const { pathname } = useLocation();
  const active = activeNavItem(pathname);
  const [createOpen, setCreateOpen] = useState(false);
  const createRoot = useRef<HTMLDivElement>(null);

  const drag = useRef<{ startX: number; startWidth: number; moved: boolean } | null>(null);

  useEffect(() => {
    if (!resizing) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [resizing]);

  useEffect(() => {
    if (!createOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!createRoot.current?.contains(event.target as Node)) setCreateOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCreateOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [createOpen]);

  const openPalette = () => {
    if (mobile) setMobileOpen(false);
    setCreateOpen(false);
    onOpenPalette();
  };

  const onResizeKey = (event: React.KeyboardEvent) => {
    const next =
      event.key === "ArrowLeft"
        ? width - (event.shiftKey ? RESIZE_STEP * 3 : RESIZE_STEP)
        : event.key === "ArrowRight"
          ? width + (event.shiftKey ? RESIZE_STEP * 3 : RESIZE_STEP)
          : event.key === "Home"
            ? SIDEBAR_MIN_WIDTH
            : event.key === "End"
              ? SIDEBAR_MAX_WIDTH
              : null;
    if (next === null) return;
    event.preventDefault();
    setWidth(next);
  };

  return (
    <div className="relative flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className={cn("flex items-center gap-1.5 px-3 pb-1 pt-3", collapsed && "flex-col gap-1.5 px-0")}>
        <LinkComponent
          to="/"
          onClick={mobile ? () => setMobileOpen(false) : undefined}
          className={cn("flex min-w-0 flex-1 items-center gap-2.5 rounded-md", collapsed && "flex-none justify-center")}
        >
          <Avatar name={tenant.data?.name} size="md" tone="brand" />
          {!collapsed && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-menu text-foreground">{tenant.data?.name ?? "Workspace"}</span>
              <span className="block truncate text-eyebrow uppercase text-muted-foreground/60">
                {tenant.data?.planName ?? "loading"}
              </span>
            </span>
          )}
        </LinkComponent>
        {!mobile && !collapsed && (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="Collapse sidebar"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-fill hover:text-foreground"
          >
            <HugeiconsIcon icon={PanelLeftCloseIcon} size={15} strokeWidth={1.6} />
          </button>
        )}
        {!mobile && collapsed && (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="Expand sidebar"
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-fill hover:text-foreground"
          >
            <HugeiconsIcon icon={PanelLeftOpenIcon} size={15} strokeWidth={1.6} />
          </button>
        )}
      </div>

      <div className={cn("px-2 pt-2", collapsed && "px-0")}>
        {collapsed ? (
          <Tooltip label="Search · ⌘K" className="justify-center">
            <button
              type="button"
              onClick={openPalette}
              aria-label="Search workspace"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-fill hover:text-foreground"
            >
              <HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={1.6} />
            </button>
          </Tooltip>
        ) : (
          <button
            type="button"
            onClick={openPalette}
            className="flex h-control-md w-full items-center gap-2 rounded-md px-2 text-body-sm text-muted-foreground transition-colors hover:bg-fill hover:text-foreground"
          >
            <HugeiconsIcon icon={Search01Icon} size={15} strokeWidth={1.6} />
            <span className="flex-1 text-left">Search</span>
            <Kbd>⌘K</Kbd>
          </button>
        )}
      </div>

      <div ref={createRoot} className={cn("relative px-2 pt-1.5", collapsed && "flex justify-center px-0")}>
        <button
          type="button"
          onClick={() => setCreateOpen((value) => !value)}
          aria-haspopup="menu"
          aria-expanded={createOpen}
          className={cn(
            "flex h-control-md items-center gap-2 rounded-md bg-fill-subtle px-2 text-menu text-foreground shadow-inset transition-colors hover:bg-fill",
            collapsed ? "w-8 justify-center px-0" : "w-full",
          )}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.8} className="text-muted-foreground" />
          {!collapsed && (
            <>
              <span className="flex-1 text-left">Create</span>
              <HugeiconsIcon icon={ArrowDown01Icon} size={13} strokeWidth={1.8} className="text-muted-foreground" />
            </>
          )}
        </button>
        <AnimatePresence>
          {createOpen && (
            <motion.div
              role="menu"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.14 }}
              className="absolute left-2 top-full z-40 mt-1 w-52 rounded-lg bg-popover p-1 text-popover-foreground shadow-overlay"
            >
              {CREATE_ITEMS.map((item, index) => (
                <div key={item.to}>
                  {index === CREATE_ITEMS.length - 1 && <div className="my-1 h-px bg-border" />}
                  <LinkComponent
                    to={item.to}
                    role="menuitem"
                    onClick={() => {
                      setCreateOpen(false);
                      if (mobile) setMobileOpen(false);
                    }}
                    className="flex h-7 items-center gap-2 rounded-md px-2.5 text-body-sm text-muted-foreground transition-colors hover:bg-fill hover:text-foreground"
                  >
                    <HugeiconsIcon icon={item.icon} size={15} strokeWidth={1.6} />
                    {item.label}
                  </LinkComponent>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <nav aria-label="Console sections" className="mt-1.5 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-3">
        {NAV_SECTIONS.map((section) => (
          <div key={section.key} className="flex flex-col gap-0.5">
            {collapsed ? (
              <div className="mx-auto my-1.5 h-px w-6 bg-sidebar-border" aria-hidden="true" />
            ) : (
              <p className="px-2 pb-1 pt-2 text-eyebrow uppercase text-muted-foreground/60">{section.label}</p>
            )}
            {section.items.map((item) => {
              const isActive = active?.to === item.to;
              const link = (
                <LinkComponent
                  key={item.to}
                  to={item.to}
                  aria-current={isActive ? "page" : undefined}
                  onClick={mobile ? () => setMobileOpen(false) : undefined}
                  className={cn(
                    "relative flex items-center gap-2.5 rounded-md text-menu transition-colors duration-200 ease-calm",
                    collapsed ? "mx-auto h-8 w-8 justify-center" : "h-control-md px-2",
                    isActive
                      ? "bg-fill text-foreground shadow-inset"
                      : "text-muted-foreground hover:bg-fill-subtle hover:text-foreground",
                  )}
                >
                  <HugeiconsIcon
                    icon={item.icon}
                    size={collapsed ? 17 : 16}
                    strokeWidth={1.6}
                    className={cn("shrink-0", isActive ? "text-foreground" : "text-muted-foreground")}
                  />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </LinkComponent>
              );
              return collapsed ? (
                <Tooltip key={item.to} label={item.label} className="justify-center">
                  {link}
                </Tooltip>
              ) : (
                link
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t p-2">
        <UserMenu collapsed={collapsed} />
      </div>

      {!mobile && !collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={width}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          tabIndex={0}
          onKeyDown={onResizeKey}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { startX: event.clientX, startWidth: width, moved: false };
            setResizing(true);
          }}
          onPointerMove={(event) => {
            const state = drag.current;
            if (!state) return;
            const delta = event.clientX - state.startX;
            if (Math.abs(delta) > DRAG_THRESHOLD) state.moved = true;
            if (state.moved) setWidth(state.startWidth + delta);
          }}
          onPointerUp={() => {
            drag.current = null;
            setResizing(false);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setResizing(false);
          }}
          className={cn(
            "absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none outline-none",
            "after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-transparent after:transition-colors",
            resizing && "after:bg-foreground/40",
            "hover:after:bg-foreground/30 focus-visible:after:bg-foreground/60",
          )}
          style={{ right: -3 }}
        />
      )}
    </div>
  );
}
