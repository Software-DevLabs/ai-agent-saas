import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import type { IconSvgElement } from "@hugeicons/react";
import ArrowRight02Icon from "@hugeicons/core-free-icons/ArrowRight02Icon";
import ApiIcon from "@hugeicons/core-free-icons/ApiIcon";
import BotIcon from "@hugeicons/core-free-icons/BotIcon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import Edit01Icon from "@hugeicons/core-free-icons/Edit01Icon";
import Flowchart02Icon from "@hugeicons/core-free-icons/Flowchart02Icon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon";
import { PageTransition } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { ProjectFormDialog } from "@/components/projects/project-form";
import { BentoCard } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState, QueryState } from "@/components/ui/states";
import { useDeleteProject, useProjects } from "@/lib/queries";
import type { Project } from "@/lib/domain";
import { formatDate } from "@/lib/utils";

function CountChip({ icon, label, value }: { icon: IconSvgElement; label: string; value: number }) {
  return (
    <Badge tone="neutral">
      <HugeiconsIcon icon={icon} size={11} strokeWidth={1.8} />
      <span className="font-mono tabular">{value}</span>
      {label}
    </Badge>
  );
}

function ProjectTile({
  project,
  onEdit,
  onDelete,
}: {
  project: Project;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <BentoCard className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground">
            <HugeiconsIcon icon={Folder01Icon} size={15} strokeWidth={1.6} />
          </span>
          <div className="min-w-0">
            <Link to={`/projects/${project.id}`} className="block truncate text-[14px] font-semibold hover:underline">
              {project.name}
            </Link>
            <p className="truncate font-mono text-[11px] text-muted-foreground">{project.id}</p>
          </div>
        </div>
        {project.isDefault && <Badge tone="info">default</Badge>}
      </div>

      <p className="line-clamp-2 min-h-[34px] text-[12.5px] leading-relaxed text-muted-foreground">
        {project.description ?? "No description."}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        <CountChip icon={BotIcon} label="agents" value={project.counts.agents} />
        <CountChip icon={ApiIcon} label="connections" value={project.counts.integrations} />
        <CountChip icon={Flowchart02Icon} label="workflows" value={project.counts.workflows} />
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {formatDate(project.createdAt)}
        </span>
      </div>

      <div className="flex items-center gap-1.5 border-t border-border pt-3">
        <Button size="sm" variant="ghost" onClick={onEdit}>
          <HugeiconsIcon icon={Edit01Icon} size={14} strokeWidth={1.6} />
          Edit
        </Button>
        <Button size="icon" variant="ghost" aria-label={`Delete ${project.name}`} onClick={onDelete}>
          <HugeiconsIcon icon={Delete02Icon} size={15} strokeWidth={1.6} />
        </Button>
        <Link to={`/projects/${project.id}`} className="ml-auto">
          <Button size="sm" variant="outline">
            Open
            <HugeiconsIcon icon={ArrowRight02Icon} size={14} strokeWidth={1.6} />
          </Button>
        </Link>
      </div>
    </BentoCard>
  );
}

export default function ProjectsPage() {
  const projects = useProjects();
  const remove = useDeleteProject();
  const [search, setSearch] = useSearchParams();
  const [creating, setCreating] = useState(() => search.get("new") === "1");
  const [editing, setEditing] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);

  // The sidebar's Create menu deep-links here with ?new=1.
  useEffect(() => {
    if (search.get("new") === "1") setCreating(true);
  }, [search]);

  const closeCreate = () => {
    setCreating(false);
    if (search.has("new")) {
      search.delete("new");
      setSearch(search, { replace: true });
    }
  };

  const rows = projects.data ?? [];

  return (
    <>
      <PageTransition>
        <div className="space-y-5">
          <PageHeader
            title="Projects"
            description="A project owns the agents and connections a workflow is allowed to wire together."
            actions={
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={1.8} />
                New project
              </Button>
            }
          />

          <QueryState error={projects.error} pending={projects.isPending}>
            {rows.length === 0 ? (
              <BentoCard interactive={false} className="bg-card">
                <EmptyState
                  title="No projects"
                  body="Every workspace carries one default project holding whatever already exists. Create another to group a new effort."
                  actionLabel="New project"
                  onAction={() => setCreating(true)}
                />
              </BentoCard>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {rows.map((project) => (
                  <ProjectTile
                    key={project.id}
                    project={project}
                    onEdit={() => setEditing(project)}
                    onDelete={() => {
                      remove.reset();
                      setDeleting(project);
                    }}
                  />
                ))}
              </div>
            )}
          </QueryState>
        </div>
      </PageTransition>

      {/* Rendered outside PageTransition: the entrance animation leaves a filter
          on the element, and a filtered ancestor is the containing block a
          `position: fixed` dialog would be trapped inside. */}
      {creating && <ProjectFormDialog open onClose={closeCreate} />}
      {editing && <ProjectFormDialog open project={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        danger
        title={`Delete ${deleting?.name ?? "project"}?`}
        body={
          remove.isError
            ? remove.error instanceof Error
              ? remove.error.message
              : "the request failed"
            : "A project is only deleted once it holds no agents, connections or workflows. Nothing inside is moved or removed automatically."
        }
        confirmLabel="Delete project"
        busy={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) {
            remove.mutate(deleting.id, {
              onSuccess: () => setDeleting(null),
            });
          }
        }}
      />
    </>
  );
}
