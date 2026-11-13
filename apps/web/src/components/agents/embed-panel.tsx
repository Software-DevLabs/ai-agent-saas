import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon";
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import PauseIcon from "@hugeicons/core-free-icons/PauseIcon";
import PlayIcon from "@hugeicons/core-free-icons/PlayIcon";
import RefreshIcon from "@hugeicons/core-free-icons/RefreshIcon";
import SourceCodeIcon from "@hugeicons/core-free-icons/SourceCodeIcon";
import { ApiError } from "@/lib/api";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/field";
import { EmptyState, QueryState } from "@/components/ui/states";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import {
  useAgentEmbeds,
  useCreateEmbed,
  useDeleteEmbed,
  useEmbedRates,
  useRotateEmbed,
  useUpdateEmbed,
} from "@/lib/queries";
import type { EmbedCreate, EmbedRotate, EmbedStatus, EmbedWidget } from "@/lib/domain";
import { formatDate } from "@/lib/utils";

/**
 * The Embed tab: one line of HTML that puts this agent on a site, and the gates
 * behind it.
 *
 * The snippet is shown in full exactly once — at create or rotate — because the
 * server stores only the key's hash and cannot produce it again. That is not a
 * shortcoming to paper over with a "show key" button; it is the reason a dump of
 * this table cannot impersonate the widget. What the tab shows afterwards is the
 * hint, the origins, and how many visitors the bucket has refused, all read back
 * from rows.
 */

const STATUS_LOOK: Record<EmbedStatus, { tone: Tone; label: string }> = {
  ACTIVE: { tone: "success", label: "Live" },
  PAUSED: { tone: "neutral", label: "Paused" },
};

const reason = (error: unknown): string => (error instanceof ApiError ? error.message : String(error));

function Problem({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-destructive">
      <HugeiconsIcon icon={Alert02Icon} size={13} strokeWidth={1.6} className="mt-0.5 shrink-0" />
      {reason(error)}
    </p>
  );
}

