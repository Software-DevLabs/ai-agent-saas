import { motion } from "motion/react";
import { cn } from "@/lib/utils";

export interface TabItem {
  id: string;
  label: string;
  count?: number;
}

export function Tabs({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  const group = tabs.map((t) => t.id).join("-");
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 overflow-x-auto rounded-lg bg-fill-subtle p-0.5 shadow-inset",
        className,
      )}
      role="tablist"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={cn(
              "relative h-control-sm shrink-0 rounded-md px-3 text-menu transition-colors duration-200",
              selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {selected && (
              <motion.span
                layoutId={`tab-pill-${group}`}
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
                className="absolute inset-0 rounded-md bg-background-3 shadow-xs"
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {tab.label}
              {typeof tab.count === "number" && (
                <span className="font-mono text-meta tabular text-muted-foreground">{tab.count}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
