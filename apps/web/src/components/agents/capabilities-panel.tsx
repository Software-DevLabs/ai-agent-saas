import { useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon";
import FunctionIcon from "@hugeicons/core-free-icons/FunctionIcon";
import InfoIcon from "@hugeicons/core-free-icons/InfoIcon";
import LockIcon from "@hugeicons/core-free-icons/LockIcon";
import RefreshIcon from "@hugeicons/core-free-icons/RefreshIcon";
import SaveIcon from "@hugeicons/core-free-icons/SaveIcon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import StarIcon from "@hugeicons/core-free-icons/StarIcon";
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import { ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CodeBlock } from "@/components/ui/code-block";
import { Select, Switch } from "@/components/ui/field";
import { EmptyState, QueryState } from "@/components/ui/states";
import { Progress } from "@/components/ui/progress";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import { useCapabilities, useCapabilityPreview, useSaveCapabilities } from "@/lib/queries";
import type { CapabilityKind, CapabilityView, GrantInput } from "@/lib/domain";

/**
 * The capability panel: what this agent is allowed to do, edited as one set.
 *
 * It is a *replace-all* editor on purpose. Merging two tabs' ideas of the grant
 * list is how an unticked skill comes back on the next page load, so the console
 * sends exactly what it is showing and the server's answer is what is displayed
 * afterwards — including the parts of it this build refused to honour.
 */

const signature = (grants: GrantInput[]): string =>
  grants
    .map((grant) => `${grant.kind}:${grant.ref}`)
    .sort()
    .join("|");

/** The grants that are live on the server, as the editor's starting point. */
function savedGrants(view: CapabilityView | undefined): GrantInput[] {
  return (view?.grants ?? []).filter((grant) => grant.enabled).map((grant) => ({ kind: grant.kind, ref: grant.ref }));
}

/**
 * A signature is `KIND:ref` entries joined by `|`, so it is its own parser: the
 * editor can be reset from it without reaching back at the query result, which is
 * what keeps a refetch that changed nothing from discarding an edit in progress.
 */
function grantsFrom(signatureText: string): GrantInput[] {
  if (signatureText === "") return [];
  return signatureText.split("|").map((entry) => {
    const colon = entry.indexOf(":");
    return { kind: entry.slice(0, colon) as GrantInput["kind"], ref: entry.slice(colon + 1) };
  });
}

const reason = (error: unknown): string => (error instanceof ApiError ? error.message : String(error));

const EFFECT_TONE = { read: "info", write: "warning", external: "danger" } as const;

function KindBadge({ kind }: { kind: CapabilityKind }) {
  return <Badge tone={kind === "SKILL" ? "primary" : kind === "TOOL" ? "info" : "neutral"}>{kind.toLowerCase()}</Badge>;
}

export function CapabilitiesPanel({ agentId }: { agentId: string }) {
  const capabilities = useCapabilities(agentId);
  const save = useSaveCapabilities(agentId);
  const view = capabilities.data;

  const [selected, setSelected] = useState<GrantInput[]>([]);
  // The server's list is the truth, and the signature is the only thing the editor
  // watches: a refetch that changed no grant keeps an edit in progress, while a
  // grant set that really did change — saved elsewhere, or just saved — wins.
  const serverSignature = useMemo(() => signature(savedGrants(view)), [view]);
  useEffect(() => {
    setSelected(grantsFrom(serverSignature));
  }, [serverSignature]);

  const [surface, setSurface] = useState<"console" | "public">("console");
  const [showPreview, setShowPreview] = useState(false);
  const preview = useCapabilityPreview(agentId, surface, showPreview);

  const contains = (kind: CapabilityKind, ref: string) =>
    selected.some((grant) => grant.kind === kind && grant.ref === ref);

  /**
   * A skill grant may have been stored by its key or by its row id — both are legal
   * refs, and `describeCapabilities` reports the one that is in the table. So the
   * switch has to read through both forms, or a skill would look ungranted while the
   * catalogue below listed it as given. Turning a skill on always writes the key
   * form, because the replace-all save makes that the whole truth afterwards.
   */
  const refsFor = (kind: CapabilityKind, key: string): string[] => {
    if (kind !== "SKILL") return [key];
    const refs = new Set<string>([key]);
    for (const entry of view?.catalogue ?? []) if (entry.key === key) refs.add(entry.ref);
    return [...refs];
  };

  const isOn = (kind: CapabilityKind, key: string) => refsFor(kind, key).some((ref) => contains(kind, ref));

  const setGrant = (kind: CapabilityKind, key: string, on: boolean) => {
    setShowPreview(false);
    const drop = new Set(refsFor(kind, key));
    setSelected((current) => {
      const without = current.filter((grant) => !(grant.kind === kind && drop.has(grant.ref)));
      return on ? [...without, { kind, ref: key }] : without;
    });
  };

  // Rows the operator switched off at the API level stay off: the console has no
  // control for a disabled grant, so it must not quietly delete them either.
  const offRows: GrantInput[] = (view?.grants ?? [])
    .filter((grant) => !grant.enabled)
    .map((grant) => ({ kind: grant.kind, ref: grant.ref, enabled: false }));
  const dirty = signature(selected) !== serverSignature;

  return (
    <QueryState error={capabilities.error} pending={capabilities.isPending}>
      {view && (
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <HugeiconsIcon icon={Task01Icon} size={15} strokeWidth={1.6} />
                  Skills
                </CardTitle>
                <CardDescription>
                  A skill is content an operator writes; granting it to this agent is the permission to read it.
                  Only the published version is ever loaded — the draft you edit is not what the model sees.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {view.available.skills.length === 0 ? (
                <EmptyState
                  title="No skills exist yet"
                  body="Built-in skills ship with the build and your own are written on the Skills page. Nothing is granted until you tick it here."
                />
              ) : (
                view.available.skills.map((skill) => (
                  <div key={skill.key} className="flex items-start justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                        {skill.name}
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{skill.key}</code>
                        {skill.core && <Badge tone="warning">core</Badge>}
                        {!skill.published && <Badge tone="danger">not published</Badge>}
                        <KindBadge kind="SKILL" />
                      </p>
                      <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{skill.description}</p>
                    </div>
                    <Switch
                      label={`Grant the skill ${skill.key} to this agent`}
                      checked={isOn("SKILL", skill.key)}
                      onChange={(on) => setGrant("SKILL", skill.key, on)}
                      disabled={save.isPending}
                    />
                  </div>
                ))
              )}
              <p className="flex items-start gap-2 pt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                <HugeiconsIcon icon={InfoIcon} size={13} strokeWidth={1.6} />
                <span>
                  An unpublished skill stays grantable and shows as unavailable: the catalogue would name a body the
                  agent cannot read, so the assembler drops it and says why rather than inventing one.
                </span>
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <HugeiconsIcon icon={FunctionIcon} size={15} strokeWidth={1.6} />
                  Tools
                </CardTitle>
                <CardDescription>
                  Tools are code, not settings — this list is exactly what this build implements, so nothing here can
                  be granted on faith.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {view.available.tools.map((tool) => (
                <div key={tool.key} className="flex items-start justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                      {tool.label}
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{tool.key}</code>
                      <Badge tone={EFFECT_TONE[tool.effect]}>{tool.effect}</Badge>
                    </p>
                    <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{tool.summary}</p>
                  </div>
                  <Switch
                    label={`Grant the tool ${tool.key} to this agent`}
                    checked={isOn("TOOL", tool.key)}
                    onChange={(on) => setGrant("TOOL", tool.key, on)}
                    disabled={save.isPending}
                  />
                </div>
              ))}
              <p className="flex items-start gap-2 pt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                <HugeiconsIcon icon={InfoIcon} size={13} strokeWidth={1.6} />
                <span>
                  <code className="font-mono">use_skill</code> is added by the assembly itself whenever a skill is
                  loadable, so the catalogue is never offered without the tool that opens it.
                </span>
              </p>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
            <Button
              variant={dirty ? "primary" : "outline"}
              size="sm"
              disabled={!dirty || save.isPending}
              loading={save.isPending}
              onClick={() => save.mutate([...selected, ...offRows])}
            >
              <HugeiconsIcon icon={SaveIcon} size={14} strokeWidth={1.6} />
              {dirty ? "Save grants" : "Grants saved"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowPreview((current) => !current)}>
              <HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={1.6} />
              {showPreview ? "Hide assembled prompt" : "Preview assembled prompt"}
            </Button>
            <Select
              aria-label="Which surface to preview"
              value={surface}
              onChange={(event) => {
                setSurface(event.target.value as "console" | "public");
                setShowPreview(true);
              }}
              className="w-40"
            >
              <option value="console">Console surface</option>
              <option value="public">Public (widget) surface</option>
            </Select>
            {save.isError && (
              <p className="flex items-center gap-1.5 text-[12px] text-destructive">
                <HugeiconsIcon icon={Alert02Icon} size={13} strokeWidth={1.6} />
                {reason(save.error)}
              </p>
            )}
            <span className="ml-auto text-[11px] text-muted-foreground">
              {selected.length} grant{selected.length === 1 ? "" : "s"} on
              {offRows.length > 0
                ? ` · ${offRows.length} stored switched off (${offRows.map((grant) => grant.ref).join(", ")}) — left as they are`
                : ""}
            </span>
          </div>

          {showPreview && (
            <QueryState error={preview.error} pending={preview.isPending}>
              {preview.data && (
                <Card>
                  <CardHeader>
                    <div>
                      <CardTitle>Prompt this turn would send</CardTitle>
                      <CardDescription>
                        Built by the same assembler a real run uses, so this is what the model receives — not a
                        description of it. Nothing was billed to produce it.
                      </CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <CodeBlock code={preview.data.systemPrompt} />
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[11.5px] text-muted-foreground">
                        <span>
                          {preview.data.snapshot.promptChars} of {preview.data.snapshot.promptBudgetChars} characters
                        </span>
                        <span className="font-mono">hash {preview.data.capabilityHash}</span>
                      </div>
                      <Progress
                        value={Math.min(1, preview.data.snapshot.promptChars / Math.max(1, preview.data.snapshot.promptBudgetChars))}
                        tone={preview.data.snapshot.promptChars > preview.data.snapshot.promptBudgetChars * 0.8 ? "warning" : "primary"}
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {preview.data.tools.length === 0 ? (
                        <Badge tone="neutral">no tools in this turn</Badge>
                      ) : (
                        preview.data.tools.map((tool) => (
                          <Badge key={tool.name} tone="info">
                            {tool.name}
                          </Badge>
                        ))
                      )}
                    </div>
                    <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                      A public-surface preview refuses outright when a core skill is unavailable — that refusal is the
                      same one the widget would hit, which is the point of asking it here first.
                    </p>
                  </CardContent>
                </Card>
              )}
            </QueryState>
          )}

          <Card>
            <CardHeader>
              <div>
                <CardTitle>What the agent was given</CardTitle>
                <CardDescription>
                  The snapshot the server resolves from these rows right now. Identical to what a run records on its
                  activity row, so a past turn can be read back.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {view.catalogue.length === 0 && view.tools.length === 0 && view.knowledge.length === 0 && view.sites.length === 0 ? (
                <EmptyState
                  title="No capabilities resolved"
                  body="This agent answers from its system prompt and the conversation only. That is a valid configuration, not a missing one."
                />
              ) : (
                <div className="overflow-hidden rounded-lg border border-border">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Capability</TH>
                        <TH>Kind</TH>
                        <TH>State</TH>
                        <TH>Why</TH>
                      </TR>
                    </THead>
                    <tbody>
                      {view.catalogue.map((entry) => (
                        <TR key={`skill:${entry.ref}`}>
                          <TD>
                            <span className="text-[13px]">{entry.name}</span>
                            <span className="ml-2 font-mono text-[11px] text-muted-foreground">{entry.key}</span>
                            {entry.version !== null && (
                              <span className="ml-2 font-mono text-[11px] text-muted-foreground">v{entry.version}</span>
                            )}
                          </TD>
                          <TD>
                            <KindBadge kind="SKILL" />
                          </TD>
                          <TD>
                            <Badge tone={entry.state === "READY" ? "success" : "danger"}>
                              {entry.state === "READY" ? "ready" : "unavailable"}
                            </Badge>
                          </TD>
                          <TD className="text-[12px] text-muted-foreground">{entry.reason ?? "—"}</TD>
                        </TR>
                      ))}
                      {view.knowledge.map((entry) => (
                        <TR key={`knowledge:${entry.ref}`}>
                          <TD>
                            <span className="text-[13px]">{entry.title}</span>
                            <span className="ml-2 font-mono text-[11px] text-muted-foreground">{entry.docId ?? entry.ref}</span>
                          </TD>
                          <TD>
                            <KindBadge kind="KNOWLEDGE" />
                          </TD>
                          <TD>
                            <Badge tone={entry.state === "READY" ? "success" : "danger"}>
                              {entry.state === "READY" ? "ready" : "unavailable"}
                            </Badge>
                          </TD>
                          <TD className="text-[12px] text-muted-foreground">
                            {entry.reason ?? "searchable through knowledge_search"}
                          </TD>
                        </TR>
                      ))}
                      {view.sites.map((entry) => (
                        <TR key={`site:${entry.ref}`}>
                          <TD>
                            <span className="text-[13px]">{entry.host}</span>
                            <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                              {entry.pageCount} page{entry.pageCount === 1 ? "" : "s"}
                            </span>
                          </TD>
                          <TD>
                            <KindBadge kind="SITE" />
                          </TD>
                          <TD>
                            <Badge tone={entry.state === "READY" ? "success" : "danger"}>
                              {entry.state === "READY" ? "ready" : "unavailable"}
                            </Badge>
                          </TD>
                          <TD className="text-[12px] text-muted-foreground">
                            {entry.reason ?? "routable through find_page"}
                          </TD>
                        </TR>
                      ))}
                      {view.tools.map((entry) => (
                        <TR key={`tool:${entry.key}`}>
                          <TD>
                            <span className="font-mono text-[12px]">{entry.key}</span>
                            {entry.grant === "DERIVED" && (
                              <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                                <HugeiconsIcon icon={LockIcon} size={11} strokeWidth={1.6} />
                                derived
                              </span>
                            )}
                          </TD>
                          <TD>
                            <KindBadge kind="TOOL" />
                          </TD>
                          <TD>
                            <Badge tone={entry.state === "READY" ? "success" : "danger"}>
                              {entry.state === "READY" ? "ready" : "unavailable"}
                            </Badge>
                          </TD>
                          <TD className="text-[12px] text-muted-foreground">{entry.reason ?? `${entry.effect} effect`}</TD>
                        </TR>
                      ))}
                    </tbody>
                  </Table>
                </div>
              )}

              {view.degradations.length > 0 && (
                <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                  <p className="flex items-center gap-2 text-[12.5px] font-medium">
                    <HugeiconsIcon icon={Alert02Icon} size={14} strokeWidth={1.6} />
                    {view.degradations.length} grant{view.degradations.length === 1 ? "" : "s"} this build could not honour
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {view.degradations.map((entry) => (
                      <li key={`${entry.kind}:${entry.ref}`} className="text-[12px] leading-relaxed text-muted-foreground">
                        <code className="font-mono text-foreground/80">{entry.ref}</code> — {entry.reason}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 flex items-start gap-2 text-[11.5px] leading-relaxed text-muted-foreground">
                    <HugeiconsIcon icon={StarIcon} size={12} strokeWidth={1.6} />
                    <span>These are the lines the model is told about, so it cannot offer something it cannot do.</span>
                  </p>
                </div>
              )}

              <Button variant="ghost" size="sm" onClick={() => void capabilities.refetch()}>
                <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={1.6} />
                Re-resolve from the database
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </QueryState>
  );
}
