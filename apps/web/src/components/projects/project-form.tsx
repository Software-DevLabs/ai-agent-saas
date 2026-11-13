import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { useSaveProject } from "@/lib/queries";
import type { Project, ProjectDraft } from "@/lib/domain";

const BLANK: ProjectDraft = { name: "", description: "" };

/**
 * One dialog for both create and edit. `description` is sent as `null` when the
 * box is empty because the column is nullable and an empty string would be a
 * different thing from nothing on the next read.
 */
export function ProjectFormDialog({
  open,
  project,
  onClose,
}: {
  open: boolean;
  project?: Project;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ProjectDraft>(
    project ? { name: project.name, description: project.description ?? "" } : BLANK,
  );
  const save = useSaveProject();
  const valid = draft.name.trim().length > 1 && draft.name.trim().length <= 80;

  const set = <K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  function submit() {
    if (!valid) return;
    save.mutate(
      { name: draft.name.trim(), description: draft.description.trim() === "" ? null : draft.description.trim(), id: project?.id },
      {
        onSuccess: () => {
          setDraft(BLANK);
          onClose();
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={project ? `Rename ${project.name}` : "New project"}
      description="A project owns the agents and connections its workflows are allowed to wire together."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={submit}>
            {project ? "Save changes" : "Create project"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" htmlFor="project-name" hint="Unique within the workspace. 80 characters at most.">
          <Input
            id="project-name"
            value={draft.name}
            maxLength={80}
            placeholder="Support Automation"
            onChange={(event) => set("name", event.target.value)}
          />
        </Field>

        <Field label="Description" htmlFor="project-description" className="space-y-1.5">
          <Textarea
            id="project-description"
            rows={3}
            maxLength={500}
            value={draft.description}
            placeholder="What this project is for"
            onChange={(event) => set("description", event.target.value)}
          />
        </Field>

        {save.isError && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-[12px] text-destructive">
            {save.error instanceof Error ? save.error.message : "the request failed"}
          </p>
        )}
      </div>
    </Dialog>
  );
}
