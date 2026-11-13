import { useState } from "react";
import { ApiError, errorDetails } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Switch, Textarea } from "@/components/ui/field";
import { useSaveSkill, useSkillRegistry } from "@/lib/queries";
import type { Skill, SkillDraft } from "@/lib/domain";

const reason = (error: unknown): string => (error instanceof ApiError ? error.message : String(error));

/**
 * The skill editor.
 *
 * It does not validate. `POST /skills` runs the same rules the assembler relies on
 * (key charset, description cap, unknown requirement) and answers with the list of
 * what failed, so the form shows *that* rather than a second, slightly different
 * copy of the rules that would let a skill through the browser and refuse it at the
 * database.
 */

const BLANK: SkillDraft = {
  key: "",
  name: "",
  description: "",
  instructions: "",
  requires: [],
  tools: [],
  core: false,
};

const fromSkill = (skill: Skill): SkillDraft => ({
  key: skill.key,
  name: skill.name,
  description: skill.description,
  instructions: skill.instructions,
  requires: [...skill.requires],
  tools: [...skill.tools],
  core: skill.core,
});

export function SkillFormDialog({
  open,
  skill,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Null for a new skill; a tenant row for an edit. A builtin is never passed. */
  skill: Skill | null;
  onClose: () => void;
  onSaved?: (saved: Skill) => void;
}) {
  const registry = useSkillRegistry();
  const save = useSaveSkill();
  const [draft, setDraft] = useState<SkillDraft>(() => (skill ? fromSkill(skill) : { ...BLANK }));

  const set = <K extends keyof SkillDraft>(key: K, value: SkillDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const toggleIn = (list: "requires" | "tools", name: string, on: boolean) =>
    setDraft((current) => ({
      ...current,
      [list]: on ? [...current[list], name] : current[list].filter((entry) => entry !== name),
    }));

  const errors: string[] = save.isError ? (errorDetails<string[]>(save.error) ?? [reason(save.error)]) : [];

  function submit() {
    save.mutate({ ...draft, id: skill?.id }, {
      onSuccess: (saved) => {
        onSaved?.(saved);
        onClose();
      },
    });
  }

  const lineCount = draft.instructions === "" ? 0 : draft.instructions.split(/\r?\n/).length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={skill ? `Edit ${skill.name}` : "New skill"}
      description="The description is the only line that sits in every turn's prompt. The instructions are loaded on demand, when the model opens this skill."
      width="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            {skill ? "Save draft" : "Create skill"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Key"
            htmlFor="skill-key"
            hint={
              skill
                ? "Immutable: the model types it, grants store it and run snapshots name it. A new key is a new skill."
                : `Lowercase letters, digits and single hyphens, ${registry.data?.limits.keyMax ?? 64} characters or fewer.`
            }
          >
            <Input
              id="skill-key"
              value={draft.key}
              placeholder="refund-policy"
              disabled={skill !== null}
              onChange={(event) => set("key", event.target.value)}
            />
          </Field>
          <Field label="Name" htmlFor="skill-name" hint="What the catalogue line shows next to the key.">
            <Input
              id="skill-name"
              value={draft.name}
              placeholder="Refund policy"
              onChange={(event) => set("name", event.target.value)}
            />
          </Field>
        </div>

        <Field
          label="Description"
          htmlFor="skill-description"
          hint={`${draft.description.length} characters — billed into every turn of an agent that holds this skill, whether or not the model reads it.`}
        >
          <Textarea
            id="skill-description"
            value={draft.description}
            rows={2}
            placeholder="When to apply the refund policy, and what this agent may promise about it."
            onChange={(event) => set("description", event.target.value)}
          />
        </Field>

        <Field
          label="Instructions"
          htmlFor="skill-instructions"
          hint={
            registry.data
              ? `${lineCount} line${lineCount === 1 ? "" : "s"} — above ${registry.data.limits.instructionsWarnLines} the body is a document rather than an instruction, and it warns.`
              : "Loading the size limits from the API…"
          }
        >
          <Textarea
            id="skill-instructions"
            value={draft.instructions}
            rows={12}
            placeholder={"Before answering, decide three things:\n1. What outcome they want…\n2. What you know for certain…\n3. The single blocking question, if there is one…"}
            onChange={(event) => set("instructions", event.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-[12.5px] font-medium">Requires</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Something the world has to provide. Unmet here means the skill is listed as unavailable rather than
              offered to the model on trust.
            </p>
            {(registry.data?.requirements ?? []).map((requirement) => (
              <label key={requirement.name} className="flex items-start gap-2 text-[12px]">
                <input
                  type="checkbox"
                  className="mt-1 accent-primary"
                  checked={draft.requires.includes(requirement.name)}
                  onChange={(event) => toggleIn("requires", requirement.name, event.target.checked)}
                />
                <span>
                  <code className="font-mono">{requirement.name}</code>
                  <span className="block text-[11px] text-muted-foreground">{requirement.blurb}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-[12.5px] font-medium">Uses tools</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              What the body tells the model to call. Declaring a tool does not grant it: a skill whose tool the agent
              was not given is dropped, not silently rewritten.
            </p>
            {(registry.data?.tools ?? []).map((tool) => (
              <label key={tool.key} className="flex items-start gap-2 text-[12px]">
                <input
                  type="checkbox"
                  className="mt-1 accent-primary"
                  checked={draft.tools.includes(tool.key)}
                  onChange={(event) => toggleIn("tools", tool.key, event.target.checked)}
                />
                <span>
                  <code className="font-mono">{tool.key}</code>
                  <Badge tone="neutral" className="ml-1.5">{tool.effect}</Badge>
                  <span className="block text-[11px] text-muted-foreground">{tool.label}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-lg border border-border p-3">
          <Switch label="Mark this skill core" checked={draft.core} onChange={(on) => set("core", on)} />
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            <span className="block text-[12.5px] font-medium text-foreground">Core skill</span>
            Core means a public surface refuses to answer at all when this skill is unavailable, instead of degrading
            quietly. It is a gate, not a label.
          </p>
        </div>

        {errors.length > 0 && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
            <p className="text-[12.5px] font-medium text-destructive">The skill cannot be saved</p>
            <ul className="mt-1 space-y-0.5">
              {errors.map((entry) => (
                <li key={entry} className="text-[12px] leading-relaxed text-foreground/80">
                  · {entry}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}
