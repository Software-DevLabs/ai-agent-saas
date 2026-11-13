import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import ArrowUp01Icon from "@hugeicons/core-free-icons/ArrowUp01Icon";
import BotIcon from "@hugeicons/core-free-icons/BotIcon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import PauseIcon from "@hugeicons/core-free-icons/PauseIcon";
import { PageTransition } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { BentoCard, Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { QueryState } from "@/components/ui/states";
import { ApiError } from "@/lib/api";
import { LastRunCard, LiveRun } from "@/components/activity/live-run";
import { useAgents, useRunAgent } from "@/lib/queries";
import type { RunOutcome } from "@/lib/domain";
import { cn, formatTokens } from "@/lib/utils";

interface Turn {
  role: "user" | "assistant";
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  model?: string;
}

export default function PlaygroundPage() {
  const agents = useAgents();
  const run = useRunAgent();
  const [agentId, setAgentId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [lastOutcome, setLastOutcome] = useState<RunOutcome | null>(null);
  const feed = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => (agents.data ?? []).find((agent) => agent.id === agentId) ?? (agents.data ?? [])[0],
    [agents.data, agentId],
  );

  useEffect(() => {
    feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: "smooth" });
  }, [turns, run.isPending]);

  // Switching agent starts a new thread: the run endpoint keys a conversation
  // on (agentId, externalChatId), so a thread never spans two prompts.
  function pickAgent(id: string) {
    setAgentId(id);
    setTurns([]);
    setConversationId(undefined);
    setLastOutcome(null);
  }

  function send() {
    const text = draft.trim();
    if (!text || !selected || run.isPending) return;
    setTurns((current) => [...current, { role: "user", content: text }]);
    setDraft("");
    run.mutate(
      { agentId: selected.id, message: text, conversationId },
      {
        onSuccess: (outcome) => {
          setConversationId(outcome.conversationId);
          setLastOutcome(outcome);
          setTurns((current) => [
            ...current,
            {
              role: "assistant",
              content: outcome.reply,
              inputTokens: outcome.inputTokens,
              outputTokens: outcome.outputTokens,
              durationMs: outcome.durationMs,
              model: outcome.model,
            },
          ]);
        },
      },
    );
  }

  const paused = selected !== undefined && selected.status !== "ACTIVE";
  const ledgerTokens = turns.reduce((sum, turn) => sum + (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0), 0);
  const replies = turns.filter((turn) => turn.role === "assistant").length;
  const failure = run.error ? (run.error instanceof ApiError ? run.error.message : String(run.error)) : null;

  return (
    <PageTransition>
      <div className="space-y-5">
        <PageHeader
          title="Playground"
          description="Every message is a real run: the provider answers, the thread and the ledger record it."
          actions={
            <div className="flex items-center gap-2">
              <Select
                aria-label="Choose agent"
                value={selected?.id ?? ""}
                onChange={(event) => pickAgent(event.target.value)}
                className="h-8 w-52 text-[12px]"
              >
                {(agents.data ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </Select>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setTurns([]);
                  setConversationId(undefined);
                  setLastOutcome(null);
                }}
                disabled={turns.length === 0}
              >
                <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.6} />
                New thread
              </Button>
            </div>
          }
        />

        <QueryState error={agents.error} pending={agents.isPending}>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
            <Card className="flex min-h-[520px] flex-col">
              <CardContent className="flex flex-1 flex-col p-0">
                <div ref={feed} className="flex-1 space-y-3 overflow-y-auto p-5">
                  {turns.length === 0 && !run.isPending && (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                      <span className="flex h-10 w-10 items-center justify-center rounded-xl border bg-muted/40 text-muted-foreground">
                        <HugeiconsIcon icon={BotIcon} size={18} strokeWidth={1.5} />
                      </span>
                      <p className="text-[13px] font-medium">Start a thread</p>
                      <p className="max-w-xs text-[12px] text-muted-foreground">
                        {selected
                          ? `${selected.name} answers with ${selected.modelProvider}/${selected.modelName}. The exchange is stored and metered.`
                          : "Create an agent first — there is nothing to talk to yet."}
                      </p>
                    </div>
                  )}

                  {turns.map((turn, index) => (
                    <div
                      key={`${turn.role}-${index}`}
                      className={cn("flex gap-2.5", turn.role === "user" ? "justify-end" : "justify-start")}
                    >
                      {turn.role === "assistant" && (
                        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
                          <HugeiconsIcon icon={BotIcon} size={12} strokeWidth={1.6} />
                        </span>
                      )}
                      <div className={cn("max-w-[76%] space-y-1", turn.role === "user" && "items-end")}>
                        <div
                          className={cn(
                            "whitespace-pre-wrap rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed",
                            turn.role === "user"
                              ? "bg-primary text-primary-foreground"
                              : "border bg-muted/40",
                          )}
                        >
                          {turn.content}
                        </div>
                        {turn.role === "assistant" && (
                          <p className="px-1 font-mono text-[10.5px] text-muted-foreground">
                            {formatTokens(turn.inputTokens ?? 0)} in · {formatTokens(turn.outputTokens ?? 0)} out ·{" "}
                            {turn.durationMs} ms · {turn.model}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}

                  {run.isPending && selected && <LiveRun agentId={selected.id} />}

                  {failure && (
                    <div className="flex gap-2.5">
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border bg-destructive/10 text-destructive">
                        <HugeiconsIcon icon={AlertCircleIcon} size={12} strokeWidth={1.6} />
                      </span>
                      <div className="max-w-[76%] rounded-xl border bg-destructive/5 px-3.5 py-2.5 text-[13px] leading-relaxed text-destructive">
                        {failure}
                      </div>
                    </div>
                  )}
                </div>

                <div className="border-t p-3">
                  <div className="flex items-end gap-2">
                    <textarea
                      value={draft}
                      rows={1}
                      disabled={paused || !selected}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          send();
                        }
                      }}
                      placeholder={paused ? "Resume the agent to test it" : "Ask the agent something…"}
                      className="max-h-32 min-h-9 flex-1 resize-none rounded-lg bg-background px-3 py-2 text-[13px] shadow-xs placeholder:text-muted-foreground/70 disabled:opacity-60"
                    />
                    <Button
                      variant="primary"
                      size="icon"
                      onClick={send}
                      loading={run.isPending}
                      disabled={paused || !selected || draft.trim() === ""}
                      aria-label="Send message"
                    >
                      <HugeiconsIcon icon={ArrowUp01Icon} size={16} strokeWidth={1.8} />
                    </Button>
                  </div>
                  {paused && selected && (
                    <p className="mt-2 flex items-center gap-1.5 text-[11.5px] text-warning">
                      <HugeiconsIcon icon={PauseIcon} size={12} strokeWidth={1.8} />
                      {selected.name} is {selected.status.toLowerCase()} — the API refuses to run it —{" "}
                      <Link to={`/agents/${selected.id}`} className="underline">
                        change its status
                      </Link>
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="space-y-4">
              <BentoCard interactive={false}>
                <p className="text-[12px] font-medium text-muted-foreground">Effective settings</p>
                <dl className="mt-3 space-y-2 text-[12.5px]">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Provider</dt>
                    <dd className="font-mono">{selected?.modelProvider ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Model</dt>
                    <dd className="truncate font-mono">{selected?.modelName ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Temperature</dt>
                    <dd className="font-mono tabular">{selected?.temperature.toFixed(2) ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Max output</dt>
                    <dd className="font-mono tabular">{selected?.maxOutputTokens ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Thread</dt>
                    <dd className="truncate font-mono">{conversationId ?? "not started"}</dd>
                  </div>
                </dl>
              </BentoCard>

              <BentoCard interactive={false}>
                <p className="text-[12px] font-medium text-muted-foreground">This thread</p>
                <p className="mt-2 font-mono text-[20px] tabular leading-none">{formatTokens(ledgerTokens)}</p>
                <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                  tokens across {replies} provider {replies === 1 ? "call" : "calls"}
                </p>
                <Badge tone={replies > 0 ? "success" : "neutral"} className="mt-3">
                  {replies > 0 ? "written to the ledger" : "no run yet"}
                </Badge>
              </BentoCard>

              <BentoCard interactive={false}>
                <p className="text-[12px] font-medium text-muted-foreground">System prompt</p>
                <p className="mt-2 line-clamp-6 text-[12px] leading-relaxed text-muted-foreground">
                  {selected?.systemPrompt ?? "Select an agent to read its prompt."}
                </p>
              </BentoCard>

              {lastOutcome && (
                <BentoCard interactive={false}>
                  <p className="text-[12px] font-medium text-muted-foreground">Last run</p>
                  <div className="mt-3">
                    <LastRunCard outcome={lastOutcome} />
                  </div>
                </BentoCard>
              )}
            </div>
          </div>
        </QueryState>
      </div>
    </PageTransition>
  );
}
