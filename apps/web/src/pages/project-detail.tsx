import { useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import AddIcon from "@hugeicons/core-free-icons/Add01Icon";
import ApiIcon from "@hugeicons/core-free-icons/ApiIcon";
import BotIcon from "@hugeicons/core-free-icons/BotIcon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import Edit01Icon from "@hugeicons/core-free-icons/Edit01Icon";
import Flowchart02Icon from "@hugeicons/core-free-icons/Flowchart02Icon";
import Folder01Icon from "@hugeicons/core-free-icons/Folder01Icon";
import { PageTransition } from "@/components/layout/app-shell";
import { PageHeader } from "@/components/ui/page-header";
import { ProjectFormDialog } from "@/components/projects/project-form";
import { AgentFormDialog } from "@/components/agents/agent-form";
import { WorkflowFormDialog } from "@/components/workflow/workflow-form";
import { InsightsPanel } from "@/components/projects/insights-panel";
import { SheetsPanel } from "@/components/projects/sheets-panel";
import { BentoCard, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { EmptyState, QueryState } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import {
  CHANNEL_CATALOG,
  useDeleteProject,
  useProject,
  useProjectAgents,
  useProjectIntegrations,
  useProjectWorkflows,
  useSaveProject,
} from "@/lib/queries";
import type { Project, ProjectDraft } from "@/lib/domain";
import { formatDate, formatTokens } from "@/lib/utils";

const TABS = [
  { id: "agents", label: "Agents" },
  { id: "insights", label: "Insights" },
  { id: "sheets", label: "Sheets" },
  { id: "connections", label: "Connections" },
  { id: "workflows", label: "Workflows" },
  { id: "settings", label: "Settings" },
];

function Row({ title, meta, status, children }: { title: string; meta: string; status?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium">{title}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">{meta}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {status}
        {children}
      </div>
    </div>
  );
}

function ProjectSettings({ project }: { project: Project }) {
  const [draft, setDraft] = useState<ProjectDraft>({ name: project.name, description: project.description ?? "" });
  const save = useSaveProject();
  const set = <K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const dirty =
    draft.name.trim() !== project.name || (draft.description.trim() === "" ? null : draft.description.trim()) !== project.description;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Project details</CardTitle>
          <CardDescription>
            The name is unique within the workspace, so it is what the workflow builder will show when it lists
            this project's owners.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="project-name">
            <Input
              id="project-name"
              value={draft.name}
              maxLength={80}
              onChange={(event) => set("name", event.target.value)}
            />
          </Field>
          <Field
            label="Description"
            htmlFor="project-description"
            hint={project.isDefault ? "This is the backfilled default project; it can be renamed but not emptied by accident." : undefined}
          >
            <Input
              id="project-description"
              value={draft.description}
              maxLength={500}
              placeholder="Optional"
              onChange={(event) => set("description", event.target.value)}
            />
          </Field>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || draft.name.trim().length < 2}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                {
                  id: project.id,
                  name: draft.name.trim(),
                  description: draft.description.trim() === "" ? null : draft.description.trim(),
                },
                {
                  onSuccess: (saved) => {
                    setDraft({ name: saved.name, description: saved.description ?? "" });
                  },
                },
              )
            }
          >
            Save changes
          </Button>
          {save.isError && (
            <p className="font-mono text-[12px] text-destructive">
              {save.error instanceof Error ? save.error.message : "the request failed"}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const project = useProject(id);
  const agents = useProjectAgents(id);
  const integrations = useProjectIntegrations(id);
  const workflows = useProjectWorkflows(id);
  const remove = useDeleteProject();
  const [tab, setTab] = useState("agents");
  const [editing, setEditing] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [creatingWorkflow, setCreatingWorkflow] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <>
      <PageTransition>
        <QueryState error={project.error} pending={project.isPending}>
          {project.data && (
            <div className="space-y-5">
              <PageHeader
                title={project.data.name}
                leading={
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-primary shadow-card">
                    <HugeiconsIcon icon={Folder01Icon} size={20} strokeWidth={1.5} />
                  </span>
                }
                meta={project.data.isDefault ? <Badge tone="info">default</Badge> : undefined}
                description={
                  <>
                    <span className="block font-mono text-[12px]">
                      {project.data.id} · created {formatDate(project.data.createdAt)}
                    </span>
                    {project.data.description ? <span className="mt-1 block">{project.data.description}</span> : null}
                  </>
                }
                actions={
                  <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                    <HugeiconsIcon icon={Edit01Icon} size={14} strokeWidth={1.6} />
                    Edit
                  </Button>
                }
              />

              <div className="grid gap-4 sm:grid-cols-3">
                <BentoCard interactive={false}>
                  <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <HugeiconsIcon icon={BotIcon} size={13} strokeWidth={1.6} /> Agents
                  </p>
                  <p className="mt-1.5 font-mono text-[22px] tabular leading-none">{project.data.counts.agents}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">prompts this project may wire up</p>
                </BentoCard>
                <BentoCard interactive={false}>
                  <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <HugeiconsIcon icon={ApiIcon} size={13} strokeWidth={1.6} /> Connections
                  </p>
                  <p className="mt-1.5 font-mono text-[22px] tabular leading-none">{project.data.counts.integrations}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">channels with a stored credential</p>
                </BentoCard>
                <BentoCard interactive={false}>
                  <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <HugeiconsIcon icon={Flowchart02Icon} size={13} strokeWidth={1.6} /> Workflows
                  </p>
                  <p className="mt-1.5 font-mono text-[22px] tabular leading-none">{project.data.counts.workflows}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">graphs saved in this project</p>
                </BentoCard>
              </div>

              <Tabs
                tabs={TABS.map((entry) => ({
                  ...entry,
                  count:
                    entry.id === "agents"
                      ? project.data!.counts.agents
                      : entry.id === "connections"
                        ? project.data!.counts.integrations
                        : entry.id === "workflows"
                          ? project.data!.counts.workflows
                          : undefined,
                }))}
                active={tab}
                onChange={setTab}
                className="w-fit rounded-lg border border-border bg-card p-1"
              />

              {tab === "agents" && (
                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>Agents in this project</CardTitle>
                      <CardDescription>Only these agents will be offered to the workflow builder.</CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => setCreatingAgent(true)}>
                        <HugeiconsIcon icon={AddIcon} size={14} strokeWidth={1.7} />
                        New agent
                      </Button>
                      <Link to="/agents">
                        <Button variant="ghost" size="sm">
                          Manage agents
                        </Button>
                      </Link>
                    </div>
                  </CardHeader>
                  <CardContent className="grid gap-3 sm:grid-cols-2">
                    <QueryState error={agents.error} pending={agents.isPending}>
                      {(agents.data ?? []).length === 0 ? (
                        <EmptyState
                          title="No agents here"
                          body="An agent made from this page belongs to this project, and the workflow builder only offers this project's agents."
                          actionLabel="New agent"
                          onAction={() => setCreatingAgent(true)}
                        />
                      ) : (
                        <ul className="grid gap-3">
                          {(agents.data ?? []).map((agent) => (
                            <li key={agent.id}>
                              <Row
                                title={agent.name}
                                meta={`${agent.modelProvider}/${agent.modelName} · ${formatTokens(agent.tokensThisCycle)} tokens this cycle`}
                                status={<StatusBadge status={agent.status} />}
                              >
                                <Link to={`/agents/${agent.id}`}>
                                  <Button size="sm" variant="outline">
                                    Open
                                  </Button>
                                </Link>
                              </Row>
                            </li>
                          ))}
                        </ul>
                      )}
                    </QueryState>
                  </CardContent>
                </Card>
              )}

              {tab === "insights" && <InsightsPanel projectId={project.data.id} />}

              {tab === "sheets" && <SheetsPanel projectId={project.data.id} />}

              {tab === "connections" && (
                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>Connections in this project</CardTitle>
                      <CardDescription>
                        An inbound channel feeds an agent, an outbound one receives its reply. Direction comes from the
                        channel type itself.
                      </CardDescription>
                    </div>
                    <Link to="/connections">
                      <Button variant="ghost" size="sm">
                        Manage connections
                      </Button>
                    </Link>
                  </CardHeader>
                  <CardContent className="grid gap-3 sm:grid-cols-2">
                    <QueryState error={integrations.error} pending={integrations.isPending}>
                      {(integrations.data ?? []).length === 0 ? (
                        <EmptyState
                          title="No connections here"
                          body="A connection stores one credential, encrypted at rest, and belongs to exactly one project."
                        />
                      ) : (
                        <ul className="grid gap-3">
                          {(integrations.data ?? []).map((integration) => {
                            const meta = CHANNEL_CATALOG.find((entry) => entry.type === integration.type);
                            return (
                              <li key={integration.id}>
                                <Row
                                  title={meta?.label ?? integration.type}
                                  meta={`${integration.externalId ?? "no external id"} · ${integration.credentialPreview ?? "no secret stored"}`}
                                  status={<StatusBadge status={integration.status} />}
                                >
                                  <Badge tone="neutral">{meta?.direction === "INPUT" ? "in" : "out"}</Badge>
                                </Row>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </QueryState>
                  </CardContent>
                </Card>
              )}

              {tab === "workflows" && (
                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>Workflows in this project</CardTitle>
                      <CardDescription>
                        A graph wires this project's inbound channels to its agents and their sinks. It is saved server
                        side and validated before it can be activated.
                      </CardDescription>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setCreatingWorkflow(true)}>
                      <HugeiconsIcon icon={AddIcon} size={14} strokeWidth={1.7} />
                      New workflow
                    </Button>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    <QueryState error={workflows.error} pending={workflows.isPending}>
                      {(workflows.data ?? []).length === 0 ? (
                        <EmptyState
                          title="Nothing wired yet"
                          body="A workflow starts as an empty canvas. Nodes can only be drawn from the agents and connections this project owns."
                          actionLabel="New workflow"
                          onAction={() => setCreatingWorkflow(true)}
                        />
                      ) : (
                        <ul className="grid gap-3 sm:grid-cols-2">
                          {(workflows.data ?? []).map((workflow) => (
                            <li key={workflow.id}>
                              <Row
                                title={workflow.name}
                                meta={`${workflow.id} · v${workflow.version} · updated ${formatDate(workflow.updatedAt)}`}
                                status={<StatusBadge status={workflow.status} />}
                              >
                                <Link to={`/projects/${project.data.id}/workflows/${workflow.id}`}>
                                  <Button size="sm" variant="outline">
                                    Open
                                  </Button>
                                </Link>
                              </Row>
                            </li>
                          ))}
                        </ul>
                      )}
                    </QueryState>
                  </CardContent>
                </Card>
              )}

              {tab === "settings" && (
                <div className="space-y-4">
                  <ProjectSettings project={project.data} />
                  <Card>
                    <CardHeader>
                      <div>
                        <CardTitle>Delete project</CardTitle>
                        <CardDescription>
                          Refused while the project still holds agents, connections or workflows — the database restricts
                          it, so nothing downstream is destroyed by accident.
                        </CardDescription>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={project.data.counts.agents + project.data.counts.integrations + project.data.counts.workflows > 0}
                        onClick={() => {
                          remove.reset();
                          setConfirmingDelete(true);
                        }}
                      >
                        <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.6} />
                        Delete project
                      </Button>
                      {project.data.counts.agents + project.data.counts.integrations + project.data.counts.workflows > 0 && (
                        <p className="mt-2 text-[12px] text-muted-foreground">
                          This project still holds {project.data.counts.agents} agent(s),{" "}
                          {project.data.counts.integrations} connection(s) and {project.data.counts.workflows} workflow(s).
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </div>
              )}
            </div>
          )}
        </QueryState>
      </PageTransition>

      {editing && project.data && (
        <ProjectFormDialog open project={project.data} onClose={() => setEditing(false)} />
      )}
      {creatingAgent && id && (
        <AgentFormDialog open projectId={id} onClose={() => setCreatingAgent(false)} />
      )}
      {creatingWorkflow && id && (
        <WorkflowFormDialog open projectId={id} onClose={() => setCreatingWorkflow(false)} />
      )}
      <ConfirmDialog
        open={confirmingDelete}
        danger
        title={`Delete ${project.data?.name ?? "project"}?`}
        body={
          remove.isError
            ? remove.error instanceof Error
              ? remove.error.message
              : "the request failed"
            : "The project row is removed for good. It only succeeds once nothing is left inside it."
        }
        confirmLabel="Delete project"
        busy={remove.isPending}
        onClose={() => setConfirmingDelete(false)}
        onConfirm={() => {
          if (id) {
            remove.mutate(id, {
              onSuccess: () => navigate("/projects"),
            });
          }
        }}
      />
    </>
  );
}
