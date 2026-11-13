import { extractHtml, intentOf, summaryOf } from "./html.ts";
import { parseHttpUrl, type FetchedPage } from "./fetch.ts";
import { CRAWLER_NAME, robotsAllows } from "./robots.ts";

/**
 * Walking a support site once, deterministically.
 *
 * Breadth-first with a page cap and a depth cap, same host only, robots.txt
 * obeyed. The output is exactly the set of URLs `find_page` is later allowed to
 * offer, so the crawl is not "a sitemap we hope is current" — it is the routing
 * table, replaced whole on every crawl. Pages that fail or are disallowed are
 * reported as skips with their reason rather than quietly dropped, because an
 * operator asking "where is my /pricing page" deserves an answer.
 *
 * The fetcher is injected: this file decides *what* to crawl, `fetch.ts` decides
 * whether a connection is safe. That split keeps the crawl testable with three
 * HTML strings and no network.
 */

export const SITE_CRAWL_LANE = "site.crawl";
export const DEFAULT_MAX_PAGES = 25;
export const DEFAULT_MAX_DEPTH = 2;

/** The same wording the crawler's user-agent carries, exported for the API's copy. */
export const SITE_CRAWLER_NAME = CRAWLER_NAME;

export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage>;
}

export interface CrawledPage {
  url: string;
  path: string;
  title: string;
  summary: string;
  intent: string;
}

export interface CrawlSkip {
  url: string;
  reason: string;
}

export interface CrawlOutcome {
  rootUrl: string;
  host: string;
  pages: CrawledPage[];
  skips: CrawlSkip[];
}

export interface CrawlOptions {
  fetcher: PageFetcher;
  maxPages?: number;
  maxDepth?: number;
}

/** A page's canonical form: no fragment, no trailing slash (except the root). */
export function normalizePageUrl(value: string | URL): string {
  const url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  url.hash = "";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}

function isHtml(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "text/html" || type === "application/xhtml+xml";
}

async function readRobots(origin: string, fetcher: PageFetcher): Promise<string | null> {
  try {
    const response = await fetcher.fetch(`${origin}/robots.txt`);
    // 4xx is "no robots file" under the standard; only an answered 2xx has rules.
    return response.status === 200 ? response.body : null;
  } catch {
    // An unreachable robots.txt is the same as an absent one. The pages it would
    // have governed are still fetched under the SSRF guard, and every skip is
    // reported, so this cannot silently widen the crawl.
    return null;
  }
}

export async function crawlSite(rootUrl: string, manualUrls: string[], options: CrawlOptions): Promise<CrawlOutcome> {
  const root = parseHttpUrl(rootUrl);
  const host = root.host;
  const origin = root.origin;
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
  const maxDepth = Math.max(0, options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const robots = await readRobots(origin, options.fetcher);

  const queued = new Set<string>();
  const queue: { url: string; depth: number }[] = [];
  const enqueue = (raw: string, depth: number): void => {
    const url = parseHttpUrl(raw);
    if (url.host !== host) return;
    const key = normalizePageUrl(url);
    if (queued.has(key)) return;
    queued.add(key);
    queue.push({ url: key, depth });
  };

  enqueue(root.toString(), 0);
  for (const manual of manualUrls) {
    const parsed = parseHttpUrl(new URL(manual, root).toString());
    if (parsed.host !== host) {
      // The API already refuses this; throwing here keeps the crawl itself honest
      // when it is invoked from somewhere else.
      throw new Error(`manual page ${manual} is not on ${host}`);
    }
    enqueue(parsed.toString(), 0);
  }

  const pages: CrawledPage[] = [];
  const skips: CrawlSkip[] = [];
  const rootKey = normalizePageUrl(root);

  while (queue.length > 0 && pages.length < maxPages) {
    const next = queue.shift();
    if (next === undefined) break;
    const url = new URL(next.url);
    const isRoot = normalizePageUrl(url) === rootKey;

    if (!robotsAllows(robots, `${url.pathname}${url.search}`)) {
      if (isRoot) throw new Error(`${url.pathname} is disallowed by this site's robots.txt`);
      skips.push({ url: next.url, reason: "disallowed by robots.txt" });
      continue;
    }

    let fetched: FetchedPage;
    try {
      fetched = await options.fetcher.fetch(next.url);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "the page could not be fetched";
      if (isRoot) throw new Error(`could not fetch ${next.url}: ${reason}`);
      skips.push({ url: next.url, reason });
      continue;
    }

    if (fetched.status !== 200) {
      const reason = `answered HTTP ${fetched.status}`;
      if (isRoot) throw new Error(`${next.url} ${reason}`);
      skips.push({ url: next.url, reason });
      continue;
    }
    if (!isHtml(fetched.contentType)) {
      const reason = `not an HTML page (${fetched.contentType || "no content type"})`;
      if (isRoot) throw new Error(`${next.url} is ${reason}`);
      skips.push({ url: next.url, reason });
      continue;
    }

    const finalUrl = new URL(normalizePageUrl(fetched.url));
    if (finalUrl.host !== host) {
      throw new Error(`${next.url} ended on ${finalUrl.host}; this crawl stays on ${host}`);
    }
    const path = finalUrl.pathname;
    const extracted = extractHtml(fetched.body, finalUrl.toString());
    pages.push({
      url: finalUrl.toString(),
      path,
      title: (extracted.title || path).slice(0, 200),
      summary: summaryOf(extracted, path),
      intent: intentOf(extracted, path),
    });

    if (next.depth < maxDepth) {
      for (const link of extracted.links) {
        try {
          enqueue(link, next.depth + 1);
        } catch {
          // A link with a non-http scheme is not a page; `extractHtml` already
          // filters those, so this only guards a malformed absolute URL.
        }
      }
    }
  }

  return { rootUrl: normalizePageUrl(root), host, pages, skips };
}
