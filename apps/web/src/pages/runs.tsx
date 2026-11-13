import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import ChevronDownIcon from "@hugeicons/core-free-icons/ChevronDownIcon";
import ChevronRightIcon from "@hugeicons/core-free-icons/ChevronRightIcon";
import InboxIcon from "@hugeicons/core-free-icons/InboxIcon";
import Table01Icon from "@hugeicons/core-free-icons/Table01Icon";
import { PageTransition } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { ActivityFeed } from "@/components/activity/activity-feed";
import { AgentRunsTable } from "@/components/activity/agent-runs-table";
import { WorkflowRunsTable } from "@/components/activity/workflow-runs-table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge, Badge } from "@/components/ui/badge";
import { EmptyState, QueryState } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { THead, TR, Table, TD, TH } from "@/components/ui/table";
import { useConversations, useWebhookEvents } from "@/lib/queries";
import type { WebhookEventLog, WebhookStatus } from "@/lib/domain";
import { relativeTime, shortId } from "@/lib/utils";

const STATUS_TABS: Array<{ id: "ALL" | WebhookStatus; label: string }> = [
  { id: "ALL", label: "All" },
  { id: "QUEUED", label: "Queued" },
  { id: "PROCESSED", label: "Processed" },
  { id: "FAILED", label: "Failed" },
  { id: "DEAD", label: "Dead letter" },
];

const NOTE: Record<WebhookStatus, string> = {
  DEAD: "Exhausted every retry. The idempotency key is kept, so replaying the same source message will not double-answer.",
  FAILED: "The worker recorded a failure for this event. The source message is still deduplicated, so a retry cannot produce a second answer.",
  QUEUED: "Accepted and deduplicated; waiting for a worker slot.",
  PROCESSED: "Handled. Rows written by the playground come from a run that already completed.",
};

