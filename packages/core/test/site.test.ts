import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { assembleTurn } from "../src/capability/assemble.ts";
import type { LoadedCapabilities } from "../src/capability/load.ts";
import type { SitePageRef, SiteScope, ToolContext } from "../src/capability/registry.ts";
import { crawlSite, type PageFetcher } from "../src/site/crawl.ts";
import { isBlockedAddress, parseHttpUrl } from "../src/site/fetch.ts";
import { extractHtml, intentOf, summaryOf } from "../src/site/html.ts";
import { robotsAllows } from "../src/site/robots.ts";
import { bestPage, buildFindPageTool, pageForUrl } from "../src/site/tools.ts";
import type { AgentAction } from "../src/embed-turn.ts";

/**
 * The routing contract, tested against strings and a fake site: the guard judges
 * resolved addresses (so `localhost` is not the only spelling of a private host),
 * the crawl stays on one host and obeys robots.txt, and `find_page` either returns
 * a page the crawl wrote or throws — a URL that is not in the table can never
 * become a button, whatever a page tells the model to do.
 */

const PAGES: SitePageRef[] = [
  { url: "https://shop.example/", path: "/", title: "Shop", summary: "Welcome to the shop", intent: "Shop" },
  {
    url: "https://shop.example/login",
    path: "/login",
    title: "Sign in",
    summary: "Access your orders and account",
    intent: "Log in to your account",
  },
  { url: "https://shop.example/pricing", path: "/pricing", title: "Pricing", summary: "Plans for every team", intent: "Plans" },
];

const scope = (pages: SitePageRef[] = PAGES): SiteScope => ({ siteId: "site_1", rootUrl: "https://shop.example/", host: "shop.example", pages });

/** A site the tenant controls, served from strings; `/secret` is ruled off by robots. */
const siteHtml: Record<string, string> = {
  "https://shop.example/robots.txt": "User-agent: *\nDisallow: /\n\nUser-agent: saas-site-crawler\nDisallow: /secret\nAllow: /secret/public\n",
  "https://shop.example/": `<html><head><title>Shop home</title><meta name="description" content="The shop"></head>
    <body><h1>Shop</h1>
    <a href="/login">Log in</a><a href="/pricing">Pricing</a><a href="/secret">Secret</a>
    <a href="https://evil.example/phish">Elsewhere</a><a href="javascript:alert(1)">Bad</a>
    </body></html>`,
  "https://shop.example/login": `<html><head><title>Sign in</title><meta name="description" content="Access your orders and account."></head>
    <body><h1>Log in to your account</h1><p>Use your email and password.</p></body></html>`,
  "https://shop.example/pricing": `<html><head><title>Pricing</title></head><body><h1>Plans</h1><p>Plans for every team.</p></body></html>`,
};

function fakeFetcher(map: Record<string, string>): PageFetcher & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetch: async (url: string) => {
      asked.push(url);
      const body = map[url];
      if (body === undefined) return { status: 404, contentType: "text/html", body: "not found", url };
      return { status: 200, contentType: "text/html; charset=utf-8", body, url };
    },
  };
}

describe("the SSRF guard", () => {
  it("blocks private, link-local, carrier-grade and mapped addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "104.18.32.7", "2606:4700::1111"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it("accepts only http(s) URLs without credentials", () => {
    expect(parseHttpUrl("https://shop.example/login#top").toString()).toBe("https://shop.example/login");
    expect(() => parseHttpUrl("ftp://shop.example/")).toThrow(/only http\(s\)/);
    expect(() => parseHttpUrl("https://user:pass@shop.example/")).toThrow(/credentials/);
    expect(() => parseHttpUrl("not a url")).toThrow(/not a URL/);
  });
});

