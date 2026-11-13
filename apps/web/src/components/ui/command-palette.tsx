import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import Moon02Icon from "@hugeicons/core-free-icons/Moon02Icon";
import Sun03Icon from "@hugeicons/core-free-icons/Sun03Icon";
import PanelLeftIcon from "@hugeicons/core-free-icons/PanelLeftIcon";
import { NAV_ITEMS } from "../layout/nav";
import { useSidebar } from "../layout/sidebar-provider";
import { useAgents, useProjects } from "@/lib/queries";
import { useTheme } from "@/lib/theme";
import { useOverlay } from "@/lib/overlay";
import { Kbd } from "./kbd";

const ROW =
  "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-body-sm text-foreground data-[selected=true]:bg-fill data-[selected=true]:text-foreground";
const HINT = "ml-auto shrink-0 font-mono text-meta text-muted-foreground";

/**
 * ⌘K. Pages are static; projects and agents are real rows fetched only while
 * the palette is open, so a closed palette costs the console nothing. Every
 * entry navigates somewhere that exists.
 */
export function CommandPalette({
  open,
  onOpen,
  onClose,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const projects = useProjects({ enabled: open });
  const agents = useAgents({ enabled: open });
  const { theme, toggle } = useTheme();
  const { collapsed, toggleCollapsed } = useSidebar();
  const panel = useRef<HTMLDivElement>(null);
  useOverlay(open, panel, onClose);
  const reduce = useReducedMotion();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) onClose();
        else onOpen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpen, onClose]);

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[10vh] sm:pt-[14vh]">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={onClose}
            className="absolute inset-0 bg-scrim"
            aria-hidden="true"
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            initial={reduce ? false : { opacity: 0, y: -8, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ type: "spring", stiffness: 380, damping: 34 }}
            className="relative w-full max-w-xl overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-overlay"
          >
            <Command label="Command palette" loop className="flex max-h-[min(64vh,460px)] flex-col">
              <div className="flex h-11 items-center gap-2.5 border-b px-3.5">
                <HugeiconsIcon icon={Search01Icon} size={16} strokeWidth={1.6} className="text-muted-foreground" />
                <Command.Input
                  autoFocus
                  placeholder="Search pages, projects and agents"
                  className="h-full w-full bg-transparent text-body outline-none placeholder:text-muted-foreground/70"
                />
                <Kbd>Esc</Kbd>
              </div>
              <Command.List className="min-h-0 flex-1 overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-eyebrow [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-muted-foreground/70">
                <Command.Empty className="px-2.5 py-6 text-center text-body-sm text-muted-foreground">
                  Nothing matches that search.
                </Command.Empty>

                <Command.Group heading="Pages">
                  {NAV_ITEMS.map((item) => (
                    <Command.Item
                      key={item.to}
                      value={`page ${item.label}`}
                      keywords={[item.hint]}
                      onSelect={() => go(item.to)}
                      className={ROW}
                    >
                      <HugeiconsIcon icon={item.icon} size={16} strokeWidth={1.6} className="text-muted-foreground" />
                      {item.label}
                      <span className={HINT}>{item.to}</span>
                    </Command.Item>
                  ))}
                </Command.Group>

                {(projects.data?.length ?? 0) > 0 && (
                  <Command.Group heading="Projects">
                    {projects.data?.map((project) => (
                      <Command.Item
                        key={project.id}
                        value={`project ${project.name}`}
                        keywords={[project.id]}
                        onSelect={() => go(`/projects/${project.id}`)}
                        className={ROW}
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden="true" />
                        <span className="truncate">{project.name}</span>
                        <span className={HINT}>
                          {project.counts.agents} agents · {project.counts.workflows} flows
                        </span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}

                {(agents.data?.length ?? 0) > 0 && (
                  <Command.Group heading="Agents">
                    {agents.data?.map((agent) => (
                      <Command.Item
                        key={agent.id}
                        value={`agent ${agent.name}`}
                        keywords={[agent.modelName, agent.id]}
                        onSelect={() => go(`/agents/${agent.id}`)}
                        className={ROW}
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden="true" />
                        <span className="truncate">{agent.name}</span>
                        <span className={HINT}>{agent.modelName}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}

                <Command.Group heading="Actions">
                  <Command.Item value="toggle theme" onSelect={toggle} className={ROW}>
                    <HugeiconsIcon
                      icon={theme === "dark" ? Sun03Icon : Moon02Icon}
                      size={16}
                      strokeWidth={1.6}
                      className="text-muted-foreground"
                    />
                    Switch to {theme === "dark" ? "light" : "dark"} theme
                    <HugeiconsIcon icon={ArrowRight01Icon} size={13} className="ml-auto text-muted-foreground" />
                  </Command.Item>
                  <Command.Item value="toggle sidebar" onSelect={toggleCollapsed} className={ROW}>
                    <HugeiconsIcon icon={PanelLeftIcon} size={16} strokeWidth={1.6} className="text-muted-foreground" />
                    {collapsed ? "Expand" : "Collapse"} sidebar
                    <HugeiconsIcon icon={ArrowRight01Icon} size={13} className="ml-auto text-muted-foreground" />
                  </Command.Item>
                </Command.Group>

                {(projects.isFetching || agents.isFetching) && (
                  <p className="px-2.5 py-2 text-caption text-muted-foreground">Loading workspace rows…</p>
                )}
              </Command.List>
              <div className="flex h-8 items-center justify-between border-t px-3.5 text-meta text-muted-foreground">
                <span>Navigate</span>
                <span className="flex items-center gap-2">
                  <span>↑↓ move · ↵ open · esc close</span>
                </span>
              </div>
            </Command>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
