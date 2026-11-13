import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import Analytics01Icon from "@hugeicons/core-free-icons/Analytics01Icon";
import Coins01Icon from "@hugeicons/core-free-icons/Coins01Icon";
import Download01Icon from "@hugeicons/core-free-icons/Download01Icon";
import TrendingUpIcon from "@hugeicons/core-free-icons/TrendingUpIcon";
import { PageTransition } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/dashboard/stat";
import { UsageChart } from "@/components/dashboard/usage-chart";
import { BentoCard, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { QueryState } from "@/components/ui/states";
import { THead, TR, Table, TD, TH } from "@/components/ui/table";
import { Select } from "@/components/ui/field";
import { useAgents, useOverview, useUsageEvents } from "@/lib/queries";
import { formatPercent, formatTokens, formatUsd, formatDate } from "@/lib/utils";

export default function UsagePage() {
  const events = useUsageEvents();
  const agents = useAgents();
  const overview = useOverview();
  const [agentFilter, setAgentFilter] = useState("ALL");
  const [kindFilter, setKindFilter] = useState("ALL");

  const filtered = useMemo(() => {
    const all = (events.data ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return all.filter(
      (event) =>
        (agentFilter === "ALL" || event.agentId === agentFilter) &&
        (kindFilter === "ALL" || event.kind === kindFilter),
    );
  }, [events.data, agentFilter, kindFilter]);

  const byAgent = useMemo(() => {
    const totals = new Map<string, number>();
    for (const event of filtered) {
      const key = event.agentId ?? "system";
      totals.set(key, (totals.get(key) ?? 0) + event.tokensUsed);
    }
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const peak = sorted[0]?.[1] ?? 1;
    return sorted.map(([id, tokens]) => ({ id, tokens, ratio: tokens / peak }));
  }, [filtered]);

  const totalTokens = filtered.reduce((sum, event) => sum + event.tokensUsed, 0);
  const totalCost = filtered.reduce((sum, event) => sum + event.costUsdEstimate, 0);
  const data = overview.data;

  function exportCsv() {
    const header = "id,agentId,kind,tokensUsed,costUsdEstimate,createdAt";
    const rows = filtered.map((event) =>
      [event.id, event.agentId ?? "", event.kind, event.tokensUsed, event.costUsdEstimate, event.createdAt].join(","),
    );
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `usage-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <PageTransition>
      <div className="space-y-5">
        <PageHeader
          title="Usage"
          description="Metered from the provider response, never estimated from the prompt."
          actions={
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={filtered.length === 0}>
              <HugeiconsIcon icon={Download01Icon} size={14} strokeWidth={1.6} />
              Export CSV
            </Button>
          }
        />

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Tokens in view" value={totalTokens} format={formatTokens} icon={Analytics01Icon} />
          <StatCard label="Est. cost in view" value={totalCost} format={formatUsd} icon={Coins01Icon} />
          <StatCard
            label="Ledger events"
            value={filtered.length}
            icon={TrendingUpIcon}
            hint={`${(events.data ?? []).length} recorded in total`}
          />
          <StatCard
            label="Quota remaining"
            value={data ? data.tokensRemaining : 0}
            format={formatTokens}
            icon={Analytics01Icon}
            hint={data ? `${formatPercent(data.tokensRemaining / Number(data.plan.tokenQuota))} of plan` : undefined}
          />
        </div>

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Tokens per day</CardTitle>
                <CardDescription>All agents, one row per day the ledger saw activity</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <UsageChart points={data?.daily ?? []} />
            </CardContent>
          </Card>

          <BentoCard interactive={false}>
            <p className="text-[12px] font-medium text-muted-foreground">Share by agent</p>
            {data && (
              <>
                <Progress
                  className="mt-3"
                  value={data.tokensUsedThisCycle / Number(data.plan.tokenQuota)}
                  tone={data.tokensRemaining < 200_000 ? "danger" : "primary"}
                />
                <p className="mt-2 text-[11.5px] text-muted-foreground">
                  {formatTokens(data.tokensUsedThisCycle)} of {formatTokens(Number(data.plan.tokenQuota))} used this
                  cycle
                </p>
              </>
            )}
            <ul className="mt-4 space-y-3">
              {byAgent.map((row) => {
                const name = (agents.data ?? []).find((agent) => agent.id === row.id)?.name ?? row.id;
                return (
                  <li key={row.id} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[12.5px]">{name}</span>
                      <span className="shrink-0 font-mono text-[11.5px] tabular text-muted-foreground">
                        {formatTokens(row.tokens)}
                      </span>
                    </div>
                    <Progress value={row.ratio} tone="primary" className="h-1" />
                  </li>
                );
              })}
              {byAgent.length === 0 && <li className="text-[12px] text-muted-foreground">Nothing metered yet.</li>}
            </ul>
          </BentoCard>
        </div>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Ledger</CardTitle>
              <CardDescription>Immutable rows — this is what billing reconciles against.</CardDescription>
            </div>
            <div className="flex gap-2">
              <Select
                aria-label="Filter by agent"
                value={agentFilter}
                onChange={(event) => setAgentFilter(event.target.value)}
                className="h-8 w-44 text-[12px]"
              >
                <option value="ALL">All agents</option>
                {(agents.data ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Filter by kind"
                value={kindFilter}
                onChange={(event) => setKindFilter(event.target.value)}
                className="h-8 w-40 text-[12px]"
              >
                <option value="ALL">All kinds</option>
                <option value="MODEL_CALL">model call</option>
                <option value="CLASSIFY">sentiment classify</option>
                <option value="CONNECTOR_WRITE">connector write</option>
                <option value="QUOTA_RESET">quota reset</option>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <QueryState error={events.error} pending={events.isPending}>
              <Table>
                <THead>
                  <TR>
                    <TH>When</TH>
                    <TH>Agent</TH>
                    <TH>Kind</TH>
                    <TH className="text-right">Tokens</TH>
                    <TH className="text-right">Est. cost</TH>
                    <TH>Metadata</TH>
                  </TR>
                </THead>
                <tbody>
                  {filtered.slice(0, 25).map((event) => (
                      <TR key={event.id}>
                        <TD className="whitespace-nowrap text-[12px] text-muted-foreground">
                          {formatDate(event.createdAt)}
                        </TD>
                        <TD className="text-[12.5px]">{event.agentName ?? event.agentId ?? "system"}</TD>
                        <TD>
                          <Badge tone={event.kind === "MODEL_CALL" ? "primary" : event.kind === "CLASSIFY" ? "info" : "neutral"}>
                            {event.kind.toLowerCase().replace("_", " ")}
                          </Badge>
                        </TD>
                        <TD className="text-right font-mono tabular">{event.tokensUsed.toLocaleString("en-US")}</TD>
                        <TD className="text-right font-mono tabular text-muted-foreground">
                          {event.costUsdEstimate > 0 ? formatUsd(event.costUsdEstimate) : "—"}
                        </TD>
                        <TD className="max-w-[240px] truncate font-mono text-[11px] text-muted-foreground">
                          {JSON.stringify(event.metadata)}
                        </TD>
                      </TR>
                  ))}
                </tbody>
              </Table>
            </QueryState>
          </CardContent>
        </Card>
      </div>
    </PageTransition>
  );
}
