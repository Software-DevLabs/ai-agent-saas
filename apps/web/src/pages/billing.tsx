import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import StarIcon from "@hugeicons/core-free-icons/StarIcon";
import { PageTransition } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { BentoCard, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { EmptyState, QueryState } from "@/components/ui/states";
import { useOverview, usePlans } from "@/lib/queries";
import { formatTokens, formatUsd, formatDate } from "@/lib/utils";

export default function BillingPage() {
  const overview = useOverview();
  const plans = usePlans();
  const [switching, setSwitching] = useState<string | null>(null);
  const data = overview.data;

  return (
    <PageTransition>
      <div className="space-y-5">
        <PageHeader
          title="Billing"
          description="Token quota is the hard limit; connectors and agents are counted per tenant."
        />

        <QueryState error={overview.error} pending={overview.isPending}>
          {data && (
            <BentoCard interactive={false} className="grid gap-5 md:grid-cols-3">
              <div>
                <p className="text-[12px] text-muted-foreground">Current plan</p>
                <p className="mt-1 flex items-center gap-2 text-[16px] font-semibold">
                  {data.plan.name}
                  <Badge tone="primary">{formatUsd(data.plan.monthlyPriceUsd)}/mo</Badge>
                </p>
                <p className="mt-1.5 text-[12px] text-muted-foreground">
                  Tenant {data.tenant.name} · since {formatDate(data.tenant.createdAt)}
                </p>
              </div>
              <div>
                <p className="text-[12px] text-muted-foreground">Quota used</p>
                <p className="mt-1 font-mono text-[16px] tabular">
                  {formatTokens(data.tokensUsedThisCycle)}
                  <span className="text-[12px] text-muted-foreground">
                    {" "}
                    / {formatTokens(Number(data.plan.tokenQuota))}
                  </span>
                </p>
                <Progress
                  className="mt-2.5"
                  value={data.tokensUsedThisCycle / Number(data.plan.tokenQuota)}
                  tone={data.tokensUsedThisCycle / Number(data.plan.tokenQuota) > 0.85 ? "warning" : "primary"}
                />
              </div>
              <div>
                <p className="text-[12px] text-muted-foreground">Next reset</p>
                <p className="mt-1 flex items-center gap-1.5 font-mono text-[15px]">
                  <HugeiconsIcon icon={Clock01Icon} size={15} className="text-muted-foreground" />
                  {formatDate(data.tenant.cycleResetAt)}
                </p>
                <p className="mt-1.5 text-[12px] text-muted-foreground">
                  {data.integrations.total} of {data.integrations.limit} integrations in use
                </p>
              </div>
            </BentoCard>
          )}
        </QueryState>

        <QueryState error={plans.error} pending={plans.isPending}>
          <div className="grid gap-4 lg:grid-cols-3">
            {(plans.data ?? []).map((plan) => {
              const current = plan.id === data?.tenant.planId;
              const quota = Number(plan.tokenQuota);
              return (
                <BentoCard
                  key={plan.id}
                  className={current ? "border-primary/45 ring-1 ring-primary/15" : undefined}
                  interactive={false}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-[15px] font-semibold tracking-tight">{plan.name}</p>
                      <p className="mt-1 font-mono text-[13px] text-muted-foreground">
                        {formatUsd(plan.monthlyPriceUsd)}
                        <span className="text-[11px]"> / month</span>
                      </p>
                    </div>
                    {current ? (
                      <Badge tone="success">
                        <HugeiconsIcon icon={StarIcon} size={11} strokeWidth={1.8} />
                        current
                      </Badge>
                    ) : null}
                  </div>

                  <dl className="mt-4 space-y-2 text-[12.5px]">
                    {[
                      { label: "Monthly tokens", value: formatTokens(quota) },
                      { label: "Integrations", value: String(plan.maxIntegrations) },
                    ].map((row) => (
                      <div key={row.label} className="flex items-baseline justify-between gap-3">
                        <dt className="text-muted-foreground">{row.label}</dt>
                        <dd className="truncate font-mono text-[12px]">{row.value}</dd>
                      </div>
                    ))}
                  </dl>

                  <Button
                    className="mt-5 w-full"
                    size="sm"
                    variant={current ? "outline" : "primary"}
                    disabled={current}
                    onClick={() => setSwitching(plan.name)}
                  >
                    {current ? (
                      <>
                        <HugeiconsIcon icon={CheckmarkCircle02Icon} size={14} strokeWidth={1.6} />
                        Active plan
                      </>
                    ) : (
                      `Switch to ${plan.name}`
                    )}
                  </Button>
                </BentoCard>
              );
            })}
          </div>
        </QueryState>

        <p className="-mt-1 text-[12px] leading-relaxed text-muted-foreground">
          Only the two rows above are enforced today: the API refuses a run once{" "}
          <span className="font-mono text-foreground">tokenQuota</span> is spent and rejects a connection past{" "}
          <span className="font-mono text-foreground">maxIntegrations</span>. Channel whitelists and history windows
          ship with the billing provider in Phase 8, so they are not listed as plan benefits here.
        </p>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Invoices</CardTitle>
              <CardDescription>Nothing has been billed yet, so there is nothing to list.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <EmptyState
              title="No invoice records"
              body="Charging starts with the Stripe connector in Phase 8. Until then the quota in the ledger is the only thing this workspace is measured against."
            />
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={switching !== null}
        title={`Switch to ${switching ?? ""}?`}
        description="Plan changes are enforced by the billing provider."
        onClose={() => setSwitching(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSwitching(null)}>
              Close
            </Button>
            <Button variant="primary" onClick={() => setSwitching(null)}>
              Understood
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Checkout and proration land with the Stripe connector (Phase 8). Until then switching plans here only shows
          the console layout — no charge is made and the quota in the ledger stays on{" "}
          <span className="font-mono text-foreground">{data?.plan.name ?? "current plan"}</span>.
        </p>
      </Dialog>
    </PageTransition>
  );
}
