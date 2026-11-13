import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import ArrowRight02Icon from "@hugeicons/core-free-icons/ArrowRight02Icon";
import BotIcon from "@hugeicons/core-free-icons/BotIcon";
import Edit01Icon from "@hugeicons/core-free-icons/Edit01Icon";
import PauseIcon from "@hugeicons/core-free-icons/PauseIcon";
import PlayIcon from "@hugeicons/core-free-icons/PlayIcon";
import { PageTransition } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { AgentFormDialog } from "@/components/agents/agent-form";
import { CapabilitiesPanel } from "@/components/agents/capabilities-panel";
import { EmbedPanel } from "@/components/agents/embed-panel";
import { KnowledgePanel } from "@/components/agents/knowledge-panel";
import { SitePanel } from "@/components/agents/site-panel";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { BentoCard, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-dot";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { EmptyState, QueryState } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import {
  CHANNEL_CATALOG,
  useActivity,
  useAgent,
  useAgentBindings,
  useAttachChannel,
  useDetachChannel,
  useIntegrations,
  useSetAgentStatus,
  useUsageEvents,
} from "@/lib/queries";
import { formatTokens, formatDate } from "@/lib/utils";

const TABS = [
  { id: "behaviour", label: "Behaviour" },
  { id: "capabilities", label: "Capabilities" },
  { id: "knowledge", label: "Knowledge" },
  { id: "site", label: "Site" },
  { id: "embed", label: "Embed" },
  { id: "activity", label: "Activity" },
  { id: "channels", label: "Channels" },
  { id: "usage", label: "Usage" },
];

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const agent = useAgent(id);
  const bindings = useAgentBindings(id);
  const events = useUsageEvents();
  const status = useSetAgentStatus();
  const detach = useDetachChannel();
  const attach = useAttachChannel();
  const integrations = useIntegrations();
  // One row is enough: the header only needs to know whether anything is moving.
  // It waits for the agent row so an unscoped poll can never claim this agent is busy.
  const liveRuns = useActivity(
    { agentId: agent.data?.id, status: "RUNNING", limit: 1 },
    { enabled: Boolean(agent.data?.id) },
  );
  const [attachId, setAttachId] = useState("");
  const [tab, setTab] = useState("behaviour");
  const [editing, setEditing] = useState(false);

  const bound = new Set((bindings.data ?? []).map(({ integration }) => integration.id));
  const available = (integrations.data ?? []).filter((integration) => !bound.has(integration.id));

  const agentEvents = (events.data ?? []).filter((event) => event.agentId === agent.data?.id);
  const agentTokens = agentEvents.reduce((sum, event) => sum + event.tokensUsed, 0);

  return (
    <PageTransition>
      <QueryState error={agent.error} pending={agent.isPending}>
        {agent.data && (
          <div className="space-y-5">
            <PageHeader
              title={agent.data.name}
              leading={
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-primary shadow-card">
                  <HugeiconsIcon icon={BotIcon} size={20} strokeWidth={1.5} />
                </span>
              }
              meta={
                <>
                  <StatusBadge status={agent.data.status} />
                  {liveRuns.data?.length ? (
                    <Badge tone="info">
                      <StatusDot tone="active" pulse />
                      running now
                    </Badge>
                  ) : null}
                </>
              }
              description={
                <span className="font-mono text-[12px]">
                  {agent.data.id} · created {formatDate(agent.data.createdAt)}
                </span>
              }
              actions={
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    loading={status.isPending}
                    onClick={() =>
                      status.mutate({
                        id: agent.data!.id,
                        status: agent.data!.status === "ACTIVE" ? "PAUSED" : "ACTIVE",
                      })
                    }
                  >
                    <HugeiconsIcon
                      icon={agent.data.status === "ACTIVE" ? PauseIcon : PlayIcon}
                      size={14}
                      strokeWidth={1.6}
                    />
                    {agent.data.status === "ACTIVE"
                      ? "Pause agent"
                      : agent.data.status === "DRAFT"
                        ? "Activate agent"
                        : "Resume agent"}
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => setEditing(true)}>
                    <HugeiconsIcon icon={Edit01Icon} size={14} strokeWidth={1.6} />
                    Edit
                  </Button>
                </>
              }
            />

            <div className="grid gap-4 sm:grid-cols-3">
              <BentoCard interactive={false}>
                <p className="text-[12px] text-muted-foreground">Model</p>
                <p className="mt-1.5 truncate font-mono text-[14px]">{agent.data.modelName}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">provider {agent.data.modelProvider}</p>
              </BentoCard>
              <BentoCard interactive={false}>
                <p className="text-[12px] text-muted-foreground">Sampling</p>
                <p className="mt-1.5 font-mono text-[14px] tabular">temp {agent.data.temperature.toFixed(2)}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  max {agent.data.maxOutputTokens} out · ≤{agent.data.maxToolSteps} rounds
                  {agent.data.perTurnTokenBudget > 0 ? ` · ${formatTokens(agent.data.perTurnTokenBudget)}/turn` : ""}
                  {agent.data.dailyTokenBudget > 0 ? ` · ${formatTokens(agent.data.dailyTokenBudget)}/day` : ""}
                </p>
              </BentoCard>
              <BentoCard interactive={false}>
                <p className="text-[12px] text-muted-foreground">Tokens metered</p>
                <p className="mt-1.5 font-mono text-[14px] tabular">{formatTokens(agentTokens)}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{agentEvents.length} ledger events</p>
              </BentoCard>
            </div>

            <Tabs
              tabs={TABS}
              active={tab}
              onChange={setTab}
              className="w-fit rounded-lg border border-border bg-card p-1"
            />

            {tab === "behaviour" && (
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>System prompt</CardTitle>
                    <CardDescription>
                      What you write here. The turn sends this plus the skill catalogue, the unavailable list and the
                      output contract the assembler appends — Capabilities shows the assembled text.
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-4 font-mono text-[12.5px] leading-relaxed text-foreground/90">
                    {agent.data.systemPrompt}
                  </pre>
                </CardContent>
              </Card>
            )}

            {tab === "capabilities" && agent.data && <CapabilitiesPanel agentId={agent.data.id} />}

            {tab === "knowledge" && agent.data && <KnowledgePanel agentId={agent.data.id} />}
            {tab === "site" && agent.data && <SitePanel agentId={agent.data.id} />}

            {tab === "embed" && agent.data && (
              <EmbedPanel agentId={agent.data.id} agentActive={agent.data.status === "ACTIVE"} />
            )}

            {tab === "activity" && agent.data && (
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Activity</CardTitle>
                    <CardDescription>
                      Direct turns and the workflow nodes that delegated to this agent, newest first.
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <ActivityFeed agentId={agent.data.id} limit={25} />
                </CardContent>
              </Card>
            )}

            {tab === "channels" && (
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Channel bindings</CardTitle>
                    <CardDescription>
                      Input channels feed this agent; output channels receive its replies.
                    </CardDescription>
                  </div>
                  <Link to="/connections">
                    <Button variant="ghost" size="sm">
                      Manage
                      <HugeiconsIcon icon={ArrowRight02Icon} size={14} strokeWidth={1.6} />
                    </Button>
                  </Link>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-2">
                  {(bindings.data ?? []).length === 0 ? (
                    <EmptyState
                      title="No channels bound"
                      body="Connect a channel, then bind it to this agent. A binding row is written in the channel's direction."
                    />
                  ) : (
                    (bindings.data ?? []).map(({ integration, direction }) => {
                      const meta = CHANNEL_CATALOG.find((entry) => entry.type === integration.type);
                      return (
                        <div key={integration.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-medium">{meta?.label ?? integration.type}</p>
                            <p className="truncate font-mono text-[11px] text-muted-foreground">
                              {integration.externalId ?? "no external id"}
                            </p>
                            <p className="truncate font-mono text-[11px] text-muted-foreground">
                              {integration.credentialPreview ?? "no secret stored"}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge tone="neutral">{direction === "INPUT" ? "in" : "out"}</Badge>
                            <StatusBadge status={integration.status} />
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={detach.isPending}
                              onClick={() => detach.mutate({ agentId: agent.data!.id, integrationId: integration.id })}
                            >
                              Unbind
                            </Button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </CardContent>
                <CardFooter className="flex-wrap gap-3">
                  {available.length === 0 ? (
                    <p className="text-[12px] text-muted-foreground">
                      Every connection in this workspace is already bound to the agent.
                    </p>
                  ) : (
                    <>
                      <Select
                        aria-label="Connection to bind"
                        value={attachId}
                        onChange={(event) => setAttachId(event.target.value)}
                        className="h-8 w-56 text-[12px]"
                      >
                        <option value="">Choose a connection</option>
                        {available.map((integration) => (
                          <option key={integration.id} value={integration.id}>
                            {CHANNEL_CATALOG.find((entry) => entry.type === integration.type)?.label ??
                              integration.type}
                            {integration.externalId ? ` · ${integration.externalId}` : ""}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={attachId === ""}
                        loading={attach.isPending}
                        onClick={() => {
                          const chosen = available.find((integration) => integration.id === attachId);
                          if (!chosen || !agent.data) return;
                          attach.mutate(
                            {
                              agentId: agent.data.id,
                              integrationId: chosen.id,
                              direction:
                                CHANNEL_CATALOG.find((entry) => entry.type === chosen.type)?.direction ?? "INPUT",
                            },
                            { onSuccess: () => setAttachId("") },
                          );
                        }}
                      >
                        Bind channel
                      </Button>
                    </>
                  )}
                </CardFooter>
              </Card>
            )}

            {tab === "usage" && (
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Ledger events</CardTitle>
                    <CardDescription>Newest metered events for this agent.</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  {agentEvents.length === 0 ? (
                    <EmptyState title="No metered events" body="Nothing has been recorded for this agent yet." />
                  ) : (
                    <ul className="divide-y divide-border">
                      {agentEvents.slice(0, 12).map((event) => (
                        <li key={event.id} className="flex items-center justify-between px-5 py-2.5 text-[13px]">
                          <span className="font-mono text-[12px] text-muted-foreground">
                            {formatDate(event.createdAt)}
                          </span>
                          <span className="flex items-center gap-3">
                            <Badge tone="neutral">{event.kind.toLowerCase()}</Badge>
                            <span className="font-mono tabular">{formatTokens(event.tokensUsed)}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </QueryState>

      {editing && agent.data && (
        <AgentFormDialog open agent={agent.data} onClose={() => setEditing(false)} />
      )}
    </PageTransition>
  );
}
