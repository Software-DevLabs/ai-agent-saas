import { useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import ChevronRightIcon from "@hugeicons/core-free-icons/ChevronRightIcon";
import { HugeiconsIcon } from "@hugeicons/react";
import { NAV_ITEMS, activeNavItem, type NavItem } from "../layout/nav";
import { shortId } from "@/lib/utils";

export interface Crumb {
  label: string;
  to?: string;
}

function trailFor(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const root = segments[0];
  if (!root) return [{ label: "Overview" }];

  const nav: NavItem | undefined = NAV_ITEMS.find((item) => item.to === `/${root}`);
  const trail: Crumb[] = [{ label: nav?.label ?? root, to: `/${root}` }];

  if (root === "projects" && segments[1]) {
    trail.push({ label: `Project ${shortId(segments[1])}`, to: `/projects/${segments[1]}` });
    if (segments[2] === "workflows" && segments[3]) {
      trail.push({ label: `Workflow ${shortId(segments[3])}` });
    }
  } else if (segments[1]) {
    // An agent, workflow or integration detail page: the id is the only name
    // the route itself knows, and the page below shows the real one.
    trail.push({ label: shortId(segments[1]) });
  }

  return trail;
}

/** The current route expressed as links, derived rather than hand-maintained per page. */
export function useBreadcrumbTrail(): Crumb[] {
  const { pathname } = useLocation();
  return useMemo(() => trailFor(pathname), [pathname]);
}

export function Breadcrumbs() {
  const trail = useBreadcrumbTrail();
  const active = activeNavItem(trail[0]?.to ?? "/");

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-body-sm">
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1">
              {index > 0 && (
                <HugeiconsIcon icon={ChevronRightIcon} size={11} strokeWidth={2} className="shrink-0 text-muted-foreground/50" />
              )}
              {last || !crumb.to ? (
                <span aria-current={last ? "page" : undefined} className="truncate font-medium text-foreground">
                  {crumb.label}
                </span>
              ) : (
                <Link
                  to={crumb.to}
                  title={index === 0 ? active?.hint : undefined}
                  className="truncate text-muted-foreground transition-colors hover:text-foreground"
                >
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
