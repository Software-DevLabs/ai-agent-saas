import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { tenantWhere } from "@saas/db";
import { badRequest, notFound } from "../http-error.ts";
import { canonicalOrigin, hashEmbedKey } from "../embed/resolve.ts";
import type { EmbedBundleInfo } from "../static.ts";

/**
 * The operator's half of the widget: create it, point it at origins, pause it,
 * rotate its key, and read back the one line to paste on the site.
 *
 * The key is generated here and returned exactly once. Only its sha-256 is stored,
 * so a later list cannot show the snippet again — the row carries `keyHint` and the
 * console offers a rotate, which is the honest shape for a value that is public in
 * the page but should not be lying around in a database dump and a screenshot.
 */

export type EmbedStatusDto = "ACTIVE" | "PAUSED";

export interface EmbedWidgetDto {
  id: string;
  agentId: string;
  projectId: string;
  name: string;
  /** `emb_ab12cd…` — enough to tell two widgets apart, useless as a key. */
  keyHint: string;
  origins: string[];
  status: EmbedStatusDto;
  createdAt: string;
  updatedAt: string;
}

export interface EmbedBundleDto {
  served: boolean;
  file: string;
}

export interface EmbedListView {
  embeds: EmbedWidgetDto[];
  bundle: EmbedBundleDto;
}

export interface EmbedCreateView {
  embed: EmbedWidgetDto;
  /** The only time this value exists outside the visitor's page. */
  key: string;
  snippet: string;
  bundle: EmbedBundleDto;
}

export interface RateRowDto {
  ipHash: string;
  tokens: number;
  rejected: number;
  updatedAt: string;
}

const MAX_ORIGINS = 10;

