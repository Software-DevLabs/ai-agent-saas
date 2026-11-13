import type { PrismaClient } from "@prisma/client";
import { attemptDelay, crawlSite, describeError, fetchGuardedPage, type Queue, type QueueJob } from "@saas/core";

/**
 * The crawl lane: turn a root URL into `SitePage` rows.
 *
 * The row's status is the whole story the console reads — `CRAWLING` while pages
 * are being fetched, `READY` only after the pages were written, `FAILED` with the
 * reason when the crawl cannot finish. Pages are replaced whole inside one
 * transaction: a site that lost a page has a crawl that says so, not a stale row
 * that keeps routing visitors to a URL that 404s.
 */

export interface SiteCrawlSettings {
  /** Only local verification turns this on; the default refuses private addresses. */
  allowPrivate: boolean;
  timeoutMs: number;
  maxPages: number;
  maxDepth: number;
}

export interface SiteCrawlDeps {
  db: PrismaClient;
  queue: Queue;
  job: QueueJob;
  workerId: string;
  settings: SiteCrawlSettings;
}

export interface SiteCrawlResult {
  outcome: "crawled" | "retried" | "dead" | "rejected";
  jobId: string;
  siteId?: string;
  detail: string;
}

export async function handleSiteCrawlJob({ db, queue, job, workerId, settings }: SiteCrawlDeps): Promise<SiteCrawlResult> {
  const siteId = payloadSiteId(job);
  if (siteId === null) {
    const detail = "the job payload has no siteId";
    await queue.dead(job.id, workerId, detail);
    return { outcome: "rejected", jobId: job.id, detail };
  }

  const tenantId = job.tenantId ?? "__none__";
  const site = await db.site.findFirst({
    where: { AND: [{ id: siteId }, { tenantId }] },
    select: { id: true, rootUrl: true, manualUrls: true, host: true },
  });
  if (site === null) {
    const detail = `site ${siteId} is not in this tenant`;
    await queue.dead(job.id, workerId, detail);
    return { outcome: "rejected", jobId: job.id, siteId, detail };
  }

  await db.site.updateMany({
    where: { AND: [{ id: site.id }, { tenantId }] },
    data: { status: "CRAWLING", error: null },
  });

  try {
    const outcome = await crawlSite(site.rootUrl, site.manualUrls, {
      maxPages: settings.maxPages,
      maxDepth: settings.maxDepth,
      fetcher: {
        fetch: (url) => fetchGuardedPage(url, { allowPrivate: settings.allowPrivate, timeoutMs: settings.timeoutMs }),
      },
    });
    await db.$transaction(async (tx) => {
      await tx.sitePage.deleteMany({ where: { AND: [{ tenantId }, { siteId: site.id }] } });
      if (outcome.pages.length > 0) {
        await tx.sitePage.createMany({
          data: outcome.pages.map((page) => ({ tenantId, siteId: site.id, ...page })),
        });
      }
      await tx.site.updateMany({
        where: { AND: [{ id: site.id }, { tenantId }] },
        data: { status: "READY", pageCount: outcome.pages.length, crawledAt: new Date(), error: null },
      });
    });
    await queue.succeed(job.id, workerId);
    const skipped = outcome.skips.length === 0 ? "" : `, ${outcome.skips.length} skipped`;
    return { outcome: "crawled", jobId: job.id, siteId, detail: `${outcome.pages.length} page(s) from ${site.host}${skipped}` };
  } catch (error) {
    const detail = describeError(error);
    if (job.attempts >= job.maxAttempts) {
      await db.site
        .updateMany({ where: { AND: [{ id: site.id }, { tenantId }] }, data: { status: "FAILED", error: detail } })
        .catch(() => undefined);
      await queue.dead(job.id, workerId, detail);
      return { outcome: "dead", jobId: job.id, siteId, detail };
    }
    // Back to PENDING, not FAILED: the retry is queued and the console can see that
    // a crawl is coming rather than reading a failure that is about to be undone.
    await db.site
      .updateMany({ where: { AND: [{ id: site.id }, { tenantId }] }, data: { status: "PENDING", error: detail } })
      .catch(() => undefined);
    await queue.retry(job.id, workerId, detail, attemptDelay(job.attempts));
    return { outcome: "retried", jobId: job.id, siteId, detail };
  }
}

function payloadSiteId(job: QueueJob): string | null {
  const payload = job.payload as { siteId?: unknown } | null;
  const siteId = payload?.siteId;
  return typeof siteId === "string" && siteId !== "" ? siteId : null;
}
