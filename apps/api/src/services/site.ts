import type { PrismaClient } from "@prisma/client";
import { normalizePageUrl, parseHttpUrl, SITE_CRAWL_LANE, type Queue } from "@saas/core";
import { tenantWhere } from "@saas/db";
import { badRequest, conflict, notFound } from "../http-error.ts";

/**
 * The agent's own website, from the console's side.
 *
 * Saving a site is not "tell the model about a URL" — it is a request to crawl, and
 * the rows a crawl writes are the only URLs `find_page` may ever offer. Two rules
 * keep that honest:
 *
 * 1. **A save always queues a crawl.** The row goes to `PENDING` immediately, so
 *    the previous crawl stops being routable during the new one; a visitor never
 *    gets a button to a page that has since been deleted.
 * 2. **Only a READY crawl is routable.** `loadCapabilities` refuses pages for any
 *    other status, with the status as the reason, so a half-crawled site shows a
 *    degradation rather than a guess.
 *
 * The site belongs to one agent (`Site.agentId` is unique) and a `SITE` grant is
 * written at the same time, in the same tenant, exactly like a knowledge upload.
 */

export interface SitePageDto {
  url: string;
  path: string;
  title: string;
  summary: string;
  intent: string;
}

export interface SiteDto {
  id: string;
  agentId: string;
  rootUrl: string;
  host: string;
  manualUrls: string[];
  status: "PENDING" | "CRAWLING" | "READY" | "FAILED";
  error: string | null;
  pageCount: number;
  crawledAt: string | null;
  createdAt: string;
  updatedAt: string;
  pages: SitePageDto[];
}

export interface SiteSaveDto extends SiteDto {
  queued: boolean;
  /** What the queue answered, so "saved but not crawling" cannot be silent. */
  queue: string;
}

export interface SiteInput {
  rootUrl: string;
  manualUrls?: string[];
}

const MAX_MANUAL_URLS = 50;
const MAX_PAGES_READ = 500;

