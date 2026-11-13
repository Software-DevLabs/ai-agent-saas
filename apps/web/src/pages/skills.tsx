import { Fragment, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import Edit01Icon from "@hugeicons/core-free-icons/Edit01Icon";
import LockIcon from "@hugeicons/core-free-icons/LockIcon";
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import ZapIcon from "@hugeicons/core-free-icons/ZapIcon";
import { ApiError } from "@/lib/api";
import { PageTransition } from "@/components/layout/app-shell";
import { SkillFormDialog } from "@/components/skills/skill-form";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, QueryState } from "@/components/ui/states";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { useDeleteSkill, usePublishSkill, useSetSkillStatus, useSkills } from "@/lib/queries";
import type { Skill } from "@/lib/domain";

/**
 * The skill library.
 *
 * Built-ins and the tenant's own rows share one table because they share one
 * resolution path: a grant names a key, and the assembler answers with whichever
 * body is published under it. What differs is editability — a built-in is part of
 * the build, so it cannot be changed or deleted from here, only granted or not.
 */

const reason = (error: unknown): string => (error instanceof ApiError ? error.message : String(error));

export default function SkillsPage() {
  const skills = useSkills();
  const publish = usePublishSkill();
  const setStatus = useSetSkillStatus();
  const remove = useDeleteSkill();
  const [search, setSearch] = useSearchParams();

  const [creating, setCreating] = useState(() => search.get("new") === "1");
  const [editing, setEditing] = useState<Skill | null>(null);
  const [deleting, setDeleting] = useState<Skill | null>(null);
  const [openBody, setOpenBody] = useState<string | null>(null);
  // The publish answer distinguishes "a new version was frozen" from "your text
  // already was the live one", and that difference is worth saying out loud.
  const [notice, setNotice] = useState<string | null>(null);

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

  const rows = skills.data ?? [];

  function doPublish(skill: Skill) {
    publish.mutate(skill.id, {
      onSuccess: (saved) =>
        setNotice(
          saved.unchanged
            ? `“${skill.name}” v${saved.published?.version ?? saved.latestVersion} already says exactly this — nothing new was frozen.`
            : `Frozen as v${saved.published?.version ?? saved.latestVersion}. Agents granted this skill now read that body, not the draft.`,
        ),
      onError: (error) => setNotice(reason(error)),
    });
  }

  return (
    <PageTransition>
      <PageHeader
        title="Skills"
        description="Reusable instructions an agent reads on demand. The catalogue line costs a few tokens per turn; the body is only loaded when the model opens it."
        meta={<Badge tone="neutral">{rows.length} skill{rows.length === 1 ? "" : "s"}</Badge>}
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={1.6} />
            New skill
          </Button>
        }
      />

      {notice && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[12px] leading-relaxed">
          <HugeiconsIcon icon={Alert02Icon} size={14} strokeWidth={1.6} />
          <span className="text-muted-foreground">{notice}</span>
          <button type="button" className="ml-auto text-[11px] underline-offset-2 hover:underline" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </div>
      )}

      <QueryState error={skills.error} pending={skills.isPending}>
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <HugeiconsIcon icon={Task01Icon} size={15} strokeWidth={1.6} />
                Catalogue
              </CardTitle>
              <CardDescription>
                Publishing is the only thing that makes an edit live. A draft you save here changes nothing an agent
                does until it is published as a new version.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {rows.length === 0 ? (
              <EmptyState
                title="No skills yet"
                body="Two built-ins ship with the build, so an empty table here means the API could not be reached rather than that nothing exists."
                actionLabel="New skill"
                onAction={() => setCreating(true)}
              />
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <THead>
                    <TR>
                      <TH>Skill</TH>
                      <TH>Status</TH>
                      <TH>Live version</TH>
                      <TH>Needs</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <tbody>
                    {rows.map((skill) => {
                      const builtin = skill.origin === "BUILTIN";
                      const expanded = openBody === skill.id;
                      return (
                        <Fragment key={skill.id}>
                          <TR className="align-top">
                            <TD>
                              <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                                {skill.name}
                                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{skill.key}</code>
                                {skill.core && <Badge tone="warning">core</Badge>}
                                {builtin && (
                                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                                    <HugeiconsIcon icon={LockIcon} size={11} strokeWidth={1.6} />
                                    built-in
                                  </span>
                                )}
                              </p>
                              <p className="mt-1 max-w-prose text-[12px] leading-relaxed text-muted-foreground">
                                {skill.description}
                              </p>
                              {skill.warnings.length > 0 && (
                                <ul className="mt-1.5 space-y-0.5">
                                  {skill.warnings.map((warning) => (
                                    <li key={warning} className="text-[11.5px] leading-relaxed text-warning">
                                      {warning}
                                    </li>
                                  ))}
                                </ul>
                              )}
                              <button
                                type="button"
                                className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] text-muted-foreground underline-offset-2 hover:underline"
                                onClick={() => setOpenBody(expanded ? null : skill.id)}
                              >
                                <HugeiconsIcon icon={ZapIcon} size={12} strokeWidth={1.6} />
                                {expanded ? "Hide" : "Show"} the {builtin ? "built-in" : "draft"} body
                              </button>
                            </TD>
                            <TD>
                              <StatusBadge status={skill.status} />
                            </TD>
                            <TD>
                              {skill.published === null ? (
                                <span className="text-[12px] text-muted-foreground">nothing published</span>
                              ) : (
                                <span className="font-mono text-[11.5px] text-muted-foreground">
                                  v{skill.published.version} · {skill.published.hash.slice(0, 8)}
                                </span>
                              )}
                            </TD>
                            <TD>
                              <div className="flex flex-wrap gap-1.5">
                                {skill.requires.map((requirement) => (
                                  <Badge key={requirement} tone="info">
                                    {requirement}
                                  </Badge>
                                ))}
                                {skill.tools.map((tool) => (
                                  <Badge key={tool} tone="neutral">
                                    {tool}
                                  </Badge>
                                ))}
                                {skill.requires.length + skill.tools.length === 0 && (
                                  <span className="text-[12px] text-muted-foreground">nothing</span>
                                )}
                              </div>
                            </TD>
                            <TD>
                              <div className="flex flex-wrap justify-end gap-1.5">
                                {!builtin && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    loading={publish.isPending && publish.variables === skill.id}
                                    onClick={() => doPublish(skill)}
                                  >
                                    Publish
                                  </Button>
                                )}
                                {!builtin && skill.status !== "ARCHIVED" && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={setStatus.isPending}
                                    onClick={() => setStatus.mutate({ id: skill.id, status: "ARCHIVED" })}
                                  >
                                    Archive
                                  </Button>
                                )}
                                {!builtin && skill.status === "ARCHIVED" && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={setStatus.isPending}
                                    onClick={() => setStatus.mutate({ id: skill.id, status: "PUBLISHED" })}
                                  >
                                    Unarchive
                                  </Button>
                                )}
                                {!builtin && (
                                  <>
                                    <Button variant="ghost" size="sm" onClick={() => setEditing(skill)}>
                                      <HugeiconsIcon icon={Edit01Icon} size={14} strokeWidth={1.6} />
                                      Edit
                                    </Button>
                                    <Button variant="ghost" size="sm" onClick={() => setDeleting(skill)}>
                                      <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.6} />
                                      Delete
                                    </Button>
                                  </>
                                )}
                              </div>
                            </TD>
                          </TR>
                          {expanded && (
                            <TR>
                              {/* `Table`'s TD takes no colSpan, and a body that wraps
                                  inside one column reads as a broken cell. */}
                              <td className="bg-muted/30 px-3 py-3 align-top" colSpan={5}>
                                <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background/60 p-3 font-mono text-[11.5px] leading-relaxed text-foreground/90">
                                  {skill.instructions}
                                </pre>
                                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                                  {builtin
                                    ? "This text is in the build; it is what an agent reads, version 1, and it cannot be edited from the console."
                                    : skill.published === null
                                      ? "This is the draft. Nothing reads it yet — publish it to make it live."
                                      : "This is the draft. An agent reads the published version above, which may say something different."}
                                </p>
                              </td>
                            </TR>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </Table>
              </div>
            )}

            {(setStatus.isError || remove.isError) && (
              <p className="text-[12px] text-destructive">{reason(setStatus.error ?? remove.error)}</p>
            )}
          </CardContent>
        </Card>
      </QueryState>

      {creating && <SkillFormDialog open onClose={closeCreate} skill={null} />}
      {editing && (
        <SkillFormDialog
          key={editing.id}
          open
          skill={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => setNotice(`Saved the draft of “${saved.name}”. It is live only once published.`)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete “${deleting?.name ?? ""}”?`}
        body="The published versions go with it. Agents that were granted it keep their grant row and report it as unavailable, which is the honest answer rather than a silent one."
        confirmLabel="Delete skill"
        danger
        busy={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              setNotice(`“${deleting.name}” is gone.`);
              setDeleting(null);
            },
            onError: (error) => setNotice(reason(error)),
          });
        }}
      />
    </PageTransition>
  );
}
