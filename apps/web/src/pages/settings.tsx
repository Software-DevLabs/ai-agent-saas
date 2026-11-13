import { useState } from "react";
import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import DatabaseIcon from "@hugeicons/core-free-icons/DatabaseIcon";
import InfoIcon from "@hugeicons/core-free-icons/InfoIcon";
import LockIcon from "@hugeicons/core-free-icons/LockIcon";
import ReceiptIcon from "@hugeicons/core-free-icons/ReceiptIcon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import { PageTransition } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { BentoCard, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Tabs } from "@/components/ui/tabs";
import { QueryState } from "@/components/ui/states";
import { useOverview, useTenant, useUpdateTenant } from "@/lib/queries";
import { formatDate, formatTokens, shortId } from "@/lib/utils";

const TABS = [
  { id: "tenant", label: "Tenant" },
  { id: "workspace", label: "Workspace data" },
  { id: "unbuilt", label: "Not wired yet" },
];

function Row({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2.5 last:border-0">
      <dt className="shrink-0 text-[12.5px] text-muted-foreground">{label}</dt>
      <dd
        className={
          mono
            ? "truncate text-right font-mono text-[12.5px] tabular"
            : "text-right text-[12.5px] leading-relaxed text-muted-foreground"
        }
      >
        {value}
      </dd>
    </div>
  );
}