describe("robots.txt", () => {
  const robots = "User-agent: *\nDisallow: /\n\nUser-agent: saas-site-crawler\nDisallow: /secret\nAllow: /secret/public\nDisallow: /*.pdf$\n";

  it("uses this crawler's own group over the wildcard group", () => {
    expect(robotsAllows(robots, "/")).toBe(true);
    expect(robotsAllows(robots, "/secret")).toBe(false);
    expect(robotsAllows(robots, "/secret/public")).toBe(true);
  });

  it("honours wildcard and end-anchored rules, with the longest match winning", () => {
    expect(robotsAllows(robots, "/pricing")).toBe(true);
    expect(robotsAllows(robots, "/terms.pdf")).toBe(false);
    expect(robotsAllows(robots, "/secret/public/terms.pdf")).toBe(false);
  });

  it("treats an absent or empty robots file as 'allowed'", () => {
    expect(robotsAllows(null, "/anything")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow:\n", "/anything")).toBe(true);
  });
});

describe("HTML extraction", () => {
  it("reads the title, description, h1, text and absolute links, and drops noise", () => {
    const html = `<html><head><title>Sign &amp; log in</title><meta name="description" content="Account access"></head>
      <body><script>alert("x")</script><h1>Welcome <em>back</em></h1>
      <p>Use the form below.</p><a href="/login">Log in</a><a href="mailto:help@shop.example">Mail</a>
      <a href="//cdn.example/x">CDN</a></body></html>`;
    const extracted = extractHtml(html, "https://shop.example/account/");
    expect(extracted.title).toBe("Sign & log in");
    expect(extracted.description).toBe("Account access");
    expect(extracted.h1).toBe("Welcome back");
    expect(extracted.text).not.toContain("alert");
    expect(extracted.links).toEqual(["https://shop.example/login", "https://cdn.example/x"]);
  });

  it("derives intent from the h1 and summary from the description, capping both", () => {
    const extracted = extractHtml("<h1>Log in to your account</h1>", "https://shop.example/login");
    expect(intentOf(extracted, "/login")).toBe("Log in to your account");
    expect(summaryOf({ description: "", text: "Use your email." }, "/login")).toBe("Use your email.");
    const long = extractHtml(`<h1>${"x".repeat(500)}</h1>`, "https://shop.example/");
    expect(intentOf(long, "/").length).toBe(160);
  });
});

describe("crawlSite", () => {
  it("walks the same host, obeys robots.txt, and reports what it skipped", async () => {
    const fetcher = fakeFetcher(siteHtml);
    const outcome = await crawlSite("https://shop.example", [], { fetcher });
    expect(outcome.host).toBe("shop.example");
    expect(outcome.pages.map((page) => page.path)).toEqual(["/", "/login", "/pricing"]);
    expect(outcome.pages[1]).toMatchObject({ title: "Sign in", intent: "Log in to your account" });
    expect(outcome.skips).toContainEqual({ url: "https://shop.example/secret", reason: "disallowed by robots.txt" });
    // The external link is never fetched, not even once.
    expect(fetcher.asked).not.toContain("https://evil.example/phish");
    expect(fetcher.asked).not.toContain("https://shop.example/secret");
  });

  it("caps the number of pages", async () => {
    const outcome = await crawlSite("https://shop.example", [], { fetcher: fakeFetcher(siteHtml), maxPages: 1 });
    expect(outcome.pages).toHaveLength(1);
  });

  it("refuses a root that does not answer, and a manual page off the host", async () => {
    await expect(crawlSite("https://shop.example", [], { fetcher: fakeFetcher({}) })).rejects.toThrow(/answered HTTP 404/);
    await expect(crawlSite("https://shop.example", ["https://evil.example/x"], { fetcher: fakeFetcher(siteHtml) })).rejects.toThrow(
      /not on shop\.example/,
    );
  });
});

describe("find_page", () => {
  it("routes 'where do I log in' to the crawled login page, and records the button", async () => {
    const actions: AgentAction[] = [];
    const tool = buildFindPageTool(scope(), { actions: (next) => actions.push(...next) });
    const answer = await tool.execute({ query: "where do I log in" });
    expect(answer).toContain("PAGE_FOUND");
    expect(answer).toContain("https://shop.example/login");
    expect(actions).toEqual([{ kind: "goto", label: "Sign in", url: "https://shop.example/login" }]);
    expect(bestPage(PAGES, "where do I log in")?.page.path).toBe("/login");
  });

  it("throws for a URL that was never crawled, so no button exists", async () => {
    const actions: AgentAction[] = [];
    const tool = buildFindPageTool(scope(), { actions: (next) => actions.push(...next) });
    await expect(tool.execute({ url: "https://evil.example/login" })).rejects.toThrow(/PAGE_NOT_FOUND/);
    await expect(tool.execute({ url: "https://shop.example/admin" })).rejects.toThrow(/no crawled page/);
    expect(actions).toEqual([]);
  });

  it("answers an unmatched question with the pages that do exist, not a guess", async () => {
    const actions: AgentAction[] = [];
    const tool = buildFindPageTool(scope(), { actions: (next) => actions.push(...next) });
    const answer = await tool.execute({ query: "quantum entanglement" });
    expect(answer).toMatch(/^NO_PAGE_MATCH/);
    expect(answer).toContain("/login");
    expect(actions).toEqual([]);
  });

  it("asks for a query or a URL when it is given neither", async () => {
    const answer = await buildFindPageTool(scope()).execute({});
    expect(answer).toMatch(/^TOOL_ERROR/);
  });

  it("resolves relative paths against the site root and refuses another host outright", () => {
    expect(pageForUrl(scope(), "/login").url).toBe("https://shop.example/login");
    expect(() => pageForUrl(scope(), "https://other.example/login")).toThrow(/only pages crawled from this site/);
  });
});

describe("assembly", () => {
  const triageAgent = { id: "age_1", name: "Front desk", systemPrompt: "You answer for a small shop." };

  const loaded = (): LoadedCapabilities => ({
    grants: [],
    skills: [],
    toolGrants: [],
    knowledge: [],
    knowledgeDocs: [],
    sites: [
      {
        ref: "site_1",
        siteId: "site_1",
        rootUrl: "https://shop.example/",
        host: "shop.example",
        status: "READY",
        pageCount: PAGES.length,
        state: "READY",
        pages: PAGES,
      },
    ],
    bodies: new Map(),
    world: { knowledge: false, embeddings: false, site: true },
    degradations: [],
  });

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    db: {} as PrismaClient,
    tenantId: "tnt_one",
    agentId: triageAgent.id,
    skills: new Map(),
    knowledge: { docIds: [], titles: [] },
    ...over,
  });

  it("derives find_page from a READY site and names the pages in the prompt", async () => {
    const data = loaded();
    const assembly = assembleTurn(triageAgent, data, ctx());
    const tool = assembly.tools.find((entry) => entry.name === "find_page");
    expect(tool).toBeDefined();
    expect(assembly.systemPrompt).toContain("## Pages you can send people to");
    expect(assembly.systemPrompt).toContain("Never invent a URL");
    expect(assembly.snapshot.tools.find((entry) => entry.key === "find_page")).toMatchObject({
      state: "READY",
      grant: "DERIVED",
    });
    expect(assembly.snapshot.sites[0]).toMatchObject({ host: "shop.example", pageCount: PAGES.length, state: "READY" });
  });

  it("ignores a site handed in by the caller, so no call site can widen the routing table", async () => {
    const evil: SiteScope = {
      siteId: "site_evil",
      rootUrl: "https://evil.example/",
      host: "evil.example",
      pages: [{ url: "https://evil.example/login", path: "/login", title: "Steal password", summary: "", intent: "" }],
    };
    const assembly = assembleTurn(triageAgent, loaded(), ctx({ site: evil }));
    const tool = assembly.tools.find((entry) => entry.name === "find_page");
    expect(tool).toBeDefined();
    await expect(tool!.execute({ url: "https://evil.example/login" })).rejects.toThrow(/not on shop\.example/);
  });
});
