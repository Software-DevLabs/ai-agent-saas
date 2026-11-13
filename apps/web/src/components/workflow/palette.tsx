import { memo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import AddIcon from "@hugeicons/core-free-icons/Add01Icon";
import AiNetworkIcon from "@hugeicons/core-free-icons/AiNetworkIcon";
import BotIcon from "@hugeicons/core-free-icons/BotIcon";
import LoginIcon from "@hugeicons/core-free-icons/LoginIcon";
import LogoutIcon from "@hugeicons/core-free-icons/LogoutIcon";
import type { Agent, Integration, NodeKind } from "@/lib/domain";
import { CHANNEL_CATALOG } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * The only things that can be put on this canvas: this project's channels and
 * this project's agents, split by the direction the channel type itself carries.
 *
 * Nothing else is offered, which is the first half of the rule "a workflow can
 * only wire up what its project owns". The second half is the server's
 * `agent_outside_project` validation — a palette that hides a row is a
 * convenience, and only the check is a guarantee.
 */

export const DRAG_MIME = "application/x-saas-node";

export interface PaletteItem {
  kind: NodeKind;
  refId: string;
  name: string;
  meta: string;
  channelType: string | null;
}

const ICONS = {
  INBOUND: LoginIcon,
  AGENT: BotIcon,
  OUTBOUND: LogoutIcon,
  ORCHESTRATOR: AiNetworkIcon,
} as const;

function directionOf(type: Integration["type"]): "INPUT" | "OUTPUT" | null {
  return CHANNEL_CATALOG.find((entry) => entry.type === type)?.direction ?? null;
}

/** The project's rows, shaped into what each rail of the palette should show. */
export function buildPalette(agents: Agent[] = [], integrations: Integration[] = []) {
  const inbound: PaletteItem[] = [];
  const outbound: PaletteItem[] = [];
  for (const integration of integrations) {
    const spec = CHANNEL_CATALOG.find((entry) => entry.type === integration.type);
    const item: PaletteItem = {
      kind: integration.type.endsWith("_IN") ? "INBOUND" : "OUTBOUND",
      refId: integration.id,
      name: spec?.label ?? integration.type,
      meta: integration.externalId ?? integration.type,
      channelType: integration.type,
    };
    if (directionOf(integration.type) === "INPUT") inbound.push(item);
    else if (directionOf(integration.type) === "OUTPUT") outbound.push(item);
    // A type the catalog does not classify is not shown at all: guessing that a
    // new connector points inbound would wire cables the server then refuses.
  }
  const agentItems: PaletteItem[] = agents.map((agent) => ({
    kind: "AGENT",
    refId: agent.id,
    name: agent.name,
    meta: `${agent.modelProvider}/${agent.modelName}`,
    channelType: null,
  }));
  // An orchestrator is the same agent row with a different role in the graph:
  // it delegates to declared subagents instead of answering alone.
  const orchestratorItems: PaletteItem[] = agents.map((agent) => ({
    kind: "ORCHESTRATOR",
    refId: agent.id,
    name: agent.name,
    meta: `delegates · ${agent.modelProvider}/${agent.modelName}`,
    channelType: null,
  }));
  return { inbound, agents: agentItems, orchestrators: orchestratorItems, outbound };
}

const Item = memo(function Item({ item, onAdd }: { item: PaletteItem; onAdd: (item: PaletteItem) => void }) {
  return (
    /**
     * A plain div, not a `BentoCard`: the tile lifts 2px on hover, and a tile
     * that moves 2px under the pointer mid-drag misplaces the drop it is carrying.
     */
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_MIME, JSON.stringify(item));
        event.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "group flex items-center gap-2 rounded-lg border border-border bg-background/60 px-2.5 py-2",
        "cursor-grab active:cursor-grabbing hover:border-foreground/20 hover:bg-accent/60",
      )}
    >
      <HugeiconsIcon icon={ICONS[item.kind]} size={14} strokeWidth={1.6} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium leading-tight">{item.name}</span>
        <span className="block truncate font-mono text-[10px] leading-tight text-muted-foreground">{item.meta}</span>
      </span>
      {/* The keyboard route in: the same node, added with a click instead of a drag. */}
      <button
        type="button"
        aria-label={`Add ${item.name} to the canvas`}
        onClick={() => onAdd(item)}
        className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
      >
        <HugeiconsIcon icon={AddIcon} size={14} strokeWidth={1.8} />
      </button>
    </div>
  );
});

function Section({
  title,
  hint,
  items,
  empty,
  onAdd,
}: {
  title: string;
  hint?: string;
  items: PaletteItem[];
  empty: string;
  onAdd: (item: PaletteItem) => void;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {hint && <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={`${item.kind}:${item.refId}`}>
              <Item item={item} onAdd={onAdd} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Palette({
  agents,
  integrations,
  onAdd,
  className,
}: {
  agents: Agent[];
  integrations: Integration[];
  onAdd: (item: PaletteItem) => void;
  /** The board passes `h-full` for the desktop rail; a sheet lets it size itself. */
  className?: string;
}) {
  const palette = buildPalette(agents, integrations);
  return (
    <div className={cn("flex w-full flex-col gap-5 overflow-y-auto bg-card/60 p-3.5", className)}>
      <div>
        <p className="text-[13px] font-semibold tracking-tight">Add to canvas</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          Drag onto the board, or use the plus button. Only rows in this project are listed.
        </p>
      </div>

      <Section
        title="Channels in"
        items={palette.inbound}
        empty="No inbound channel in this project. A connection stores one credential and belongs to exactly one project."
        onAdd={onAdd}
      />
      <Section
        title="Agents"
        items={palette.agents}
        empty="No agent in this project yet. Create one and it lands here."
        onAdd={onAdd}
      />
      <Section
        title="Orchestrators"
        hint="One agent that delegates to declared subagents through a tool call. Activation requires a tool-capable model on every agent involved; one orchestrator per graph."
        items={palette.orchestrators}
        empty="No agent in this project yet. An orchestrator is built from an existing agent."
        onAdd={onAdd}
      />
      <Section
        title="Channels out"
        items={palette.outbound}
        empty="No outbound channel in this project yet."
        onAdd={onAdd}
      />
    </div>
  );
}
