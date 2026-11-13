import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import Analytics01Icon from "@hugeicons/core-free-icons/Analytics01Icon";
import ApiIcon from "@hugeicons/core-free-icons/ApiIcon";
import BotIcon from "@hugeicons/core-free-icons/BotIcon";
import ReceiptIcon from "@hugeicons/core-free-icons/ReceiptIcon";
import ArrowRight02Icon from "@hugeicons/core-free-icons/ArrowRight02Icon";
import { PageTransition } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/dashboard/stat";
import { UsageChart } from "@/components/dashboard/usage-chart";
import { BentoCard, Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { StatusBadge, Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QueryState } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { LiveAgentsStrip } from "@/components/activity/live-agents-strip";
import { useOverview } from "@/lib/queries";
import { formatTokens, formatUsd, relativeTime } from "@/lib/utils";

// The API returns a fixed 14-day window (reads.ts DAILY_DAYS), so the control
// only offers ranges that exist rather than promising 30 days of data.
const RANGES = [
  { id: "7", label: "7d" },
  { id: "14", label: "14d" },
];

function percentChange(values: number[]): number {
  if (values.length < 4) return 0;
  const half = Math.floor(values.length / 2);
  const first = values.slice(0, half).reduce((a, b) => a + b, 0);
  const second = values.slice(half).reduce((a, b) => a + b, 0);
  if (first === 0) return 0;
  return ((second - first) / first) * 100;
}

export default function OverviewPage() {
  const overview = useOverview();
  const [range, setRange] = useState("14");

  const daily = useMemo(() => {
    const days = Number(range);
    return overview.data?.daily.slice(-days) ?? [];
  }, [overview.data, range]);

  const data = overview.data;
  const quotaUsed = data ? data.tokensUsedThisCycle / Number(data.plan.tokenQuota) : 0;

  return (
    <PageTransition>
      <div className="space-y-5">
        <PageHeader
          title="Overview"
          description={`Cycle health for ${data?.tenant.name ?? "this workspace"} — every number below is read from the tenant's own rows.`}
          meta={data ? <Badge tone="primary">{data.plan.name}</Badge> : undefined}
        />
        <QueryState error={overview.error} pending={overview.isPending}>
          {data && (
            <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard
                label="Tokens this cycle"
                value={data.tokensUsedThisCycle}
                format={formatTokens}
                delta={percentChange(daily.map((d) => d.tokens))}
                icon={Analytics01Icon}
                hint={`${formatTokens(data.tokensRemaining)} of ${formatTokens(Number(data.plan.tokenQuota))} left`}
              />
              <StatCard
                label="Active agents"
                value={data.agents.active}
                icon={BotIcon}
                hint={`${data.agents.total} total · ${data.agents.error} in error`}
              />
              <StatCard
                label="Connected channels"
                value={data.integrations.connected}
                icon={ApiIcon}
                hint={`of ${data.integrations.limit} allowed on ${data.plan.name}`}
              />
              <StatCard
                label="Estimated cost"
                value={data.costThisCycleUsd}
                format={formatUsd}
                icon={ReceiptIcon}
                hint="Ollama is self-hosted — estimate only"
              />
            </div>

            <LiveAgentsStrip />

            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Token throughput</CardTitle>
                    <CardDescription>Daily model tokens across every agent in this tenant</CardDescription>
                  </div>
                  <Tabs tabs={RANGES} active={range} onChange={setRange} />
                </CardHeader>
                <CardContent>
                  <UsageChart points={daily} />
                </CardContent>
              </Card>

              <div className="space-y-4">
                <BentoCard interactive={false}>
                  <p className="text-[12px] font-medium text-muted-foreground">Cycle usage</p>
                  <p className="mt-2 font-mono text-[22px] tabular leading-none">
                    {formatTokens(data.tokensUsedThisCycle)}
                    <span className="ml-1 text-[13px] text-muted-foreground">
                      / {formatTokens(Number(data.plan.tokenQuota))}
                    </span>
                  </p>
                  <Progress
                    className="mt-3"
                    value={quotaUsed}
                    tone={quotaUsed > 0.9 ? "danger" : quotaUsed > 0.7 ? "warning" : "primary"}
                  />
                  <dl className="mt-4 space-y-2 text-[12px]">
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Resets</dt>
                      <dd className="font-mono">{new Date(data.tenant.cycleResetAt).toLocaleDateString("en-US")}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Integrations</dt>
                      <dd className="font-mono">
                        {data.integrations.total} / {data.integrations.limit}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Plan</dt>
                      <dd>
                        <Badge tone="primary">{data.plan.name}</Badge>
                      </dd>
                    </div>
                  </dl>
                  <Link to="/billing">
                    <Button variant="outline" size="sm" className="mt-4 w-full">
                      Manage plan
                      <HugeiconsIcon icon={ArrowRight02Icon} size={14} strokeWidth={1.6} />
                    </Button>
                  </Link>
                </BentoCard>

                <BentoCard interactive={false} className="p-0">
                  <div className="flex items-start gap-3 px-5 pb-3 pt-5">
                    <HugeiconsIcon icon={AlertCircleIcon} size={17} className="mt-0.5 text-destructive" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold">Pipeline failures</p>
                      <p className="text-[12px] text-muted-foreground">
                        {data.failingEvents.length} event{data.failingEvents.length === 1 ? "" : "s"} need attention
                      </p>
                    </div>
                    <Link to="/runs">
                      <Button variant="ghost" size="sm">
                        View
                      </Button>
                    </Link>
                  </div>
                  <ul className="max-h-[168px] overflow-y-auto border-t border-border">
                    {data.failingEvents.slice(0, 6).map((event) => (
                      <li
                        key={event.id}
                        className="flex items-center justify-between gap-3 border-b px-5 py-2.5 last:border-0"
                      >
                        <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground">
                          {event.source}/{event.externalMessageId}
                        </span>
                        <StatusBadge status={event.status} />
                      </li>
                    ))}
                    {data.failingEvents.length === 0 && (
                      <li className="px-5 py-6 text-center text-[12px] text-muted-foreground">
                        Nothing failing — queue is clean.
                      </li>
                    )}
                  </ul>
                </BentoCard>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Recent conversations</CardTitle>
                    <CardDescription>Threads touched by an agent, newest first</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="divide-y divide-border p-0">
                  {data.recentConversations.map((conversation) => (
                    <div key={conversation.id} className="flex items-center gap-3 px-5 py-3">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <HugeiconsIcon icon={BotIcon} size={14} strokeWidth={1.6} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px]">{conversation.lastMessagePreview}</p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {conversation.externalChatId} · {conversation.messageCount} msgs ·{" "}
                          {relativeTime(conversation.updatedAt)}
                        </p>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Ledger tail</CardTitle>
                    <CardDescription>Last metered events — the ledger is the billing truth</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <ul className="divide-y divide-border">
                    {data.recentUsage.map((event) => (
                      <li key={event.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-[13px]">{event.kind.replace("_", " ").toLowerCase()}</p>
                          <p className="truncate font-mono text-[11px] text-muted-foreground">
                            {event.agentId ?? "system"} · {relativeTime(event.createdAt)}
                          </p>
                        </div>
                        <span className="shrink-0 font-mono text-[12px] tabular">
                          {formatTokens(event.tokensUsed)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="border-t border-border px-5 py-3">
                    <Link to="/usage" className="text-[12px] font-medium text-primary hover:underline">
                      Open full usage view →
                    </Link>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
        </QueryState>
      </div>
    </PageTransition>
  );
}
