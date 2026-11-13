import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import ApiIcon from "@hugeicons/core-free-icons/ApiIcon";
import BotIcon from "@hugeicons/core-free-icons/BotIcon";
import LockIcon from "@hugeicons/core-free-icons/LockIcon";
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon";
import RefreshIcon from "@hugeicons/core-free-icons/RefreshIcon";
import SecurityCheckIcon from "@hugeicons/core-free-icons/SecurityCheckIcon";
import UnplugIcon from "@hugeicons/core-free-icons/UnplugIcon";
import { PageTransition } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { BentoCard, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { EmptyState, QueryState } from "@/components/ui/states";
import {
  CHANNEL_CATALOG,
  useAgents,
  useIntegrations,
  useOverview,
  useSaveIntegration,
  useSetIntegrationStatus,
} from "@/lib/queries";
import type { Integration, IntegrationType } from "@/lib/domain";
import { formatDate } from "@/lib/utils";

function ConnectDialog({ open, preset, onClose }: { open: boolean; preset?: IntegrationType; onClose: () => void }) {
  const [type, setType] = useState<IntegrationType>(preset ?? "TELEGRAM_IN");
  const [externalId, setExternalId] = useState("");
  const [secret, setSecret] = useState("");
  const [agentId, setAgentId] = useState("");
  const agents = useAgents();
  const save = useSaveIntegration();
  const meta = CHANNEL_CATALOG.find((entry) => entry.type === type);

  function submit() {
    if (secret.length < 8) return;
    save.mutate(
      {
        type,
        credentials: secret,
        externalId: externalId.trim() === "" ? null : externalId.trim(),
        ...(agentId ? { agentId, agentDirection: meta?.direction ?? "INPUT" } : {}),
      },
      {
        onSuccess: () => {
          setExternalId("");
          setSecret("");
          setAgentId("");
          onClose();
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect a channel"
      description="Credentials are sealed with the tenant keyring before they touch the database."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={save.isPending} disabled={secret.length < 8}>
            Save connection
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Field label="Channel" htmlFor="channel-type">
          <Select id="channel-type" value={type} onChange={(event) => setType(event.target.value as IntegrationType)}>
            {CHANNEL_CATALOG.map((entry) => (
              <option key={entry.type} value={entry.type}>
                {entry.label} — {entry.direction === "INPUT" ? "inbound" : "outbound"}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label={meta?.direction === "INPUT" ? "Bot handle / number" : "Target id or URL"}
          htmlFor="channel-external"
          hint={meta?.blurb}
        >
          <Input
            id="channel-external"
            value={externalId}
            placeholder="optional label the channel is known by"
            onChange={(event) => setExternalId(event.target.value)}
          />
        </Field>

        <Field
          label={meta?.credentialLabel ?? "Secret"}
          htmlFor="channel-secret"
          hint="Write-only. The console never receives a stored secret back — only a masked preview, and a secret can only be replaced."
        >
          <Input
            id="channel-secret"
            type="password"
            autoComplete="off"
            value={secret}
            placeholder={meta?.placeholder}
            onChange={(event) => setSecret(event.target.value)}
          />
        </Field>

        <Field
          label="Bind to agent"
          htmlFor="channel-agent"
          hint={
            agents.data?.length
              ? "Optional. The join row is written in this channel's direction."
              : "No agents yet — create one first, or bind this channel later."
          }
        >
          <Select id="channel-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            <option value="">Not bound</option>
            {(agents.data ?? []).map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-[12px] text-muted-foreground">
          <HugeiconsIcon icon={LockIcon} size={15} strokeWidth={1.6} className="mt-0.5 shrink-0" />
          <span>
            Stored as a <code className="font-mono text-[11px]">v1:keyId:nonce:ciphertext</code> blob. The browser is
            given the last four characters and nothing else.
          </span>
        </div>
      </div>
    </Dialog>
  );
}

function IntegrationRow({ integration }: { integration: Integration }) {
  const meta = CHANNEL_CATALOG.find((entry) => entry.type === integration.type);
  const setStatus = useSetIntegrationStatus();
  const [confirming, setConfirming] = useState(false);
  const revoked = integration.status === "REVOKED";

  return (
    <>
      <BentoCard className="flex items-center justify-between gap-4 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground">
            <HugeiconsIcon icon={meta?.icon ?? ApiIcon} size={15} strokeWidth={1.6} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{meta?.label ?? integration.type}</p>
            <p className="truncate font-mono text-[11.5px] text-muted-foreground">
              {integration.externalId ?? "— no external id set —"}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <StatusBadge status={integration.status} />
              <Badge tone={integration.credentialPreview ? "success" : "warning"}>
                <HugeiconsIcon icon={SecurityCheckIcon} size={11} strokeWidth={1.8} />
                {integration.credentialPreview ?? "no secret stored"}
              </Badge>
              {integration.bindings.map((binding) => (
                <Badge key={`${binding.agentId}-${binding.direction}`} tone="neutral">
                  <HugeiconsIcon icon={BotIcon} size={11} strokeWidth={1.8} />
                  {binding.agentName} · {binding.direction === "INPUT" ? "in" : "out"}
                </Badge>
              ))}
              <span className="font-mono text-[11px] text-muted-foreground">
                {formatDate(integration.createdAt)}
              </span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          {integration.status === "ERROR" && (
            <Button
              size="sm"
              variant="outline"
              loading={setStatus.isPending}
              onClick={() => setStatus.mutate({ id: integration.id, status: "CONNECTED" })}
            >
              <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={1.6} />
              Retry
            </Button>
          )}
          {!revoked ? (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              <HugeiconsIcon icon={UnplugIcon} size={14} strokeWidth={1.6} />
              Revoke
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setStatus.mutate({ id: integration.id, status: "CONNECTED" })}
            >
              <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={1.6} />
              Reconnect
            </Button>
          )}
        </div>
      </BentoCard>

      <ConfirmDialog
        open={confirming}
        danger
        title={`Revoke ${meta?.label ?? integration.type}?`}
        body="The channel is marked revoked and agents bound to it stop receiving traffic. The sealed credential stays in the database until it is replaced."
        confirmLabel="Revoke channel"
        busy={setStatus.isPending}
        onClose={() => setConfirming(false)}
        onConfirm={() =>
          setStatus.mutate(
            { id: integration.id, status: "REVOKED" },
            { onSuccess: () => setConfirming(false) },
          )
        }
      />
    </>
  );
}

export default function ConnectionsPage() {
  const integrations = useIntegrations();
  const overview = useOverview();
  const [connecting, setConnecting] = useState<IntegrationType | null>(null);

  const atLimit = useMemo(() => {
    const data = overview.data;
    if (!data) return false;
    return data.integrations.total >= data.integrations.limit;
  }, [overview.data]);

  return (
    <PageTransition>
      <div className="space-y-5">
        <PageHeader
          title="Connections"
          description="Inbound channels feed agents; outbound sinks receive their replies."
          actions={
            <div className="flex items-center gap-2">
              {atLimit && <Badge tone="warning">integration limit reached</Badge>}
              <Button variant="primary" size="sm" onClick={() => setConnecting("TELEGRAM_IN")}>
                <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={1.8} />
                Connect channel
              </Button>
            </div>
          }
        />

        <QueryState error={integrations.error} pending={integrations.isPending}>
          <div className="space-y-3">
            {(integrations.data ?? []).map((integration) => (
              <IntegrationRow key={integration.id} integration={integration} />
            ))}
            {(integrations.data ?? []).length === 0 && (
              <Card>
                <CardContent>
                  <EmptyState
                    title="No channels connected"
                    body="Nothing is stored yet. A connection only exists once you paste a real token, and the API seals it before writing the row."
                    actionLabel="Connect channel"
                    onAction={() => setConnecting("TELEGRAM_IN")}
                  />
                </CardContent>
              </Card>
            )}
          </div>
        </QueryState>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Available channel types</CardTitle>
              <CardDescription>What the platform can bind to. Each connection counts against the plan limit.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {CHANNEL_CATALOG.map((entry) => (
              <div key={entry.type} className="rounded-lg border p-3.5">
                <div className="flex items-center justify-between">
                  <p className="flex items-center gap-2 text-[13px] font-semibold">
                    <HugeiconsIcon icon={entry.icon} size={14} strokeWidth={1.6} className="text-muted-foreground" />
                    {entry.label}
                  </p>
                  <Badge tone={entry.direction === "INPUT" ? "info" : "neutral"}>
                    {entry.direction === "INPUT" ? "inbound" : "outbound"}
                  </Badge>
                </div>
                <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{entry.blurb}</p>
                <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">{entry.credentialLabel}</p>
                <Button size="sm" variant="outline" className="mt-3 w-full" onClick={() => setConnecting(entry.type)}>
                  Connect
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {connecting && <ConnectDialog open preset={connecting} onClose={() => setConnecting(null)} />}
    </PageTransition>
  );
}
