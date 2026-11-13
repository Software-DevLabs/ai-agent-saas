import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { useSaveWorkflow } from "@/lib/queries";

/**
 * Creating a workflow makes an empty graph, then opens it. A row has to exist
 * before the canvas has an id to save against, so the name is asked for here and
 * the nodes are drawn afterwards — inventing a starter node would put a reference
 * in the graph that nobody chose.
 */
export function WorkflowFormDialog({
  open,
  projectId,
  onClose,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const save = useSaveWorkflow();
  const navigate = useNavigate();
  const valid = name.trim().length > 1 && name.trim().length <= 80;

  function submit() {
    if (!valid) return;
    save.mutate(
      {
        projectId,
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
      },
      {
        onSuccess: (created) => {
          setName("");
          setDescription("");
          onClose();
          navigate(`/projects/${projectId}/workflows/${created.id}`);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New workflow"
      description="It starts empty and is saved as a draft. Nothing it wires can run until it is activated, and activation only succeeds when every rule the server checks passes."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={submit}>
            Create and open
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" htmlFor="workflow-name" hint="Unique within this project. 80 characters at most.">
          <Input
            id="workflow-name"
            value={name}
            maxLength={80}
            placeholder="Telegram to support agent"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field label="Description" htmlFor="workflow-description" className="space-y-1.5">
          <Textarea
            id="workflow-description"
            rows={3}
            maxLength={500}
            value={description}
            placeholder="What this graph is for"
            onChange={(event) => setDescription(event.target.value)}
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
