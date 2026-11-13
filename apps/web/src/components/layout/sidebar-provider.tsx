import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ComponentType, MouseEvent as ReactMouseEvent, ReactNode } from "react";

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_COLLAPSED_WIDTH = 64;
const STORAGE_KEY = "console.sidebar.v2";

interface StoredSidebar {
  collapsed: boolean;
  width: number;
}

/** The router anchor the sidebar receives, so this package of components owns no route knowledge. */
export type SidebarLink = ComponentType<{
  to: string;
  className?: string;
  onClick?: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  "aria-current"?: "page";
  role?: "menuitem";
  children: ReactNode;
}>;

interface SidebarContextValue {
  collapsed: boolean;
  width: number;
  mobileOpen: boolean;
  /** True while the separator is being dragged, so the shell can drop its width transition. */
  resizing: boolean;
  setResizing: (value: boolean) => void;
  setCollapsed: (value: boolean) => void;
  toggleCollapsed: () => void;
  setWidth: (value: number) => void;
  setMobileOpen: (value: boolean) => void;
  LinkComponent: SidebarLink;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export const clampWidth = (value: number) =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(value)));

function read(): StoredSidebar {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof stored === "object" && stored !== null) {
      const record = stored as Record<string, unknown>;
      return {
        collapsed: record.collapsed === true,
        width: typeof record.width === "number" ? clampWidth(record.width) : 240,
      };
    }
  } catch {
    /* A hand-edited value is not worth a crash; fall through to the defaults. */
  }
  return { collapsed: false, width: 240 };
}

/** Below this width the rail is the only honest option: 200px would eat half the screen. */
const NARROW = "(max-width: 1023px)";

export function SidebarProvider({
  children,
  LinkComponent,
}: {
  children: ReactNode;
  LinkComponent: SidebarLink;
}) {
  const [stored, setStored] = useState<StoredSidebar>(read);
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener("change", onChange);
    setNarrow(query.matches);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  }, [stored]);

  const setCollapsed = useCallback((value: boolean) => setStored((current) => ({ ...current, collapsed: value })), []);
  const toggleCollapsed = useCallback(() => setStored((current) => ({ ...current, collapsed: !current.collapsed })), []);
  const setWidth = useCallback((value: number) => setStored((current) => ({ ...current, width: clampWidth(value) })), []);

  const value = useMemo<SidebarContextValue>(
    () => ({
      // A narrow viewport collapses regardless of the stored preference, but the
      // preference survives: widening the window restores the width it had.
      collapsed: stored.collapsed || narrow,
      width: stored.width,
      mobileOpen,
      resizing,
      setResizing,
      setCollapsed,
      toggleCollapsed,
      setWidth,
      setMobileOpen,
      LinkComponent,
    }),
    [stored, narrow, mobileOpen, resizing, setCollapsed, toggleCollapsed, setWidth, LinkComponent],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarContextValue {
  const value = useContext(SidebarContext);
  if (!value) throw new Error("useSidebar must be used inside SidebarProvider");
  return value;
}