export default function SettingsPage() {
  const tenant = useTenant();
  const overview = useOverview();
  const update = useUpdateTenant();
  const [tab, setTab] = useState("tenant");
  const [name, setName] = useState("");

  const effectiveName = name || tenant.data?.name || "";
  const dirty = tenant.data !== undefined && effectiveName !== tenant.data.name;
  const plan = overview.data?.plan;

  return (
    <PageTransition>
      <div className="space-y-5">
        <PageHeader title="Settings" description="What this workspace holds and what the API can actually change." />

        <Tabs tabs={TABS} active={tab} onChange={setTab} className="w-fit rounded-lg border bg-card p-1" />

        <QueryState error={tenant.error} pending={tenant.isPending}>
          {tab === "tenant" && (
            <Card className="max-w-3xl">
              <CardHeader>
                <div>
                  <CardTitle>Tenant</CardTitle>
                  <CardDescription>The billing and isolation boundary — every query is scoped to it.</CardDescription>
                </div>
                <HugeiconsIcon icon={Settings01Icon} size={16} className="text-muted-foreground" />
              </CardHeader>
              <CardContent className="space-y-5">
                <Field
                  label="Workspace name"
                  htmlFor="tenant-name"
                  hint="This is the only tenant field the API writes today (PATCH /tenant)."
                >
                  <Input id="tenant-name" value={effectiveName} onChange={(event) => setName(event.target.value)} />
                </Field>

                <div className="flex items-center justify-between rounded-lg border px-4 py-3">
                  <div>
                    <p className="text-[13px] font-medium">Workspace id</p>
                    <p className="font-mono text-[12px] text-muted-foreground">{tenant.data?.id}</p>
                  </div>
                  <Badge tone="info">{tenant.data?.planName}</Badge>
                </div>

                <div className="flex items-center justify-end gap-2">
                  {update.isSuccess && (
                    <span className="mr-auto text-[12px] text-success">Saved — the row in Postgres now reads this.</span>
                  )}
                  {update.isError && (
                    <span className="mr-auto text-[12px] text-destructive">
                      {update.error instanceof Error ? update.error.message : "the request failed"}
                    </span>
                  )}
                  <Button variant="ghost" onClick={() => setName("")} disabled={!dirty}>
                    Discard
                  </Button>
                  <Button
                    variant="primary"
                    disabled={!dirty}
                    loading={update.isPending}
                    onClick={() => update.mutate(effectiveName)}
                  >
                    Save tenant
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {tab === "workspace" && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Quota and cycle</CardTitle>
                    <CardDescription>Read live from the tenant and plan rows.</CardDescription>
                  </div>
                  <HugeiconsIcon icon={ReceiptIcon} size={16} className="text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <dl className="space-y-0">
                    <Row label="Plan" value={tenant.data?.planName ?? "—"} mono={false} />
                    <Row label="Monthly quota" value={plan ? `${formatTokens(Number(plan.tokenQuota))} tokens` : "—"} />
                    <Row
                      label="Used this cycle"
                      value={overview.data ? `${formatTokens(overview.data.tokensUsedThisCycle)} tokens` : "—"}
                    />
                    <Row
                      label="Balance"
                      value={tenant.data ? `${formatTokens(Number(tenant.data.tokenBalance))} tokens` : "—"}
                    />
                    <Row label="Cycle resets" value={tenant.data ? formatDate(tenant.data.cycleResetAt) : "—"} />
                    <Row label="Workspace created" value={tenant.data ? formatDate(tenant.data.createdAt) : "—"} />
                  </dl>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>What lives here</CardTitle>
                    <CardDescription>Counts from the same scoped queries the pages use.</CardDescription>
                  </div>
                  <HugeiconsIcon icon={DatabaseIcon} size={16} className="text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <dl className="space-y-0">
                    <Row
                      label="Agents"
                      value={overview.data ? `${overview.data.agents.total} (${overview.data.agents.active} active)` : "—"}
                    />
                    <Row
                      label="Connections"
                      value={
                        overview.data
                          ? `${overview.data.integrations.connected} connected / ${overview.data.integrations.limit} allowed`
                          : "—"
                      }
                    />
                    <Row
                      label="Conversations"
                      value={overview.data ? String(overview.data.recentConversations.length) : "—"}
                    />
                    <Row
                      label="Ledger rows (recent)"
                      value={overview.data ? String(overview.data.recentUsage.length) : "—"}
                    />
                    <Row label="Tenant id (short)" value={tenant.data ? shortId(tenant.data.id) : "—"} />
                  </dl>
                  <p className="mt-3 flex items-start gap-2 text-[12px] leading-relaxed text-muted-foreground">
                    <HugeiconsIcon icon={LockIcon} size={14} className="mt-0.5 shrink-0" />
                    Connection secrets are stored as AES-256-GCM blobs and never leave the API — the console only
                    receives a masked preview.
                  </p>
                </CardContent>
              </Card>
            </div>
          )}

          {tab === "unbuilt" && (
            <div className="space-y-4">
              <BentoCard interactive={false} className="flex items-start gap-3">
                <HugeiconsIcon icon={InfoIcon} size={17} className="mt-0.5 text-info" />
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold">These screens are deliberately empty, not mocked</p>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                    Nothing below has an endpoint yet, so no table is rendered with invented rows. When each feature
                    lands, its page reads from the API like every other screen here.
                  </p>
                </div>
              </BentoCard>

              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>Awaiting a phase</CardTitle>
                    <CardDescription>Tracked in docs/plan-architecture.md.</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <dl>
                    <Row
                      label="Members and roles"
                      value="Phase 2 — authentication (better-auth). The console is pinned to one tenant by env for now."
                      mono={false}
                    />
                    <Row
                      label="API keys for inbound webhooks"
                      value="Phase 5 — the ingest route is unsigned until keys exist."
                      mono={false}
                    />
                    <Row
                      label="Keyring rotation"
                      value="Implemented in packages/shared, but there is no admin endpoint that would call it."
                      mono={false}
                    />
                    <Row
                      label="Deleting the tenant"
                      value="No endpoint. A destructive action is not exposed as a button that cannot be honoured."
                      mono={false}
                    />
                    <Row
                      label="Replay of dead-letter events"
                      value="Phase 5 — needs the queue consumer."
                      mono={false}
                    />
                  </dl>
                </CardContent>
              </Card>

              <p className="text-[12px] text-muted-foreground">
                Plan and quota changes are handled on the{" "}
                <Link to="/billing" className="text-foreground underline decoration-foreground/30 underline-offset-2">
                  Billing
                </Link>{" "}
                page.
              </p>
            </div>
          )}
        </QueryState>
      </div>
    </PageTransition>
  );
}
