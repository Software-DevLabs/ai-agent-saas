import { Suspense, useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { motion, useReducedMotion } from "motion/react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { SidebarProvider, useSidebar, type SidebarLink } from "./sidebar-provider";
import { Sheet } from "@/components/ui/sheet";
import { CommandPalette } from "@/components/ui/command-palette";
import { Skeleton } from "@/components/ui/states";
import { prefetchRoute } from "@/lib/page-loaders";

/** Page entrance: a short rise + fade. Quiet on purpose, and never animated twice. */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <motion.main
        initial={reduce ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8"
      >
        {children}
      </motion.main>
    </div>
  );
}

/**
 * The frame for a full-bleed surface — the workflow canvas — where the animated
 * one cannot be used.
 *
 * An animating `main` is a paint/compositing hazard: while it runs, its box is a
 * containing block for `position: fixed` children and its own layer can be
 * repainted late, which reads as a blank page area next to a sidebar that is
 * fine. React Flow additionally needs an ancestor with an actual height or it
 * renders an empty box. So the canvas gets a plain `main` with a real height and
 * no motion at all.
 */
export function CanvasFrame({ children }: { children: React.ReactNode }) {
  return <main className="relative h-full min-h-0 w-full">{children}</main>;
}

/**
 * The route chunk's placeholder. It replaces only the page, never the shell —
 * the sidebar and topbar stay interactive while the next page's module loads.
 */
function PageFallback() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1400px] space-y-4 px-4 py-6 sm:px-6 lg:px-8">
        <Skeleton className="h-7 w-56" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-[340px] w-full" />
      </div>
    </div>
  );
}

/** The sidebar's contract is narrower than react-router's `To`; this is the only place the two meet. */
const RouterLink: SidebarLink = ({ to, ...rest }) => (
  <Link to={to} {...rest} onMouseEnter={() => prefetchRoute(to)} onFocus={() => prefetchRoute(to)} />
);

function Shell() {
  const { collapsed, width, mobileOpen, setMobileOpen, resizing } = useSidebar();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setMobileOpen(false), [location.pathname, setMobileOpen]);

  return (
    <div className="flex h-screen min-h-0 bg-sidebar text-foreground">
      <aside
        style={{ width: collapsed ? 64 : width }}
        className={
          resizing
            ? "hidden h-full shrink-0 md:block"
            : "hidden h-full shrink-0 transition-[width] duration-300 ease-calm md:block"
        }
      >
        <Sidebar onOpenPalette={() => setPaletteOpen(true)} />
      </aside>

      <Sheet open={mobileOpen} onClose={() => setMobileOpen(false)} side="left" title="Navigation" className="bg-sidebar">
        <Sidebar mobile onOpenPalette={() => setPaletteOpen(true)} />
      </Sheet>

      {/* The inset frame: sidebar gutter around a rounded, raised surface. */}
      <div className="flex min-w-0 flex-1 flex-col lg:p-2 lg:pl-0">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background lg:rounded-2xl lg:shadow-raised">
          <Topbar onOpenPalette={() => setPaletteOpen(true)} />
          {/* The page owns its own entrance (`PageTransition`), so nothing here may
              delay the mount: a wait-for-exit transition would keep the previous
              route's box on screen while the next one is refused, and an
              interrupted exit leaves the content area empty until a reload. */}
          <div className="flex min-h-0 flex-1 flex-col">
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          </div>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onOpen={() => setPaletteOpen(true)} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

export function AppShell() {
  return (
    <SidebarProvider LinkComponent={RouterLink}>
      <Shell />
    </SidebarProvider>
  );
}
