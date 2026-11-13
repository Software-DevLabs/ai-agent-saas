import { useState } from "react";
import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import ChevronLeftIcon from "@hugeicons/core-free-icons/ChevronLeftIcon";
import PauseIcon from "@hugeicons/core-free-icons/PauseIcon";
import RefreshCcwIcon from "@hugeicons/core-free-icons/RefreshCcwIcon";
import SaveIcon from "@hugeicons/core-free-icons/SaveIcon";
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import ZapIcon from "@hugeicons/core-free-icons/ZapIcon";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import type { Project, WorkerState, Workflow, WorkflowStatus } from "@/lib/domain";
import { formatDate } from "@/lib/utils";

/**
 * The strip above the board.
 *
 * Two of the labels here exist because the alternative is a lie. "Not wired to a
 * worker" stays on screen while there is no process to claim a run, and Save is
 * offered separately from Activate because a graph can be saved while it is
 * still unfinished — it is activation that has to pass every rule.
 */
export function Toolbar({
  project,
  workflow,
  worker,
  dirty,
  saving,
  validating,
  statusBusy,
  error,
  conflicted,
  onSave,
  onValidate,
  onStatus,
  onRename,
  onReload,
}: {
  project: Project | null;
  workflow: Workflow | null;
  /** Read from the worker's own heartbeat, never assumed. */
  worker: WorkerState | null;
  dirty: boolean;
  saving: boolean;
  validating: boolean;
  statusBusy: boolean;
  error: string | null;
  conflicted: boolean;
  onSave: () => void;
  onValidate: () => void;
  onStatus: (status: WorkflowStatus) => void;
  onRename: (name: string) => void;
  onReload: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(workflow?.name ?? "");

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (workflow && next !== "" && next !== workflow.name) onRename(next);
    else setDraft(workflow?.name ?? "");
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-card px-4 py-2.5">
      <Link
        to={project ? `/projects/${project.id}` : "/projects"}
        className="flex items-center gap-1 text-[12px] font-medium text-muted-foreground hover:text-foreground"
      >
        <HugeiconsIcon icon={ChevronLeftIcon} size={13} strokeWidth={1.8} />
        {project?.name ?? "Project"}
      </Link>

      <div className="min-w-0 flex-1 basis-full sm:basis-0">
        {editing ? (
          <Input
            autoFocus
            value={draft}
            maxLength={80}
            onBlur={commit}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              if (event.key === "Escape") {
                setDraft(workflow?.name ?? "");
                setEditing(false);
              }
            }}
            className="h-7 max-w-[280px] text-[13px] font-semibold"
            aria-label="Workflow name"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft(workflow?.name ?? "");
              setEditing(true);
            }}
            title="Rename this workflow"
            className="max-w-full truncate text-left text-[14px] font-semibold tracking-tight hover:text-muted-foreground"
          >
            {workflow?.name ?? "Loading…"}
          </button>
        )}
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {workflow ? (
            <>
              v{workflow.version} · {dirty ? "unsaved changes" : `saved ${formatDate(workflow.updatedAt)}`}
            </>
          ) : (
            "—"
          )}
        </p>
      </div>

      {workflow && <StatusBadge status={workflow.status} />}
      {worker === null ? null : worker.alive ? (
        <span title={`${worker.workerId ?? "a worker"} · ${worker.jobs.queued} queued`}>
          <Badge tone="success">worker alive</Badge>
        </span>
      ) : (
        <span title="Start it with pnpm dev:worker">
          <Badge tone="warning">no worker — nothing would run</Badge>
        </span>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="outline" onClick={onReload} title="Reload the server's copy">
          <HugeiconsIcon icon={RefreshCcwIcon} size={13} strokeWidth={1.7} />
          Reload
        </Button>
        <Button size="sm" variant="outline" loading={validating} onClick={onValidate}>
          <HugeiconsIcon icon={CheckmarkCircle02Icon} size={13} strokeWidth={1.7} />
          Validate
        </Button>
        <Button size="sm" variant={dirty ? "primary" : "outline"} loading={saving} disabled={!dirty} onClick={onSave}>
          <HugeiconsIcon icon={SaveIcon} size={13} strokeWidth={1.7} />
          Save
        </Button>
        {workflow?.status === "ACTIVE" ? (
          <Button size="sm" variant="secondary" loading={statusBusy} onClick={() => onStatus("PAUSED")}>
            <HugeiconsIcon icon={PauseIcon} size={13} strokeWidth={1.7} />
            Pause
          </Button>
        ) : (
          <Button size="sm" variant="primary" loading={statusBusy} onClick={() => onStatus("ACTIVE")}>
            <HugeiconsIcon icon={ZapIcon} size={13} strokeWidth={1.7} />
            Activate
          </Button>
        )}
      </div>

      {(error || conflicted) && (
        <p className="w-full font-mono text-[11px] leading-relaxed text-destructive">
          {conflicted ? "This graph changed on the server. Reload before editing again — your copy is stale. " : ""}
          {error}
        </p>
      )}
    </div>
  );
}
