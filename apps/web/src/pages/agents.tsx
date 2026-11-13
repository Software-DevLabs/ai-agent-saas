import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import ArrowRight02Icon from "@hugeicons/core-free-icons/ArrowRight02Icon";
import BotIcon from "@hugeicons/core-free-icons/BotIcon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import Edit01Icon from "@hugeicons/core-free-icons/Edit01Icon";
import FunctionIcon from "@hugeicons/core-free-icons/FunctionIcon";
import PauseIcon from "@hugeicons/core-free-icons/PauseIcon";
import PlayIcon from "@hugeicons/core-free-icons/PlayIcon";
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import { PageTransition } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { AgentFormDialog } from "@/components/agents/agent-form";
import { BentoCard } from "@/components/ui/card";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState, QueryState } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { useAgents, useDeleteAgent, useSetAgentStatus } from "@/lib/queries";
import type { Agent, AgentStatus } from "@/lib/domain";
import { relativeTime } from "@/lib/utils";

const FILTERS = [
  { id: "ALL", label: "All" },
  { id: "DRAFT", label: "Draft" },
  { id: "ACTIVE", label: "Active" },
  { id: "PAUSED", label: "Paused" },
  { id: "ERROR", label: "Error" },
];

function nextStatus(status: AgentStatus): AgentStatus {
  return status === "ACTIVE" ? "PAUSED" : "ACTIVE";
}

/**
 * "Activate" and "Resume" are different claims: a draft has never run for a
 * visitor, a paused agent was switched off. The button says which one it is
 * doing, because the difference is whether the website widget starts answering.
 */
function statusActionLabel(status: AgentStatus): string {
  if (status === "ACTIVE") return "Pause";
  return status === "DRAFT" ? "Activate" : "Resume";
}

function AgentTile({ agent }: { agent: Agent }) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const status = useSetAgentStatus();
  const remove = useDeleteAgent();

  return (
    <>
      <BentoCard className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground">
              <HugeiconsIcon icon={BotIcon} size={15} strokeWidth={1.6} />
            </span>
            <div className="min-w-0">
              <Link to={`/agents/${agent.id}`} className="block truncate text-[14px] font-semibold hover:underline">
                {agent.name}
              </Link>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {agent.modelProvider}/{agent.modelName}
              </p>
            </div>
          </div>
          <StatusBadge status={agent.status} />
        </div>

        <p className="line-clamp-2 min-h-[34px] text-[12.5px] leading-relaxed text-muted-foreground">
          {agent.systemPrompt}
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral">
            <HugeiconsIcon icon={FunctionIcon} size={11} strokeWidth={1.8} />
            temp {agent.temperature.toFixed(2)}
          </Badge>
          <Badge tone="neutral">
            <HugeiconsIcon icon={Task01Icon} size={11} strokeWidth={1.8} />
            {agent.maxOutputTokens} out
          </Badge>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            {relativeTime(agent.createdAt)}
          </span>
        </div>

        <div className="flex items-center gap-1.5 border-t border-border pt-3">
          <Button
            size="sm"
            variant="ghost"
            loading={status.isPending}
            onClick={() => status.mutate({ id: agent.id, status: nextStatus(agent.status) })}
          >
            <HugeiconsIcon
              icon={agent.status === "ACTIVE" ? PauseIcon : PlayIcon}
              size={14}
              strokeWidth={1.6}
            />
            {statusActionLabel(agent.status)}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            <HugeiconsIcon icon={Edit01Icon} size={14} strokeWidth={1.6} />
            Edit
          </Button>
          <Link to={`/agents/${agent.id}`} className="ml-auto">
            <Button size="sm" variant="outline">
              Open
              <HugeiconsIcon icon={ArrowRight02Icon} size={14} strokeWidth={1.6} />
            </Button>
          </Link>
          <Button size="icon" variant="ghost" aria-label="Delete agent" onClick={() => setConfirming(true)}>
            <HugeiconsIcon icon={Delete02Icon} size={15} strokeWidth={1.6} />
          </Button>
        </div>
      </BentoCard>

      {editing && (
        <AgentFormDialog open agent={agent} onClose={() => setEditing(false)} />
      )}
      <ConfirmDialog
        open={confirming}
        danger
        title={`Delete ${agent.name}?`}
        body="Conversations and channel bindings for this agent are removed with it. This cannot be undone."
        confirmLabel="Delete agent"
        busy={remove.isPending}
        onClose={() => setConfirming(false)}
        onConfirm={() =>
          remove.mutate(agent.id, {
            onSuccess: () => setConfirming(false),
          })
        }
      />
    </>
  );
}

export default function AgentsPage() {
  const agents = useAgents();
  const [search, setSearch] = useSearchParams();
  const [filter, setFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(() => search.get("new") === "1");

  // The sidebar's Create menu deep-links here with ?new=1.
  useEffect(() => {
    if (search.get("new") === "1") setCreating(true);
  }, [search]);

  const closeCreate = () => {
    setCreating(false);
    if (search.has("new")) {
      search.delete("new");
      setSearch(search, { replace: true });
    }
  };

  const visible = useMemo(() => {
    const all = agents.data ?? [];
    const needle = query.trim().toLowerCase();
    return all.filter(
      (agent) =>
        (filter === "ALL" || agent.status === filter) &&
        (needle === "" ||
          agent.name.toLowerCase().includes(needle) ||
          agent.modelName.toLowerCase().includes(needle)),
    );
  }, [agents.data, filter, query]);

  const counts = useMemo(() => {
    const all = agents.data ?? [];
    return {
      ALL: all.length,
      DRAFT: all.filter((a) => a.status === "DRAFT").length,
      ACTIVE: all.filter((a) => a.status === "ACTIVE").length,
      PAUSED: all.filter((a) => a.status === "PAUSED").length,
      ERROR: all.filter((a) => a.status === "ERROR").length,
    } as Record<string, number>;
  }, [agents.data]);

  return (
    <PageTransition>
      <div className="space-y-5">
        <PageHeader
          title="Agents"
          description="Each agent is a prompt, a model and a set of channel bindings."
          actions={
            <div className="flex items-center gap-2">
              <label className="relative hidden items-center sm:flex">
                <HugeiconsIcon
                  icon={Search01Icon}
                  size={14}
                  strokeWidth={1.6}
                  className="absolute left-2.5 text-muted-foreground"
                />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter by name or model"
                  className="h-8 w-56 rounded-lg bg-background pl-8 pr-3 text-[12px] shadow-xs placeholder:text-muted-foreground/70"
                />
              </label>
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={1.8} />
                New agent
              </Button>
            </div>
          }
        />

        <Tabs
          tabs={FILTERS.map((tab) => ({ ...tab, count: counts[tab.id] ?? 0 }))}
          active={filter}
          onChange={setFilter}
          className="rounded-lg border border-border bg-card p-1"
        />

        <QueryState error={agents.error} pending={agents.isPending}>
          {visible.length === 0 ? (
            <BentoCard interactive={false} className="bg-card">
              <EmptyState
                title="No agents match"
                body="Clear the filter, or create an agent to start routing messages."
                actionLabel="New agent"
                onAction={() => setCreating(true)}
              />
            </BentoCard>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {visible.map((agent) => (
                <AgentTile key={agent.id} agent={agent} />
              ))}
            </div>
          )}
        </QueryState>
      </div>

      <AgentFormDialog open={creating} onClose={closeCreate} />
    </PageTransition>
  );
}