const embedSelect = {
  id: true,
  agentId: true,
  projectId: true,
  name: true,
  keyHint: true,
  origins: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

type EmbedRow = {
  id: string;
  agentId: string;
  projectId: string;
  name: string;
  keyHint: string;
  origins: string[];
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(row: EmbedRow): EmbedWidgetDto {
  return {
    id: row.id,
    agentId: row.agentId,
    projectId: row.projectId,
    name: row.name,
    keyHint: row.keyHint,
    origins: row.origins,
    status: row.status as EmbedStatusDto,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function requireEmbed(db: PrismaClient, tenantId: string, embedId: string): Promise<{ id: string; agentId: string; name: string }> {
  const row = await db.embed.findFirst({
    where: tenantWhere(tenantId, { id: embedId }),
    select: { id: true, agentId: true, name: true },
  });
  if (row === null) throw notFound("embed_not_found", `widget ${embedId} is not in this tenant`);
  return row;
}

async function requireAgent(db: PrismaClient, tenantId: string, agentId: string): Promise<{ id: string; projectId: string }> {
  const row = await db.agent.findFirst({
    where: tenantWhere(tenantId, { id: agentId }),
    select: { id: true, projectId: true },
  });
  if (row === null) throw notFound("agent_not_found", `agent ${agentId} is not in this tenant`);
  return row;
}

/**
 * Origins are stored canonically and deduplicated, because an allowlist that
 * holds `https://a.example/` and `https://a.example` twice teaches an operator
 * nothing about what the gate actually compares.
 */
export function normalizeOrigins(values: string[]): string[] {
  const bad: string[] = [];
  const out: string[] = [];
  for (const value of values) {
    const canonical = canonicalOrigin(value.trim());
    if (canonical === null) bad.push(value);
    else if (!out.includes(canonical)) out.push(canonical);
  }
  if (bad.length > 0) {
    throw badRequest("embed_origin_invalid", `these are not http(s) origins: ${bad.join(", ")}`);
  }
  if (out.length === 0) {
    throw badRequest("embed_origin_required", "name at least one origin — without one the widget answers nobody");
  }
  if (out.length > MAX_ORIGINS) {
    throw badRequest("embed_origin_limit", `at most ${MAX_ORIGINS} origins per widget`);
  }
  return out;
}

function snippetOf(apiOrigin: string, bundle: EmbedBundleDto, key: string): string {
  return `<script src="${apiOrigin}/embed/${bundle.file}" data-key="${key}" defer></script>`;
}

function newKey(): string {
  return `emb_${randomBytes(24).toString("base64url")}`;
}

export async function listAgentEmbeds(
  db: PrismaClient,
  tenantId: string,
  agentId: string,
  bundle: EmbedBundleDto,
): Promise<EmbedListView> {
  await requireAgent(db, tenantId, agentId);
  const rows = await db.embed.findMany({
    where: tenantWhere(tenantId, { agentId }),
    orderBy: { createdAt: "desc" },
    select: embedSelect,
  });
  return { embeds: rows.map(toDto), bundle };
}

export async function createEmbed(
  db: PrismaClient,
  tenantId: string,
  agentId: string,
  input: { name: string; origins: string[] },
  context: { apiOrigin: string; bundle: EmbedBundleDto },
): Promise<EmbedCreateView> {
  const agent = await requireAgent(db, tenantId, agentId);
  const origins = normalizeOrigins(input.origins);
  const key = newKey();
  const row = await db.embed.create({
    data: {
      tenantId,
      projectId: agent.projectId,
      agentId: agent.id,
      name: input.name,
      keyHash: hashEmbedKey(key),
      // Six characters after the prefix: enough for a human to match "which key is
      // on the old site", far too little to reconstruct the key.
      keyHint: `${key.slice(0, 10)}…`,
      origins,
    },
    select: embedSelect,
  });
  return {
    embed: toDto(row),
    key,
    snippet: snippetOf(context.apiOrigin, context.bundle, key),
    bundle: context.bundle,
  };
}

export async function updateEmbed(
  db: PrismaClient,
  tenantId: string,
  embedId: string,
  patch: { name?: string; origins?: string[]; status?: EmbedStatusDto },
): Promise<EmbedWidgetDto> {
  await requireEmbed(db, tenantId, embedId);
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.origins !== undefined) data.origins = normalizeOrigins(patch.origins);
  if (patch.status !== undefined) data.status = patch.status;
  const row = await db.embed.update({ where: { id: embedId }, data, select: embedSelect });
  return toDto(row);
}

export async function rotateEmbedKey(
  db: PrismaClient,
  tenantId: string,
  embedId: string,
  context: { apiOrigin: string; bundle: EmbedBundleDto },
): Promise<{ key: string; keyHint: string; snippet: string }> {
  await requireEmbed(db, tenantId, embedId);
  const key = newKey();
  const row = await db.embed.update({
    where: { id: embedId },
    data: { keyHash: hashEmbedKey(key), keyHint: `${key.slice(0, 10)}…` },
    select: { keyHint: true },
  });
  return { key, keyHint: row.keyHint, snippet: snippetOf(context.apiOrigin, context.bundle, key) };
}

export async function deleteEmbed(db: PrismaClient, tenantId: string, embedId: string): Promise<void> {
  await requireEmbed(db, tenantId, embedId);
  await db.embed.delete({ where: { id: embedId } });
}

/**
 * The bucket rows behind a widget. Reading them is how "the 429s were real and
 * counted" becomes an observation instead of a claim — `rejected` is incremented
 * by the same statement that refuses the request.
 */
export async function listEmbedRates(db: PrismaClient, tenantId: string, embedId: string): Promise<RateRowDto[]> {
  await requireEmbed(db, tenantId, embedId);
  const rows = await db.embedRate.findMany({
    where: { embedId },
    orderBy: [{ rejected: "desc" }, { updatedAt: "desc" }],
    take: 50,
    select: { ipHash: true, tokens: true, rejected: true, updatedAt: true },
  });
  return rows.map((row) => ({
    ipHash: row.ipHash,
    tokens: Number(row.tokens),
    rejected: row.rejected,
    updatedAt: row.updatedAt.toISOString(),
  }));
}
