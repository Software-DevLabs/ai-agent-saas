import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { conflict, notFound } from "../http-error.ts";

/**
 * Who is this widget, and is this page allowed to talk to it?
 *
 * The key in the snippet is a public identifier — it is in the page source — so
 * secrecy is not what protects the API. What protects it is that the key resolves
 * to one row with a server-owned tenant, project and agent, and that the row names
 * the origins allowed to use it. Those are read here and nowhere else; a public
 * request never names a tenant, an agent or a project.
 */

export interface ResolvedEmbed {
  id: string;
  tenantId: string;
  projectId: string;
  agentId: string;
  name: string;
  status: "ACTIVE" | "PAUSED";
  origins: string[];
  agent: { name: string; status: "DRAFT" | "ACTIVE" | "PAUSED" | "ERROR" };
}

export function hashEmbedKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * The visitor's address is never stored raw: a rate bucket only needs to tell
 * two callers apart, and an IP column is personal data the feature does not need.
 */
export function hashVisitorIp(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

/**
 * An origin is compared canonically (`https://a.example`, no trailing slash),
 * because `https://a.example/` and `https://a.example` are the same page to a
 * browser and would otherwise be two different allowlist entries.
 */
export function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function resolveEmbedByKey(db: PrismaClient, rawKey: string): Promise<ResolvedEmbed> {
  const row = await db.embed.findFirst({
    where: { keyHash: hashEmbedKey(rawKey) },
    select: {
      id: true,
      tenantId: true,
      projectId: true,
      agentId: true,
      name: true,
      status: true,
      origins: true,
      agent: { select: { name: true, status: true } },
    },
  });
  if (row === null) throw notFound("embed_not_found", "this embed key does not match any widget");
  return row;
}

/**
 * A missing Origin is a refusal, not a pass. Browsers always send one on a
 * cross-origin request, so the only callers without one are scripts — and a
 * script is exactly what the origin allowlist exists to stop.
 */
export function originAllowed(origins: string[], origin: string | undefined): boolean {
  if (origin === undefined) return false;
  const canonical = canonicalOrigin(origin);
  return canonical !== null && origins.includes(canonical);
}

/** The early, cheap refusals, in the order a visitor would experience them. */
export function assertEmbedServing(embed: ResolvedEmbed): void {
  if (embed.status !== "ACTIVE") {
    throw conflict("embed_paused", "this assistant is paused on this website right now");
  }
  if (embed.agent.status !== "ACTIVE") {
    // The same words a visitor would need, rather than the agent's internal state:
    // a DRAFT assistant is not something a customer has to know about.
    throw conflict("agent_not_active", "this assistant is not available right now");
  }
}