const siteSelect = {
  id: true,
  agentId: true,
  rootUrl: true,
  host: true,
  manualUrls: true,
  status: true,
  error: true,
  pageCount: true,
  crawledAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

type SiteRow = {
  id: string;
  agentId: string;
  rootUrl: string;
  host: string;
  manualUrls: string[];
  status: string;
  error: string | null;
  pageCount: number;
  crawledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(row: SiteRow, pages: SitePageDto[]): SiteDto {
  return {
    id: row.id,
    agentId: row.agentId,
    rootUrl: row.rootUrl,
    host: row.host,
    manualUrls: row.manualUrls,
    status: row.status as SiteDto["status"],
    error: row.error,
    pageCount: row.pageCount,
    crawledAt: row.crawledAt === null ? null : row.crawledAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    pages,
  };
}

async function requireAgent(db: PrismaClient, tenantId: string, agentId: string): Promise<{ id: string; projectId: string }> {
  const row = await db.agent.findFirst({ where: tenantWhere(tenantId, { id: agentId }), select: { id: true, projectId: true } });
  if (row === null) throw notFound("agent_not_found", `agent ${agentId} is not in this tenant`);
  return row;
}

/**
 * The crawler decides what a URL means; the API only refuses what the crawler
 * would refuse later. Root and manual pages are canonicalised here with the same
 * function the crawl uses, so the row the operator sees is the row `find_page`
 * matches against.
 */
function canonicalSite(input: SiteInput): { rootUrl: string; host: string; manualUrls: string[] } {
  const raw = input.rootUrl.trim();
  if (raw === "") throw badRequest("site_url_required", "a site needs a root URL");
  let root: URL;
  try {
    root = parseHttpUrl(raw);
  } catch (error) {
    throw badRequest("site_url_invalid", error instanceof Error ? error.message : `"${raw}" is not a URL`);
  }
  const manualInput = input.manualUrls ?? [];
  if (manualInput.length > MAX_MANUAL_URLS) {
    throw badRequest("site_manual_too_many", `at most ${MAX_MANUAL_URLS} manual pages can be listed`);
  }
  const manualUrls: string[] = [];
  for (const value of manualInput) {
    const trimmed = value.trim();
    if (trimmed === "") continue;
    let parsed: URL;
    try {
      parsed = parseHttpUrl(new URL(trimmed, root).toString());
    } catch (error) {
      throw badRequest("site_manual_invalid", error instanceof Error ? error.message : `"${trimmed}" is not a URL`);
    }
    if (parsed.host !== root.host) {
      throw badRequest("site_manual_offhost", `${trimmed} is on ${parsed.host}; every page must share the root host ${root.host}`);
    }
    const normalized = normalizePageUrl(parsed);
    if (!manualUrls.includes(normalized)) manualUrls.push(normalized);
  }
  return { rootUrl: normalizePageUrl(root), host: root.host, manualUrls };
}

async function grantSite(db: PrismaClient, tenantId: string, agentId: string, siteId: string): Promise<void> {
  const existing = await db.agentCapability.findFirst({
    where: tenantWhere(tenantId, { agentId, kind: "SITE", ref: siteId }),
    select: { id: true },
  });
  if (existing !== null) {
    await db.agentCapability.updateMany({ where: { AND: [tenantWhere(tenantId, {}), { id: existing.id }] }, data: { enabled: true } });
    return;
  }
  await db.agentCapability.create({ data: { tenantId, agentId, kind: "SITE", ref: siteId, enabled: true, config: {} } });
}

export async function getAgentSite(db: PrismaClient, tenantId: string, agentId: string): Promise<SiteDto | null> {
  await requireAgent(db, tenantId, agentId);
  const row = await db.site.findFirst({ where: tenantWhere(tenantId, { agentId }), select: siteSelect });
  if (row === null) return null;
  const pages = await db.sitePage.findMany({
    where: tenantWhere(tenantId, { siteId: row.id }),
    orderBy: { path: "asc" },
    take: MAX_PAGES_READ,
    select: { url: true, path: true, title: true, summary: true, intent: true },
  });
  return toDto(row, pages);
}

/**
 * A save is refused while a crawl is running: two crawls on one site would race
 * each other's page replacement, and the winner would decide what the model may
 * route to. The operator waits for the status line, which is what it is for.
 */
export async function saveAgentSite(
  db: PrismaClient,
  queue: Queue,
  tenantId: string,
  agentId: string,
  input: SiteInput,
): Promise<SiteSaveDto> {
  const agent = await requireAgent(db, tenantId, agentId);
  const canonical = canonicalSite(input);
  const existing = await db.site.findFirst({ where: tenantWhere(tenantId, { agentId }), select: siteSelect });
  if (existing !== null && existing.status === "CRAWLING") {
    throw conflict("site_crawling", `this agent's site is being crawled right now — wait for that crawl to finish`);
  }

  const siteId =
    existing === null
      ? (
          await db.site.create({
            data: {
              tenantId,
              // The project an agent is filed into, read from the agent row rather
              // than the request: a body cannot choose which project owns a site.
              projectId: agent.projectId,
              agentId,
              rootUrl: canonical.rootUrl,
              host: canonical.host,
              manualUrls: canonical.manualUrls,
              status: "PENDING",
            },
            select: { id: true },
          })
        ).id
      : existing.id;

  if (existing !== null) {
    const hostChanged = existing.host !== canonical.host;
    await db.$transaction(async (tx) => {
      if (hostChanged) {
        // Pages crawled from the old host are not on this site any more. Leaving
        // them would let `find_page` offer a URL that shares neither the new host
        // nor a crawl, so they go before the new crawl writes anything.
        await tx.sitePage.deleteMany({ where: { AND: [{ tenantId }, { siteId }] } });
      }
      await tx.site.updateMany({
        where: { AND: [{ id: siteId }, { tenantId }] },
        data: {
          rootUrl: canonical.rootUrl,
          host: canonical.host,
          manualUrls: canonical.manualUrls,
          status: "PENDING",
          error: null,
          ...(hostChanged ? { pageCount: 0, crawledAt: null } : {}),
        },
      });
    });
  }

  await grantSite(db, tenantId, agentId, siteId);

  let queued = true;
  let queueNote = "queued";
  try {
    // The key is time-based on purpose: an explicit save is a request for a fresh
    // crawl, so it must not be swallowed by the dedupe of a previous one. Page
    // idempotency is the `@@unique([siteId, url])` and the whole-table replace.
    const enqueued = await queue.enqueue({
      lane: SITE_CRAWL_LANE,
      tenantId,
      source: "site",
      externalMessageId: `${siteId}:crawl:${new Date().toISOString()}`,
      payload: { siteId },
    });
    if (enqueued.duplicate) {
      queued = false;
      queueNote = "a crawl for this site is already on the queue";
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "the crawl could not be queued";
    await db.site.updateMany({ where: { AND: [{ id: siteId }, { tenantId }] }, data: { status: "FAILED", error: detail } }).catch(() => undefined);
    throw error;
  }

  const row = await db.site.findFirstOrThrow({ where: tenantWhere(tenantId, { id: siteId }), select: siteSelect });
  const pages = await db.sitePage.findMany({
    where: tenantWhere(tenantId, { siteId }),
    orderBy: { path: "asc" },
    take: MAX_PAGES_READ,
    select: { url: true, path: true, title: true, summary: true, intent: true },
  });
  return { ...toDto(row, pages), queued, queue: queueNote };
}

/**
 * Deleting the site takes its grant and its pages with it: a grant whose ref no
 * longer resolves would sit in the next turn as a degradation forever. The agent
 * keeps answering — it simply stops offering pages of a site it no longer has.
 */
export async function deleteAgentSite(db: PrismaClient, tenantId: string, agentId: string): Promise<{ grantsRemoved: number }> {
  await requireAgent(db, tenantId, agentId);
  const row = await db.site.findFirst({ where: tenantWhere(tenantId, { agentId }), select: { id: true, host: true } });
  if (row === null) throw notFound("site_not_found", `agent ${agentId} has no site`);
  const removed = await db.$transaction(async (tx) => {
    const grants = await tx.agentCapability.deleteMany({ where: tenantWhere(tenantId, { kind: "SITE", ref: row.id }) });
    await tx.site.delete({ where: { id: row.id } });
    return grants.count;
  });
  return { grantsRemoved: removed };
}
