import { useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import Alert02Icon from "@hugeicons/core-free-icons/Alert02Icon";
import DatabaseIcon from "@hugeicons/core-free-icons/DatabaseIcon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import InfoIcon from "@hugeicons/core-free-icons/InfoIcon";
import RefreshIcon from "@hugeicons/core-free-icons/RefreshIcon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import { ApiError } from "@/lib/api";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Switch, Textarea } from "@/components/ui/field";
import { EmptyState, QueryState } from "@/components/ui/states";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { Table, TD, TH, THead, TR } from "@/components/ui/table";
import {
  useAddKnowledgeNote,
  useAgentKnowledge,
  useCapabilities,
  useDeleteKnowledge,
  useKnowledgeSearch,
  useReindexKnowledge,
  useSaveCapabilities,
  useUploadKnowledge,
} from "@/lib/queries";
import type { GrantInput, KnowledgeDoc, KnowledgeStatus, KnowledgeWrite } from "@/lib/domain";
import { formatDate } from "@/lib/utils";

/**
 * The knowledge tab: what this agent can read, how a document gets there, and the
 * one place in the console where retrieval can be asked a question without spending
 * a token.
 *
 * Everything shown is a row the API read back. `status` is the worker's own column,
 * so a file that is still `PENDING` says so rather than appearing searchable; the
 * search box resolves the scope through the same `loadCapabilities` a turn does, so
 * what it returns is what the agent would have found — and `backend` names the engine
 * that answered instead of leaving "nothing came back" ambiguous.
 */

const STATUS_LOOK: Record<KnowledgeStatus, { tone: Tone; dot: StatusTone; label: string }> = {
  PENDING: { tone: "neutral", dot: "neutral", label: "Pending" },
  INDEXING: { tone: "info", dot: "active", label: "Indexing" },
  INDEXED: { tone: "success", dot: "success", label: "Indexed" },
  FAILED: { tone: "danger", dot: "danger", label: "Failed" },
};

const KIND_LABEL: Record<KnowledgeDoc["kind"], string> = { FILE: "file", PAGE: "page", NOTE: "note" };

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const reason = (error: unknown): string => (error instanceof ApiError ? error.message : String(error));

/**
 * The vector half is the embed lane's own record, not an inference from the document
 * being indexed: a doc with no `embedding` is readable by keyword and says so, and a
 * failed embed states its reason instead of pretending the row does not exist.
 */
function VectorState({ doc }: { doc: KnowledgeDoc }) {
  if (doc.embeddingError !== null) return <span className="text-destructive">{doc.embeddingError}</span>;
  if (doc.embedding !== null) {
    return (
      <span>
        vector · {doc.embedding.model} {doc.embedding.dim}d · {doc.embedding.chunks} chunks
      </span>
    );
  }
  return doc.status === "INDEXED" ? <span>keyword only</span> : null;
}

function Problem({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-destructive">
      <HugeiconsIcon icon={Alert02Icon} size={13} strokeWidth={1.6} className="mt-0.5 shrink-0" />
      {reason(error)}
    </p>
  );
}

export function KnowledgePanel({ agentId }: { agentId: string }) {
  const knowledge = useAgentKnowledge(agentId);
  const capabilities = useCapabilities(agentId);
  const save = useSaveCapabilities(agentId);
  const addNote = useAddKnowledgeNote(agentId);
  const upload = useUploadKnowledge(agentId);
  const reindex = useReindexKnowledge(agentId);
  const remove = useDeleteKnowledge(agentId);

  const [noteTitle, setNoteTitle] = useState("");
  const [noteText, setNoteText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileTitle, setFileTitle] = useState("");
  const [last, setLast] = useState<KnowledgeWrite | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState("");
  const [asked, setAsked] = useState("");
  const search = useKnowledgeSearch(agentId, asked, asked !== "");

  /**
   * A document is read by an agent through a `KNOWLEDGE` grant, and this switch is a
   * replace-all save of the whole grant list — the same contract the Capabilities
   * tab writes, so the two tabs can never hold two ideas of what is granted.
   */
  const isGranted = (docId: string) =>
    (capabilities.data?.grants ?? []).some((grant) => grant.kind === "KNOWLEDGE" && grant.ref === docId && grant.enabled);

  const toggleGrant = (docId: string, on: boolean) => {
    const view = capabilities.data;
    if (!view) return;
    const enabled: GrantInput[] = view.grants.filter((grant) => grant.enabled).map((grant) => ({ kind: grant.kind, ref: grant.ref }));
    const off: GrantInput[] = view.grants
      .filter((grant) => !grant.enabled)
      .map((grant) => ({ kind: grant.kind, ref: grant.ref, enabled: false }));
    const next = on
      ? [...enabled.filter((grant) => !(grant.kind === "KNOWLEDGE" && grant.ref === docId)), { kind: "KNOWLEDGE" as const, ref: docId }]
      : enabled.filter((grant) => !(grant.kind === "KNOWLEDGE" && grant.ref === docId));
    save.mutate([...next, ...off]);
  };

  const docs = knowledge.data ?? [];

  const saveNote = () => {
    addNote.mutate(
      { ...(noteTitle.trim() === "" ? {} : { title: noteTitle.trim() }), text: noteText },
      {
        onSuccess: (written) => {
          setLast(written);
          setNoteTitle("");
          setNoteText("");
        },
      },
    );
  };

  const uploadFile = () => {
    if (file === null) return;
    upload.mutate(
      { file, ...(fileTitle.trim() === "" ? {} : { title: fileTitle.trim() }) },
      {
        onSuccess: (written) => {
          setLast(written);
          setFile(null);
          setFileTitle("");
          if (fileInput.current) fileInput.current.value = "";
        },
      },
    );
  };

  return (
    <QueryState error={knowledge.error} pending={knowledge.isPending}>
      <div className="space-y-5">
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <HugeiconsIcon icon={DatabaseIcon} size={15} strokeWidth={1.6} />
                Documents
              </CardTitle>
              <CardDescription>
                Everything stored for this agent's project. A document is searchable only once the worker has
                indexed it — the status column is the worker's own answer, not a guess.
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void knowledge.refetch()}>
              <HugeiconsIcon icon={RefreshIcon} size={14} strokeWidth={1.6} />
              Refresh
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {docs.length === 0 ? (
              <EmptyState
                title="No documents yet"
                body="Upload a file or paste text below. Nothing is searchable until it has been indexed, and nothing is readable by the agent until it is granted."
              />
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <THead>
                    <TR>
                      <TH>Document</TH>
                      <TH>Status</TH>
                      <TH>Size</TH>
                      <TH>Granted</TH>
                      <TH>Actions</TH>
                    </TR>
                  </THead>
                  <tbody>
                    {docs.map((doc) => {
                      const look = STATUS_LOOK[doc.status];
                      return (
                        <TR key={doc.id}>
                          <TD>
                            <p className="text-[13px] font-medium">{doc.title}</p>
                            <p className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
                              <span>{KIND_LABEL[doc.kind]}</span>
                              <span>{doc.mime}</span>
                              <span>sha {doc.sha8}</span>
                              {doc.status === "INDEXED" && <span>{doc.chunkCount} chunks</span>}
                              <VectorState doc={doc} />
                              {doc.error !== null && <span className="text-destructive">{doc.error}</span>}
                            </p>
                          </TD>
                          <TD>
                            <Badge tone={look.tone}>
                              <StatusDot tone={look.dot} pulse={doc.status === "INDEXING"} />
                              {look.label}
                            </Badge>
                          </TD>
                          <TD className="whitespace-nowrap font-mono text-[11.5px] tabular text-muted-foreground">
                            {doc.charCount.toLocaleString()} chars
                            <br />
                            {size(doc.byteSize)}
                          </TD>
                          <TD>
                            <label className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                              <Switch
                                label={`Let this agent search ${doc.title}`}
                                checked={isGranted(doc.id)}
                                onChange={(on) => toggleGrant(doc.id, on)}
                                disabled={save.isPending}
                              />
                              {isGranted(doc.id) ? "in scope" : "not granted"}
                            </label>
                          </TD>
                          <TD className="whitespace-nowrap text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={reindex.isPending}
                              onClick={() => reindex.mutate(doc.id)}
                              disabled={doc.status === "INDEXING"}
                            >
                              <HugeiconsIcon icon={RefreshIcon} size={13} strokeWidth={1.6} />
                              Re-index
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={remove.isPending}
                              onClick={() => remove.mutate(doc.id)}
                              aria-label={`Delete ${doc.title}`}
                            >
                              <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.6} />
                            </Button>
                          </TD>
                        </TR>
                      );
                    })}
                  </tbody>
                </Table>
              </div>
            )}
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              {docs.length} document{docs.length === 1 ? "" : "s"} · last written {docs[0] ? formatDate(docs[0].updatedAt) : "—"} ·
              deleting a document removes every agent's grant to it
            </p>
            <Problem error={save.error} />
            <Problem error={reindex.error} />
            <Problem error={remove.error} />
          </CardContent>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <HugeiconsIcon icon={Add01Icon} size={15} strokeWidth={1.6} />
                  Upload a file
                </CardTitle>
                <CardDescription>
                  Text, markdown, HTML or CSV. The bytes are decoded by this build, so a PDF or Word file is refused
                  rather than stored as something that indexes as nothing.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label="File" hint="Up to 8 MiB; up to 400 000 characters after decoding.">
                <Input
                  ref={fileInput}
                  type="file"
                  accept=".txt,.md,.markdown,.html,.htm,.csv,text/plain,text/markdown,text/html,text/csv"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </Field>
              <Field label="Title" hint="Optional — the filename is used when you leave this empty.">
                <Input value={fileTitle} onChange={(event) => setFileTitle(event.target.value)} placeholder="Shipping policy" />
              </Field>
              <Button variant="primary" size="sm" disabled={file === null} loading={upload.isPending} onClick={uploadFile}>
                Upload and index
              </Button>
              <Problem error={upload.error} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <HugeiconsIcon icon={Add01Icon} size={15} strokeWidth={1.6} />
                  Paste a note
                </CardTitle>
                <CardDescription>
                  A policy, a price list, an answer you keep writing by hand. Stored as one document in this
                  project and indexed the same way a file is.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label="Title">
                <Input value={noteTitle} onChange={(event) => setNoteTitle(event.target.value)} placeholder="Refund policy" />
              </Field>
              <Field label="Text">
                <Textarea
                  value={noteText}
                  onChange={(event) => setNoteText(event.target.value)}
                  placeholder="Refunds are issued within 14 days of purchase…"
                  className="min-h-36"
                />
              </Field>
              <Button
                variant="primary"
                size="sm"
                disabled={noteText.trim() === ""}
                loading={addNote.isPending}
                onClick={saveNote}
              >
                Save note
              </Button>
              <Problem error={addNote.error} />
            </CardContent>
          </Card>
        </div>

        {last !== null && (
          <div className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-[12px] leading-relaxed">
            <HugeiconsIcon icon={InfoIcon} size={13} strokeWidth={1.6} className="mt-0.5 shrink-0" />
            <span>
              <span className="font-medium">{last.doc.title}</span> —{" "}
              {last.duplicate ? "this exact text was already stored, so nothing new was written" : "stored"}
              {last.granted ? "; granted to this agent" : ""}. Queue: {last.queue}.
              {last.doc.status === "PENDING" || last.doc.status === "INDEXING"
                ? " The list refreshes until the worker has indexed it."
                : ""}
            </span>
          </div>
        )}

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <HugeiconsIcon icon={Search01Icon} size={15} strokeWidth={1.6} />
                Search what the agent can read
              </CardTitle>
              <CardDescription>
                Search over the granted documents, resolved through the same scope a turn is assembled with. No model
                is called and nothing is billed — this is the engine, asked directly, and the backend badge names
                which engine answered.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setAsked(draft.trim());
              }}
            >
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Where do refunds go?"
                aria-label="Search the agent's documents"
                className="h-control-md w-full max-w-sm"
              />
              <Button variant="outline" size="sm" type="submit" disabled={draft.trim() === ""}>
                Search
              </Button>
            </form>
            {asked !== "" && (
              <QueryState error={search.error} pending={search.isPending}>
                {search.data && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
                      <Badge tone={search.data.backend === "none" ? "neutral" : "info"}>backend: {search.data.backend}</Badge>
                      <span>{search.data.note}</span>
                    </div>
                    {search.data.hits.length === 0 ? (
                      <EmptyState
                        title="No passage matched"
                        body="That is the engine's answer for these words, not the model's. Try a word that appears in the document."
                      />
                    ) : (
                      <ul className="divide-y divide-border rounded-lg border border-border">
                        {search.data.hits.map((hit) => (
                          <li key={hit.chunkId} className="space-y-1 px-3 py-2.5">
                            <p className="flex flex-wrap items-center gap-2 text-[12.5px] font-medium">
                              {hit.title}
                              <code className="font-mono text-[11px] text-muted-foreground">
                                chunk {hit.seq} · score {hit.score.toFixed(4)}
                              </code>
                            </p>
                            <p className="text-[12px] leading-relaxed text-muted-foreground">{hit.snippet}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </QueryState>
            )}
            <p className="flex items-start gap-2 text-[11.5px] leading-relaxed text-muted-foreground">
              <HugeiconsIcon icon={InfoIcon} size={13} strokeWidth={1.6} className="mt-0.5 shrink-0" />
              <span>
                Vector search runs first when a document has an embedding row; otherwise the same query falls back
                to Postgres full-text. Embeddings are computed by the local Ollama daemon, which reports no usage —
                they are <span className="font-medium">not metered</span>, and the console shows no invented cost
                for them.
              </span>
            </p>
          </CardContent>
        </Card>
      </div>
    </QueryState>
  );
}
