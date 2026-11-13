// Per-icon subpath imports: the barrel is ~6k icon modules and no build needs
// all of them in the chunk that renders the rail.
import ApiIcon from "@hugeicons/core-free-icons/ApiIcon";
import BotIcon from "@hugeicons/core-free-icons/BotIcon";
import ChartLineIcon from "@hugeicons/core-free-icons/ChartLineIcon";
import CommandLineIcon from "@hugeicons/core-free-icons/CommandLineIcon";
import DashboardSquare01Icon from "@hugeicons/core-free-icons/DashboardSquare01Icon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import GaugeIcon from "@hugeicons/core-free-icons/GaugeIcon";
import ReceiptIcon from "@hugeicons/core-free-icons/ReceiptIcon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import type { IconSvgElement } from "@hugeicons/react";

export interface NavItem {
  to: string;
  label: string;
  icon: IconSvgElement;
  hint: string;
}

export interface NavSection {
  key: "console" | "build" | "account";
  label: string;
  items: NavItem[];
}

/**
 * Grouped by what the user is doing, not by data model. `NAV_ITEMS` stays the
 * flat list so the topbar and the command palette can resolve a pathname to a
 * label without walking the sections.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    key: "console",
    label: "Console",
    items: [
      { to: "/", label: "Overview", icon: DashboardSquare01Icon, hint: "Cycle health at a glance" },
      { to: "/runs", label: "Runs", icon: CommandLineIcon, hint: "Webhook pipeline" },
      { to: "/usage", label: "Usage", icon: ChartLineIcon, hint: "Token ledger" },
    ],
  },
  {
    key: "build",
    label: "Build",
    items: [
      { to: "/projects", label: "Projects", icon: Folder01Icon, hint: "Agents, channels, workflows" },
      { to: "/agents", label: "Agents", icon: BotIcon, hint: "Prompts, models, status" },
      { to: "/skills", label: "Skills", icon: Task01Icon, hint: "Instructions an agent reads on demand" },
      { to: "/connections", label: "Connections", icon: ApiIcon, hint: "Channels and sinks" },
      { to: "/playground", label: "Playground", icon: GaugeIcon, hint: "Talk to an agent" },
    ],
  },
  {
    key: "account",
    label: "Account",
    items: [
      { to: "/billing", label: "Billing", icon: ReceiptIcon, hint: "Plan and quota" },
      { to: "/settings", label: "Settings", icon: Settings01Icon, hint: "Tenant and members" },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

/** The nav item whose route a pathname belongs to, longest prefix first. */
export function activeNavItem(pathname: string): NavItem | undefined {
  return [...NAV_ITEMS]
    .sort((a, b) => b.to.length - a.to.length)
    .find((item) => (item.to === "/" ? pathname === "/" : pathname === item.to || pathname.startsWith(`${item.to}/`)));
}
