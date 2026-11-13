/**
 * The public turn's contract: what a visitor's widget may know about a turn.
 *
 * It is deliberately a separate file from `agent-run.ts`. Everything a turn
 * produces internally — the prompt, the token counts, the trace, the tenant and
 * project ids — is useful to the operator and dangerous on a page anyone can open
 * devtools on. The projection below is a hand-written allowlist, never a spread:
 * a field becomes visible only by being named here, so a new column on the run
 * row cannot leak by accident.
 *
 * The lane constant lives here too, because the API enqueues it and the worker
 * consumes it, and a string written twice is a lane that silently stops matching.
 */

export const EMBED_TURN_LANE = "embed.turn";

export type EmbedMessageStatus = "PENDING" | "RUNNING" | "ANSWERED" | "FAILED";

/** A navigation the agent decided the visitor wants — rendered as a button. */
export interface AgentAction {
  kind: "goto";
  label: string;
  url: string;
}

/** A passage the answer was drawn from — shown as a source line, never as the prompt. */
export interface AgentCitation {
  docId: string;
  title: string;
  url?: string;
  chunkId: string;
}

export interface EmbedRunProjection {
  messageId: string;
  status: EmbedMessageStatus;
  reply: string | null;
  actions: AgentAction[];
  citations: AgentCitation[];
  error: string | null;
}

/** What the projection is fed from: the message row, read by the API or the worker. */
export interface EmbedMessageRecord {
  id: string;
  status: EmbedMessageStatus;
  answer: string | null;
  error: string | null;
  actions: unknown;
  citations: unknown;
}

/**
 * The fields that must never appear in a public projection. The test serializes
 * a projection built from a row carrying all of them and asserts none survive —
 * so this list is enforced by a test, not by a comment.
 */
export const FORBIDDEN_PROJECTION_KEYS = [
  "systemPrompt",
  "tokensUsed",
  "costUsdEstimate",
  "conversationId",
  "tenantId",
  "projectId",
  "trace",
  "steps",
] as const;

/**
 * One thread per widget session. The token comes from the visitor's own browser
 * (`sessionStorage`), so continuity needs no cookie and leaves no cross-site
 * identifier behind; two sites embedding the same agent still get two threads,
 * because the embed id is part of the key.
 */
export function embedChatId(embedId: string, sessionId: string): string {
  return `embed:${embedId}:${sessionId}`;
}

function actionsOf(value: unknown): AgentAction[] {
  if (!Array.isArray(value)) return [];
  const out: AgentAction[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { kind, label, url } = entry as Record<string, unknown>;
    // A button that would run javascript: or open a relative path is not a page
    // the operator chose, so it is dropped rather than rendered.
    if (kind !== "goto" || typeof label !== "string" || typeof url !== "string") continue;
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ kind, label, url });
  }
  return out;
}

function citationsOf(value: unknown): AgentCitation[] {
  if (!Array.isArray(value)) return [];
  const out: AgentCitation[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const { docId, title, url, chunkId } = entry as Record<string, unknown>;
    if (typeof docId !== "string" || typeof title !== "string" || typeof chunkId !== "string") continue;
    out.push({
      docId,
      title,
      chunkId,
      ...(typeof url === "string" && /^https?:\/\//i.test(url) ? { url } : {}),
    });
  }
  return out;
}

/**
 * The allowlist. A failed turn keeps its public reason — the API and worker only
 * ever store text a visitor is meant to read — and an answered one carries the
 * reply, the buttons and the sources. Nothing else crosses.
 */
export function projectEmbedMessage(row: EmbedMessageRecord): EmbedRunProjection {
  return {
    messageId: row.id,
    status: row.status,
    reply: row.status === "ANSWERED" ? row.answer : null,
    actions: row.status === "ANSWERED" ? actionsOf(row.actions) : [],
    citations: row.status === "ANSWERED" ? citationsOf(row.citations) : [],
    error: row.status === "FAILED" ? (row.error ?? "the assistant could not answer") : null,
  };
}
