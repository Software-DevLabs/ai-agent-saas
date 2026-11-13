import { createHash } from "node:crypto";
// `ToolEffect` itself stays exported from `registry.ts` — this module only reads
// the registry to describe what a skill would open.
import { getToolSpec, type ToolEffect } from "./registry.ts";

/**
 * What a turn was actually assembled from.
 *
 * The snapshot is the audit half of the capability system: it is written onto
 * `AgentRun.capability` before the first paid round, so a run from last month can
 * be read back and answered exactly — which skills were on, which tools the model
 * was given, and what the operator had granted that this build refused to honour.
 *
 * `hash` is the cheap half of the same question: two runs with the same hash saw
 * the same capability set, whatever the agent's rows say today.
 */

export type CapabilityState = "READY" | "UNAVAILABLE";

/** Why a grant produced nothing. Always shown in the console — never swallowed. */
export interface Degradation {
  kind: "SKILL" | "TOOL" | "KNOWLEDGE" | "SITE";
  ref: string;
  /** Human-readable, tenant-safe: it names the missing thing, never a secret. */
  reason: string;
}

export interface CatalogueEntry {
  key: string;
  /** The `AgentCapability.ref` that produced it, so the console can tick rows back. */
  ref: string;
  name: string;
  description: string;
  /** The published version the body will come from; null when there is none. */
  version: number | null;
  origin: "BUILTIN" | "TENANT";
  core: boolean;
  /**
   * The effects of the tools this skill declares, so the console can say "opens
   * a read tool" without the operator having to know which key means what.
   */
  effects: ToolEffect[];
  state: CapabilityState;
  reason?: string;
}

export interface ToolEntry {
  key: string;
  effect: ToolEffect;
  state: CapabilityState;
  /**
   * `DERIVED` is a tool the assembly built because something else required it —
   * `use_skill` exists whenever the catalogue is non-empty — rather than one the
   * operator granted. Shown as derived so the list explains itself.
   */
  grant: "GRANTED" | "DERIVED";
  reason?: string;
}

/**
 * One knowledge grant, as the turn saw it. The title is recorded rather than only
 * the id because a run read back a month later has to name the document it could
 * have read, and a cuid says nothing to a person.
 */
export interface KnowledgeEntry {
  ref: string;
  /** Null when the grant names a document that is gone: the intent is still worth recording. */
  docId: string | null;
  title: string;
  state: CapabilityState;
  reason?: string;
}

/**
 * The crawled site a turn was routing into, as the turn saw it. The page count is
 * the number of pages `find_page` could actually answer from — a READY row whose
 * pages were deleted is a site the model could not route with, and the snapshot
 * says so instead of counting the row's stale number.
 */
export interface SiteEntry {
  ref: string;
  siteId: string | null;
  host: string;
  rootUrl: string;
  pageCount: number;
  state: CapabilityState;
  reason?: string;
}

export interface CapabilitySnapshot {
  agentId: string;
  skills: CatalogueEntry[];
  tools: ToolEntry[];
  knowledge: KnowledgeEntry[];
  sites: SiteEntry[];
  degradations: Degradation[];
  /** Assembled prompt size against its budget, so "why is my skill not offered" is answerable. */
  promptChars: number;
  promptBudgetChars: number;
}

/** Sorted by key, so identical grants hash identically whatever order rows came back in. */
export function sortEntries<T extends { key: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The effects a list of tool keys implies, de-duplicated in declaration order.
 * One implementation because the snapshot and the console must not disagree about
 * what a skill opens; an unknown key contributes nothing rather than guessing
 * `read`.
 */
export function effectsOf(tools: readonly string[]): ToolEffect[] {
  const effects: ToolEffect[] = [];
  for (const tool of tools) {
    const spec = getToolSpec(tool);
    if (spec !== null && !effects.includes(spec.effect)) effects.push(spec.effect);
  }
  return effects;
}

/**
 * JSON with object keys in sorted order. `JSON.stringify` preserves insertion
 * order, which is exactly the property that makes a hash unstable across two
 * reads of the same rows, so the sort is the point rather than the cosmetics.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
  }
  return value;
}

export function capabilityHash(snapshot: CapabilitySnapshot): string {
  // The agent id is excluded on purpose: it is about *who* ran, not *what* the
  // turn was given, and a replay across two agents with the same grants should
  // read as the same capability set.
  const { agentId: _agentId, ...rest } = snapshot;
  return createHash("sha256").update(JSON.stringify(canonical(rest))).digest("hex").slice(0, 16);
}
