import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import CpuIcon from "@hugeicons/core-free-icons/CpuIcon";
import Edit01Icon from "@hugeicons/core-free-icons/Edit01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import PauseIcon from "@hugeicons/core-free-icons/PauseIcon";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Slider, Textarea } from "@/components/ui/field";
import { useProviders, useSaveAgent } from "@/lib/queries";
import type { Agent, AgentDraft } from "@/lib/domain";

const BLANK: AgentDraft = {
  name: "",
  systemPrompt: "",
  modelProvider: "ollama",
  modelName: "",
  temperature: 0.7,
  maxOutputTokens: 1024,
  // The column defaults, restated so a new agent starts where the schema says.
  maxToolSteps: 6,
  perTurnTokenBudget: 0,
  dailyTokenBudget: 0,
};

export function AgentFormDialog({
  open,
  agent,
  projectId,
  onClose,
  onSaved,
}: {
  open: boolean;
  agent?: Agent;
  /** Create only — files the new agent inside this project. */
  projectId?: string;
  onClose: () => void;
  onSaved?: (saved: Agent) => void;
}) {
  const providers = useProviders();
  const [draft, setDraft] = useState<AgentDraft>(() => (agent ? { ...agent } : { ...BLANK, projectId }));
  const save = useSaveAgent();
  const valid = draft.name.trim().length > 1 && draft.systemPrompt.trim().length > 10 && draft.modelName.length > 0;

  const catalogue = providers.data?.find((provider) => provider.name === draft.modelProvider);

  // The model list is read from the daemon, so a new agent can only be saved
  // once that read has produced something to point it at.
  useEffect(() => {
    if (!agent && draft.modelName === "" && catalogue?.defaultModel) setDraft((c) => ({ ...c, modelName: catalogue.defaultModel }));
  }, [agent, catalogue, draft.modelName]);

  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  function submit() {
    if (!valid) return;
    save.mutate({ ...draft, id: agent?.id }, {
      onSuccess: (saved) => {
        setDraft({ ...BLANK, projectId });
        onSaved?.(saved);
        onClose();
      },
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={agent ? `Edit ${agent.name}` : "New agent"}
      description="Model settings are stored per agent and resolved against the provider registry at run time."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={submit}>
            {agent ? "Save changes" : "Create agent"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="agent-name">
            <Input
              id="agent-name"
              value={draft.name}
              placeholder="Inbound Triage"
              onChange={(event) => set("name", event.target.value)}
            />
          </Field>
          <Field
            label="Model"
            htmlFor="agent-model"
            hint={
              providers.data
                ? catalogue?.error
                  ? `Model list could not be read from the daemon: ${catalogue.error}`
                  : "Models come from the provider's own catalog, so only real ones are offered."
                : "Reading the provider catalog…"
            }
          >
            <div className="flex gap-2">
              <Select
                id="agent-provider"
                aria-label="Provider"
                value={draft.modelProvider}
                onChange={(event) => {
                  const name = event.target.value;
                  const next = providers.data?.find((provider) => provider.name === name);
                  setDraft((current) => ({
                    ...current,
                    modelProvider: name,
                    modelName: next?.defaultModel ?? "",
                  }));
                }}
                className="w-32"
              >
                {(providers.data?.length ? providers.data : [{ name: draft.modelProvider, models: [], defaultModel: draft.modelName, error: null }]).map(
                  (provider) => (
                    <option key={provider.name} value={provider.name}>
                      {provider.name}
                    </option>
                  ),
                )}
              </Select>
              <Select
                id="agent-model"
                value={draft.modelName}
                onChange={(event) => set("modelName", event.target.value)}
              >
                {(catalogue?.models.length ? catalogue.models : draft.modelName ? [draft.modelName] : []).map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
        </div>

        <Field
          label="System prompt"
          htmlFor="agent-prompt"
          hint="The instruction block sent ahead of conversation history on every turn."
        >
          <Textarea
            id="agent-prompt"
            value={draft.systemPrompt}
            rows={5}
            placeholder="You triage inbound support messages…"
            onChange={(event) => set("systemPrompt", event.target.value)}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Slider
            label="Temperature"
            min={0}
            max={1}
            step={0.05}
            value={draft.temperature}
            onChange={(value) => set("temperature", value)}
          />
          <Field label="Max output tokens" htmlFor="agent-max">
            <Input
              id="agent-max"
              type="number"
              min={64}
              max={8192}
              step={64}
              value={draft.maxOutputTokens}
              onChange={(event) => set("maxOutputTokens", Number(event.target.value) || 0)}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Tool rounds"
            htmlFor="agent-steps"
            hint="How many model rounds one turn may take. The cap stops a turn that keeps calling tools."
          >
            <Input
              id="agent-steps"
              type="number"
              min={1}
              max={10}
              step={1}
              value={draft.maxToolSteps}
              onChange={(event) => set("maxToolSteps", Math.max(1, Math.min(10, Number(event.target.value) || 1)))}
            />
          </Field>
          <Field label="Per-turn tokens" htmlFor="agent-turn-budget" hint="0 means no limit. Crossing it fails the turn after the round that cost it — those rounds stay billed.">
            <Input
              id="agent-turn-budget"
              type="number"
              min={0}
              max={10_000_000}
              step={1000}
              value={draft.perTurnTokenBudget}
              onChange={(event) => set("perTurnTokenBudget", Math.max(0, Number(event.target.value) || 0))}
            />
          </Field>
          <Field label="Daily tokens" htmlFor="agent-day-budget" hint="0 means no limit. Counted from the usage ledger at UTC midnight, so a heavy knowledge turn is visible where it was spent.">
            <Input
              id="agent-day-budget"
              type="number"
              min={0}
              max={100_000_000}
              step={10_000}
              value={draft.dailyTokenBudget}
              onChange={(event) => set("dailyTokenBudget", Math.max(0, Number(event.target.value) || 0))}
            />
          </Field>
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[12px] text-muted-foreground">
          <HugeiconsIcon icon={CpuIcon} size={15} strokeWidth={1.6} />
          {draft.modelProvider} · {draft.modelName} · temp {draft.temperature.toFixed(2)} · ≤
          {draft.maxOutputTokens} tokens per reply · ≤{draft.maxToolSteps} rounds
          {draft.perTurnTokenBudget > 0 ? ` · ${draft.perTurnTokenBudget}/turn` : ""}
          {draft.dailyTokenBudget > 0 ? ` · ${draft.dailyTokenBudget}/day` : ""}
        </div>
      </div>
    </Dialog>
  );
}

export function AgentDangerRow({
  agent,
  busy,
  onPause,
  onEdit,
  onDelete,
}: {
  agent: Agent;
  busy: boolean;
  onPause: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium">{agent.name}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">{agent.id}</p>
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onPause}>
          <HugeiconsIcon icon={PauseIcon} size={14} strokeWidth={1.6} />
          Pause
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onEdit}>
          <HugeiconsIcon icon={Edit01Icon} size={14} strokeWidth={1.6} />
          Edit
        </Button>
        <Button variant="destructive" size="sm" onClick={onDelete} disabled={busy}>
          <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.6} />
          Delete
        </Button>
      </div>
    </div>
  );
}
