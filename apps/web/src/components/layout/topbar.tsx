import { HugeiconsIcon } from "@hugeicons/react";
import Menu01Icon from "@hugeicons/core-free-icons/Menu01Icon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import Moon02Icon from "@hugeicons/core-free-icons/Moon02Icon";
import Sun03Icon from "@hugeicons/core-free-icons/Sun03Icon";
import { Breadcrumbs } from "@/components/ui/breadcrumb";
import { Kbd } from "@/components/ui/kbd";
import { StatusDot } from "@/components/ui/status-dot";
import { useSidebar } from "./sidebar-provider";
import { useHealth } from "@/lib/queries";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

function HealthPill() {
  const health = useHealth();
  const up = health.data?.ok === true && health.data.db === "up";
  const pending = health.isPending && !health.data;

  return (
    <span
      title={
        up
          ? `api ${health.data?.env ?? ""} · db ${health.data?.db}`
          : (health.error?.message ?? "api unreachable")
      }
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-caption font-medium transition-colors",
        pending && "text-muted-foreground",
        !pending && up && "bg-success/10 text-success",
        !pending && !up && "bg-destructive/10 text-destructive",
      )}
    >
      <StatusDot tone={pending ? "neutral" : up ? "success" : "danger"} pulse={pending} />
      <span className="hidden sm:inline">{pending ? "checking" : up ? "API live" : "API down"}</span>
      <span className="sm:hidden">{pending ? "…" : up ? "live" : "down"}</span>
    </span>
  );
}

export function Topbar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { setMobileOpen } = useSidebar();
  const { theme, toggle } = useTheme();

  return (
    <header className="flex h-header-default shrink-0 items-center gap-2 px-3 sm:gap-3 sm:px-4">
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation"
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-fill hover:text-foreground md:hidden"
      >
        <HugeiconsIcon icon={Menu01Icon} size={17} strokeWidth={1.6} />
      </button>

      <div className="min-w-0 flex-1">
        <Breadcrumbs />
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onOpenPalette}
          className="hidden h-7 items-center gap-2 rounded-full bg-fill-subtle pl-2.5 pr-1.5 text-caption text-muted-foreground shadow-inset transition-colors hover:bg-fill hover:text-foreground lg:inline-flex"
        >
          <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={1.8} />
          <span className="pr-8">Search workspace</span>
          <Kbd>⌘K</Kbd>
        </button>

        <button
          type="button"
          onClick={onOpenPalette}
          aria-label="Open command palette"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-fill hover:text-foreground lg:hidden"
        >
          <HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={1.6} />
        </button>

        <HealthPill />

        <button
          type="button"
          onClick={toggle}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-fill hover:text-foreground"
        >
          <HugeiconsIcon icon={theme === "dark" ? Sun03Icon : Moon02Icon} size={16} strokeWidth={1.6} />
        </button>
      </div>
    </header>
  );
}