function SnippetCard({ create, rotate }: { create?: EmbedCreate; rotate?: EmbedRotate }) {
  const [copied, setCopied] = useState(false);
  const snippet = create?.snippet ?? rotate?.snippet ?? "";
  if (snippet === "") return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Paste this on the site</CardTitle>
        <CardDescription>
          The key is shown only this once — the server stores a hash, so nobody can recover it later. Rotating
          replaces it and breaks every copy already pasted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <pre className="overflow-x-auto rounded-lg bg-fill px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground shadow-inset">
          {snippet}
        </pre>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(snippet).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1_500);
              });
            }}
          >
            <HugeiconsIcon icon={Copy01Icon} size={14} />
            {copied ? "Copied" : "Copy snippet"}
          </Button>
          <span className="text-caption text-muted-foreground">key {create?.key ?? rotate?.key}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function RateTable({ embedId }: { embedId: string }) {
  const rates = useEmbedRates(embedId);
  return (
    <div className="border-t">
      <QueryState
        error={rates.error}
        pending={rates.isPending}
        isEmpty={(rates.data?.rates ?? []).length === 0}
        empty={
          <p className="px-3 py-3 text-caption text-muted-foreground">
            No visitor has been counted yet — the bucket is created by the first message.
          </p>
        }
      >
        <Table>
          <THead>
            <TR>
              <TH>Visitor</TH>
              <TH>Tokens left</TH>
              <TH>Refused</TH>
              <TH>Last seen</TH>
            </TR>
          </THead>
          <tbody>
            {(rates.data?.rates ?? []).map((row) => (
              <TR key={row.ipHash}>
                <TD className="font-mono text-caption">{row.ipHash.slice(0, 12)}…</TD>
                <TD>{row.tokens.toFixed(2)}</TD>
                <TD>
                  {row.rejected > 0 ? <Badge tone="warning">{row.rejected}</Badge> : <span className="text-muted-foreground">0</span>}
                </TD>
                <TD className="text-muted-foreground">{formatDate(row.updatedAt)}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </QueryState>
    </div>
  );
}

function EmbedCard({
  embed,
  agentId,
  onSnippet,
}: {
  embed: EmbedWidget;
  agentId: string;
  onSnippet: (rotate: EmbedRotate) => void;
}) {
  const update = useUpdateEmbed(agentId);
  const rotate = useRotateEmbed(agentId);
  const remove = useDeleteEmbed(agentId);
  const [showRates, setShowRates] = useState(false);
  const look = STATUS_LOOK[embed.status];

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <CardTitle>{embed.name}</CardTitle>
            <Badge tone={look.tone}>{look.label}</Badge>
          </div>
          <CardDescription>
            key {embed.keyHint} · created {formatDate(embed.createdAt)}
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            loading={update.isPending}
            onClick={() => update.mutate({ id: embed.id, status: embed.status === "ACTIVE" ? "PAUSED" : "ACTIVE" })}
          >
            <HugeiconsIcon icon={embed.status === "ACTIVE" ? PauseIcon : PlayIcon} size={14} />
            {embed.status === "ACTIVE" ? "Pause" : "Resume"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={rotate.isPending}
            onClick={() => {
              if (!window.confirm("Rotate the key? Every pasted snippet stops working until replaced.")) return;
              rotate.mutate(embed.id, { onSuccess: onSnippet });
            }}
          >
            <HugeiconsIcon icon={RefreshIcon} size={14} />
            Rotate
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={remove.isPending}
            onClick={() => {
              if (!window.confirm(`Delete "${embed.name}"? Visitors using it lose the assistant immediately.`)) return;
              remove.mutate(embed.id);
            }}
          >
            <HugeiconsIcon icon={Delete02Icon} size={14} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-caption text-muted-foreground">Allowed origins</span>
          {embed.origins.map((origin) => (
            <Badge key={origin} tone="neutral">
              {origin}
            </Badge>
          ))}
        </div>
        <Problem error={update.error ?? rotate.error ?? remove.error} />
        <Button size="sm" variant="ghost" onClick={() => setShowRates((open) => !open)}>
          {showRates ? "Hide" : "Show"} visitor rate buckets
        </Button>
      </CardContent>
      {showRates ? <RateTable embedId={embed.id} /> : null}
    </Card>
  );
}

export function EmbedPanel({ agentId, agentActive }: { agentId: string; agentActive: boolean }) {
  const embeds = useAgentEmbeds(agentId);
  const create = useCreateEmbed(agentId);
  const [name, setName] = useState("Website widget");
  const [origins, setOrigins] = useState("");
  const [created, setCreated] = useState<EmbedCreate | null>(null);
  const [rotated, setRotated] = useState<EmbedRotate | null>(null);

  const bundle = embeds.data?.bundle;
  const rows = embeds.data?.embeds ?? [];

  return (
    <div className="space-y-4">
      {bundle !== undefined && !bundle.served ? (
        <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-4 py-3 text-body-sm text-warning shadow-inset">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.6} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">The widget bundle has not been built on this machine.</p>
            <p className="mt-0.5 text-caption">
              Run <code className="font-mono">pnpm --filter @saas/web build:embed</code> — until then the snippet
              below would point at a file the API does not serve, and a widget that answers nothing is worse than
              no widget.
            </p>
          </div>
        </div>
      ) : null}
      {!agentActive ? (
        <div className="flex items-start gap-2 rounded-lg bg-info/10 px-4 py-3 text-body-sm text-info shadow-inset">
          <HugeiconsIcon icon={Alert02Icon} size={15} strokeWidth={1.6} className="mt-0.5 shrink-0" />
          <p>
            This agent is not active. The widget will load but refuse every question until you activate the agent
            — a draft must not answer a visitor.
          </p>
        </div>
      ) : null}

      <SnippetCard create={created ?? undefined} rotate={rotated ?? undefined} />

      <Card>
        <CardHeader>
          <CardTitle>New widget</CardTitle>
          <CardDescription>
            One origin per line, scheme included (<code className="font-mono">https://example.com</code>). A page
            from any other origin gets no CORS header at all, so the browser cannot even read the refusal.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Name" htmlFor="embed-name">
            <Input id="embed-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
          </Field>
          <Field label="Allowed origins" htmlFor="embed-origins">
            <Textarea
              id="embed-origins"
              value={origins}
              onChange={(event) => setOrigins(event.target.value)}
              placeholder={"https://example.com\nhttp://localhost:5173"}
              className="min-h-20 font-mono text-[12px]"
            />
          </Field>
          <Problem error={create.error} />
          <Button
            variant="primary"
            size="sm"
            loading={create.isPending}
            onClick={() => {
              const list = origins
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line !== "");
              create.mutate(
                { name: name.trim() === "" ? "Website widget" : name.trim(), origins: list },
                {
                  onSuccess: (view) => {
                    setCreated(view);
                    setRotated(null);
                    setOrigins("");
                  },
                },
              );
            }}
          >
            <HugeiconsIcon icon={SourceCodeIcon} size={14} />
            Create and show snippet
          </Button>
        </CardContent>
      </Card>

      <QueryState
        error={embeds.error}
        pending={embeds.isPending}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            title="No widget yet"
            body="A widget is the script tag a site pastes to reach this agent. Create one and its origins are the only pages that can call it."
          />
        }
      >
        <div className="space-y-3">
          {rows.map((embed) => (
            <EmbedCard
              key={embed.id}
              embed={embed}
              agentId={agentId}
              onSnippet={(view) => {
                setRotated(view);
                setCreated(null);
              }}
            />
          ))}
        </div>
      </QueryState>
    </div>
  );
}