function EventRow({ event, open, onToggle }: { event: WebhookEventLog; open: boolean; onToggle: () => void }) {
  return (
    <>
      <TR className={open ? "bg-muted/40" : undefined}>
        <TD className="w-8 pr-0">
          <button
            type="button"
            onClick={onToggle}
            aria-label={`Toggle ${event.externalMessageId}`}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <HugeiconsIcon icon={open ? ChevronDownIcon : ChevronRightIcon} size={13} strokeWidth={1.8} />
          </button>
        </TD>
        <TD>
          <span className="font-mono text-[12px]">{shortId(event.externalMessageId)}</span>
        </TD>
        <TD>
          <Badge tone="neutral">{event.source}</Badge>
        </TD>
        <TD>
          <StatusBadge status={event.status} />
        </TD>
        <TD className="font-mono text-[12px] text-muted-foreground">{relativeTime(event.receivedAt)}</TD>
        <TD className="font-mono text-[12px] text-muted-foreground">
          {event.processedAt ? relativeTime(event.processedAt) : "—"}
        </TD>
      </TR>
      {open && (
        <tr className="bg-muted/25">
          <td colSpan={6} className="px-4 py-3">
            <p className="text-[12px] text-muted-foreground">{NOTE[event.status]}</p>
            {/* Only fields the row actually carries — no invented attempt counts. */}
            <pre className="mt-2 overflow-x-auto rounded-md border bg-card p-3 font-mono text-[11.5px] leading-relaxed">
{JSON.stringify(
  {
    id: event.id,
    source: event.source,
    externalMessageId: event.externalMessageId,
    status: event.status,
    receivedAt: event.receivedAt,
    processedAt: event.processedAt,
  },
  null,
  2,
)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

/** Tabs the page renders; a `?tab=` value that is not here falls back to the feed. */
const TAB_IDS = ["activity", "agent-runs", "workflow-runs", "pipeline", "conversations"] as const;

export default function RunsPage() {
  const events = useWebhookEvents();
  const conversations = useConversations();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<string>(TAB_IDS.find((value) => value === params.get("tab")) ?? "activity");
  const [status, setStatus] = useState<string>("ALL");
  const [expanded, setExpanded] = useState<string | null>(null);

  const visible = useMemo(() => {
    const all = (events.data ?? []).slice().sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    return status === "ALL" ? all : all.filter((event) => event.status === status);
  }, [events.data, status]);

  const counts = useMemo(() => {
    const all = events.data ?? [];
    return {
      ALL: all.length,
      QUEUED: all.filter((e) => e.status === "QUEUED").length,
      PROCESSED: all.filter((e) => e.status === "PROCESSED").length,
      FAILED: all.filter((e) => e.status === "FAILED").length,
      DEAD: all.filter((e) => e.status === "DEAD").length,
    } as Record<string, number>;
  }, [events.data]);

  return (
    <PageTransition>
      <div className="space-y-5">
        <PageHeader
          title="Runs"
          description="Every inbound event is logged before it is queued — the log is the audit trail."
        />

        <Tabs
          tabs={[
            { id: "activity", label: "Agent activity" },
            { id: "agent-runs", label: "Agent runs" },
            { id: "workflow-runs", label: "Workflow runs" },
            { id: "pipeline", label: "Pipeline events", count: events.data?.length },
            { id: "conversations", label: "Conversations", count: conversations.data?.length },
          ]}
          active={tab}
          onChange={setTab}
          className="w-fit"
        />

        {tab === "activity" && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Agent activity</CardTitle>
                <CardDescription>
                  Direct turns from the playground and channels, plus the agent and orchestrator nodes of
                  workflow runs — newest first. A direct row opens its recorded steps.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <ActivityFeed limit={40} />
            </CardContent>
          </Card>
        )}

        {tab === "agent-runs" && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Agent runs</CardTitle>
                <CardDescription>Every persisted direct turn, with the rounds and tool calls it recorded.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <AgentRunsTable />
            </CardContent>
          </Card>
        )}

        {tab === "workflow-runs" && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Workflow runs</CardTitle>
                <CardDescription>Runs of every graph in this workspace, newest first.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <WorkflowRunsTable />
            </CardContent>
          </Card>
        )}

        {tab === "pipeline" && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Webhook event log</CardTitle>
                <CardDescription>Unique per (source, external message id) — duplicates are rejected at insert.</CardDescription>
              </div>
              <Tabs
                tabs={STATUS_TABS.map((entry) => ({ ...entry, count: counts[entry.id] ?? 0 }))}
                active={status}
                onChange={setStatus}
              />
            </CardHeader>
            <CardContent className="p-0">
              <QueryState error={events.error} pending={events.isPending}>
                {visible.length === 0 ? (
                  <EmptyState
                    title={status === "ALL" ? "No events recorded" : `Nothing in ${status.toLowerCase()}`}
                    body="This table fills from inbound channel traffic and from playground runs. Run an agent and a row appears here."
                  />
                ) : (
                  <Table>
                    <THead>
                      <TR>
                        <TH className="w-8"> </TH>
                        <TH>External id</TH>
                        <TH>Source</TH>
                        <TH>Status</TH>
                        <TH>Received</TH>
                        <TH>Processed</TH>
                      </TR>
                    </THead>
                    <tbody>
                      {visible.map((event) => (
                        <EventRow
                          key={event.id}
                          event={event}
                          open={expanded === event.id}
                          onToggle={() => setExpanded(expanded === event.id ? null : event.id)}
                        />
                      ))}
                    </tbody>
                  </Table>
                )}
              </QueryState>
            </CardContent>
          </Card>
        )}

        {tab === "conversations" && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Conversations</CardTitle>
                <CardDescription>One thread per external chat per agent.</CardDescription>
              </div>
              <HugeiconsIcon icon={Table01Icon} size={16} className="text-muted-foreground" />
            </CardHeader>
            <CardContent className="p-0">
              <QueryState error={conversations.error} pending={conversations.isPending}>
                {(conversations.data ?? []).length === 0 ? (
                  <EmptyState
                    title="No threads yet"
                    body="A conversation is created by the first message an agent handles, from any channel."
                  />
                ) : (
                  <Table>
                    <THead>
                      <TR>
                        <TH>Thread</TH>
                        <TH>Agent</TH>
                        <TH>External chat</TH>
                        <TH>Messages</TH>
                        <TH>Last touched</TH>
                      </TR>
                    </THead>
                    <tbody>
                      {(conversations.data ?? []).map((conversation) => (
                        <TR key={conversation.id}>
                          <TD>
                            <div className="flex items-center gap-2">
                              <HugeiconsIcon icon={InboxIcon} size={14} className="text-muted-foreground" />
                              <span className="max-w-[280px] truncate text-[12.5px]">
                                {conversation.lastMessagePreview || "—"}
                              </span>
                            </div>
                          </TD>
                          <TD>
                            <Link to={`/agents/${conversation.agentId}`} className="text-[12.5px] hover:underline">
                              {conversation.agentName}
                            </Link>
                          </TD>
                          <TD className="font-mono text-[12px]">{conversation.externalChatId}</TD>
                          <TD className="font-mono tabular">{conversation.messageCount}</TD>
                          <TD className="text-[12px] text-muted-foreground">{relativeTime(conversation.updatedAt)}</TD>
                        </TR>
                      ))}
                    </tbody>
                  </Table>
                )}
              </QueryState>
            </CardContent>
          </Card>
        )}

        <p className="text-[12px] text-muted-foreground">
          Replay and retry need the queue, which lands in Phase 5 — see{" "}
          <Link to="/usage" className="text-foreground underline decoration-foreground/30 underline-offset-2">
            the token ledger
          </Link>{" "}
          for what has already been metered.
        </p>
      </div>
    </PageTransition>
  );
}
