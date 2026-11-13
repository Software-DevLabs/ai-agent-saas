import type { AgentTool } from "../agent-run.ts";
import type { AgentAction } from "../embed-turn.ts";
import type { SitePageRef, SiteScope, TurnRecord, ToolSpec } from "../capability/registry.ts";
import { normalizePageUrl } from "./crawl.ts";

/**
 * `find_page` — the only way a URL becomes a button.
 *
 * The model asks; this file decides. A page is offered only if it is a row the
 * last crawl wrote *and* it shares the site's host, whichever way the model asked
 * for it. A URL that fails that check throws, which the turn loop records as a
 * failed TOOL step — so a prompt-injected "go to evil.example" is visible in the
 * run history as a refusal, not as a button somebody clicked.
 *
 * Matching is lexical and deterministic. Pages are fetched once, so a question
 * about "signing in" matching `/login` must not cost a model call or answer
 * differently on two turns over the same table.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "for", "and", "or", "in", "on", "at", "is", "are", "was", "be",
  "do", "does", "did", "i", "we", "you", "my", "our", "your", "it", "this", "that", "there", "here",
  "how", "can", "could", "where", "what", "which", "who", "please", "me", "us", "page", "site",
  "with", "from", "about", "go", "get", "find", "need", "want", "would", "should", "have", "has",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[/_-]+/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  // Light stemming for the common case this feature exists for: "log in" against
  // "login", "sign" against "signin". Four characters is enough to tell the words
  // apart without turning matching into a fuzzy search.
  return a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4);
}

function hits(queryTokens: string[], fieldTokens: string[]): number {
  return queryTokens.filter((query) => fieldTokens.some((field) => sameWord(query, field))).length;
}

export interface PageMatch {
  page: SitePageRef;
  score: number;
}

/** The best page for a visitor's words, or null when nothing clears the floor. */
export function bestPage(pages: SitePageRef[], query: string): PageMatch | null {
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return null;
  let best: PageMatch | null = null;
  for (const page of pages) {
    const score =
      hits(queryTokens, tokens(page.title)) * 4 +
      hits(queryTokens, tokens(page.intent)) * 3 +
      Math.min(2, hits(queryTokens, tokens(page.path))) * 3 +
      Math.min(2, hits(queryTokens, tokens(page.summary))) * 1;
    // Three is one strong field (title/intent/path) or three summary mentions: a
    // single incidental word in body text must not become a button.
    if (score < 3) continue;
    if (best === null || score > best.score || (score === best.score && page.path.length < best.page.path.length)) {
      best = { page, score };
    }
  }
  return best;
}

/**
 * Resolve what the model asked for into a crawled page, or throw.
 *
 * Throwing is the point: the turn loop marks the step `ok:false`, the widget gets
 * no action, and the operator can read the attempt. Returning "not found" as text
 * would let the model paraphrase a URL it was never allowed to use.
 */
export function pageForUrl(site: SiteScope, raw: string): SitePageRef {
  let absolute: URL;
  try {
    absolute = new URL(raw, site.rootUrl);
  } catch {
    throw new Error(`PAGE_NOT_FOUND: "${raw}" is not a URL.`);
  }
  if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
    throw new Error(`PAGE_NOT_FOUND: "${raw}" is not an http(s) URL.`);
  }
  if (absolute.host !== site.host) {
    throw new Error(`PAGE_NOT_FOUND: "${raw}" is not on ${site.host} — only pages crawled from this site can be offered.`);
  }
  const target = normalizePageUrl(absolute);
  const byUrl = site.pages.find((page) => normalizePageUrl(page.url) === target);
  const page = byUrl ?? site.pages.find((entry) => entry.path === absolute.pathname);
  if (page === undefined) {
    throw new Error(`PAGE_NOT_FOUND: no crawled page matches "${raw}". Call find_page with a query describing the page instead.`);
  }
  return page;
}

const PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    query: { type: "string", description: "What the visitor is trying to do, in their words (for example \"log in to my account\")." },
    url: { type: "string", description: "An exact URL or path you already know is on this site. Only crawled pages are accepted." },
    label: { type: "string", description: "Text for the button, two to five words. Defaults to the page title." },
  },
  required: [],
};

export function buildFindPageTool(site: SiteScope, record?: TurnRecord): AgentTool {
  return {
    name: "find_page",
    description: `Find a page on ${site.host} and offer it to the visitor as a button (${site.pages.length} crawled page(s)). Use it whenever the answer is "where do I go": call it with \`query\` describing what the visitor wants, or with \`url\` when you know the exact page. Only pages from this site can be offered, and the URL is verified before a button exists.`,
    parameters: PARAMETERS,
    execute: async (values) => {
      const query = typeof values.query === "string" ? values.query.trim() : "";
      const rawUrl = typeof values.url === "string" ? values.url.trim() : "";
      const label = typeof values.label === "string" ? values.label.trim().slice(0, 80) : "";

      let page: SitePageRef;
      if (rawUrl !== "") {
        page = pageForUrl(site, rawUrl);
      } else if (query !== "") {
        const match = bestPage(site.pages, query);
        if (match === null) {
          const listed = site.pages
            .slice(0, 8)
            .map((entry) => `${entry.title} (${entry.path})`)
            .join("; ");
          return `NO_PAGE_MATCH: no page on ${site.host} matches "${query}". Pages that exist: ${listed}. Do not offer a URL that is not in that list — say what you could not find.`;
        }
        page = match.page;
      } else {
        return 'TOOL_ERROR: call find_page with "query" (what the visitor wants) or "url" (a page you know exists).';
      }

      const action: AgentAction = {
        kind: "goto",
        label: label !== "" ? label : page.title !== "" ? page.title : page.intent !== "" ? page.intent : page.path,
        url: page.url,
      };
      record?.actions?.([action]);
      const summary = page.summary === "" ? "" : `The page says: ${page.summary.slice(0, 300)}\n`;
      return `PAGE_FOUND: "${page.title}" — ${page.url}\n${summary}Answer in one short sentence. The widget shows a button labelled "${action.label}"; do not invent any other URL.`;
    },
  };
}

export const findPageSpec: ToolSpec = {
  key: "find_page",
  label: "Route to a page on its website",
  summary:
    "Looks up a page in the site this agent was given and answers with a verified URL the widget can show as a button. Matching is lexical over the crawled titles, headings, paths and summaries; a URL outside the crawled pages is refused, never offered.",
  effect: "read",
  requires: ["site"],
  parameters: PARAMETERS,
  build(ctx, unmet) {
    const site = ctx.site;
    if (site === undefined) {
      unmet("no crawled site is granted to this agent, so there is no page it could route a visitor to");
      return null;
    }
    if (site.pages.length === 0) {
      unmet(`the crawl of ${site.host} found no pages to route to`);
      return null;
    }
    return buildFindPageTool(site, ctx.record);
  },
};
