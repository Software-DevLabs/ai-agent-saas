import { useContext } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import AddIcon from "@hugeicons/core-free-icons/Add01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { CanvasContext, KIND_LABEL } from "@/lib/graph-flow";
import type { FlowNodeData } from "@/lib/graph-flow";
import type { OrchestratorSubagent } from "@/lib/domain";
import { cn } from "@/lib/utils";
import type { PaletteItem } from "./palette";

const ROLE_PATTERN = /^[a-z][a-z0-9_-]{1,30}$/;
const MAX_SUBAGENTS = 6;
const MAX_SUBAGENT_STEPS = 4;

/**
 * The right-hand rail: one node at a time, and only the two things a node
 * actually holds — which row it references, and what the user calls it.
 *
 * The reference list is the same project-scoped set the palette offers, so the
 * inspector cannot be used to point a node at another project's agent. The
 * server would refuse that on activation, but a dropdown holding only legal
 * values is the better half of that answer.
 */
export function Inspector({
  node,
  options,
  onChangeRef,
  onChangeLabel,
  onChangeSubagents,
  onDelete,
  idPrefix = "",
  className,
}: {
  node: (FlowNodeData & { key: string }) | null;
  options: PaletteItem[];
  onChangeRef: (refId: string) => void;
  onChangeLabel: (label: string) => void;
  onChangeSubagents: (subagents: OrchestratorSubagent[]) => void;
  onDelete: () => void;
  /** Kept unique when the desktop rail and the mobile sheet are both mounted. */
  idPrefix?: string;
  className?: string;
}) {
  const { ref } = useContext(CanvasContext);

  if (!node) {
    return (
      <aside className={cn("flex w-full flex-col gap-3 overflow-y-auto bg-card/60 p-4", className)}>
        <p className="text-[13px] font-semibold tracking-tight">Nothing selected</p>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Click a node to choose which agent or channel it points at. Click a cable and press Delete to unlink two
          nodes.
        </p>
      </aside>
    );
  }

  const refField = `${idPrefix}node-ref`;
  const labelField = `${idPrefix}node-label`;
  const info = ref(node.refId, node.kind);
  // A row the graph points at that this project no longer offers stays in the
  // list, marked, and is refused at activation — never quietly swapped for
  // whichever agent happens to sort first.
  const listed = options.some((option) => option.refId === node.refId);

  return (
    <aside className={cn("flex w-full flex-col gap-4 overflow-y-auto bg-card/60 p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold tracking-tight">
            {node.label.trim() || info?.name || "Missing row"}
          </p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{node.key}</p>
        </div>
        <Badge tone="neutral">{KIND_LABEL[node.kind]}</Badge>
      </div>

      <Field label="References" htmlFor={refField}>
        <Select id={refField} value={node.refId} onChange={(event) => onChangeRef(event.target.value)}>
          {!listed && <option value={node.refId}>{node.refId} · not in this project</option>}
          {options.map((option) => (
            <option key={option.refId} value={option.refId}>
              {option.name} · {option.meta}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Label" htmlFor={labelField} hint="Optional. Shown on the box instead of the row's name.">
        <Input
          id={labelField}
          key={node.key}
          defaultValue={node.label}
          maxLength={60}
          placeholder={info?.name ?? "Untitled"}
          onBlur={(event) => onChangeLabel(event.target.value)}
        />
      </Field>

      {node.kind === "ORCHESTRATOR" && (
        <Subagents subagents={node.subagents} options={options} onChange={onChangeSubagents} idPrefix={idPrefix} />
      )}

      {node.kind === "INBOUND" && (
        <p className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          Nothing can deliver a message to this channel yet: this build has no Telegram or WhatsApp adapter. The
          graph still runs for real from the Test run panel, where you type the message yourself — this node is the
          channel a delivered message will enter through once an adapter exists.
        </p>
      )}
      {(info?.channelType === "SHEETS_OUT" || info?.channelType === "DRIVE_OUT") && (
        <p className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          This connector has no implementation yet. A run that reaches it fails with <code>sink_not_wired</code>{" "}
          instead of reporting a reply that was never sent.
        </p>
      )}

      <div className="mt-auto pt-2">
        <Button variant="destructive" size="sm" onClick={onDelete} className="w-full">
          <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.6} />
          Remove node
        </Button>
      </div>
    </aside>
  );
}

/**
 * The declared delegations. These are hints on the client, not the judge: the
 * server re-reads every role, duplicate and cap from the saved document, and
 * activation additionally asks the provider whether the models can call tools.
 */
function Subagents({
  subagents,
  options,
  onChange,
  idPrefix,
}: {
  subagents: OrchestratorSubagent[];
  options: PaletteItem[];
  onChange: (subagents: OrchestratorSubagent[]) => void;
  idPrefix: string;
}) {
  const update = (index: number, patch: Partial<OrchestratorSubagent>) =>
    onChange(subagents.map((sub, at) => (at === index ? { ...sub, ...patch } : sub)));
  const remove = (index: number) => onChange(subagents.filter((_, at) => at !== index));

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const sub of subagents) {
    if (seen.has(sub.role)) duplicates.add(sub.role);
    seen.add(sub.role);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Subagents</p>
        <Button
          size="sm"
          variant="outline"
          disabled={subagents.length >= MAX_SUBAGENTS || options.length === 0}
          onClick={() =>
            onChange([
              ...subagents,
              { agentId: options[0]?.refId ?? "", role: `agent_${subagents.length + 1}` },
            ])
          }
        >
          <HugeiconsIcon icon={AddIcon} size={13} strokeWidth={1.8} />
          Add
        </Button>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        The model sees each role as one delegation it may call. Up to {MAX_SUBAGENTS}; delegation is depth 1, so a
        subagent runs without tools. Activation refuses any agent here whose model cannot call tools.
      </p>

      {subagents.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
          No subagents declared, so this node would run as a plain agent turn.
        </p>
      ) : (
        <ul className="space-y-2">
          {subagents.map((sub, index) => {
            const badRole = !ROLE_PATTERN.test(sub.role);
            const duplicate = duplicates.has(sub.role);
            return (
              <li key={`${idPrefix}subagent-${index}`} className="space-y-1.5 rounded-lg border border-border bg-background/40 p-2">
                <div className="flex items-center gap-1.5">
                  <Input
                    aria-label={`Subagent ${index + 1} role`}
                    aria-invalid={badRole || duplicate}
                    value={sub.role}
                    maxLength={31}
                    placeholder="researcher"
                    className={cn("h-8 font-mono text-[12px]", (badRole || duplicate) && "border-destructive/60")}
                    onChange={(event) => update(index, { role: event.target.value.trim() })}
                  />
                  <button
                    type="button"
                    aria-label={`Remove subagent ${index + 1}`}
                    onClick={() => remove(index)}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.6} />
                  </button>
                </div>
                <Select
                  aria-label={`Subagent ${index + 1} agent`}
                  value={sub.agentId}
                  className="h-8 text-[12px]"
                  onChange={(event) => update(index, { agentId: event.target.value })}
                >
                  {!options.some((option) => option.refId === sub.agentId) && (
                    <option value={sub.agentId}>{sub.agentId} · not in this project</option>
                  )}
                  {options.map((option) => (
                    <option key={option.refId} value={option.refId}>
                      {option.name} · {option.meta}
                    </option>
                  ))}
                </Select>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground">Max steps</span>
                  <Input
                    aria-label={`Subagent ${index + 1} max steps`}
                    type="number"
                    min={1}
                    max={MAX_SUBAGENT_STEPS}
                    value={sub.maxSteps ?? ""}
                    placeholder="1"
                    className="h-7 w-16 text-right text-[12px]"
                    onChange={(event) => {
                      const raw = event.target.value.trim();
                      const parsed = raw === "" ? undefined : Number.parseInt(raw, 10);
                      update(index, {
                        maxSteps:
                          parsed === undefined || !Number.isFinite(parsed)
                            ? undefined
                            : Math.min(MAX_SUBAGENT_STEPS, Math.max(1, parsed)),
                      });
                    }}
                  />
                </div>
                {(badRole || duplicate) && (
                  <p className="text-[11px] text-destructive">
                    {duplicate
                      ? "Two subagents share this role, so the model could not tell them apart."
                      : "Use 2–31 lowercase letters, digits, _ or -, starting with a letter."}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
