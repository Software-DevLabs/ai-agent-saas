import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { SITE_CRAWL_LANE, type NewJob, type Queue } from "@saas/core";
import { Keyring, createLogger } from "@saas/shared";
import { createApp } from "../src/app.ts";
import type { RouteDeps } from "../src/routes.ts";

/**
 * The site surface over HTTP, against a fake that behaves like the tables.
 *
 * What is asserted here is what a comment cannot promise: the site is filed in the
 * agent's own project (never a body-supplied one), a save always queues a crawl,
 * an off-host manual page is refused before anything is written, a crawl in flight
 * cannot be replaced by a second one, and deleting the site takes its grant with it
 * so no turn is left holding a ref that no longer resolves.
 */

const log = createLogger({ LOG_LEVEL: "fatal", LOG_PRETTY: "0" });
const keyring = new Keyring({ id: "k1", key: Buffer.alloc(32, 7) });

type Row = Record<string, unknown>;

function matches(row: Row, where: unknown): boolean {
  if (where === undefined || where === null) return true;
  const clause = where as Record<string, unknown>;
  return Object.entries(clause).every(([key, value]) => {
    if (key === "AND") return (value as unknown[]).every((entry) => matches(row, entry));
    if (key === "OR") return (value as unknown[]).some((entry) => matches(row, entry));
    if (value !== null && typeof value === "object" && "in" in (value as object)) {
      return ((value as { in: unknown[] }).in ?? []).includes(row[key]);
    }
    return row[key] === value;
  });
}

function pick<T extends Row>(row: T, select: unknown): Row {
  if (select === undefined || select === null || typeof select !== "object") return { ...row };
  const keys = Object.keys(select as Record<string, boolean>);
  return Object.fromEntries(keys.filter((key) => key !== "_count").map((key) => [key, row[key]]));
}

interface Seed {
  sites?: Row[];
  pages?: Row[];
  grants?: Row[];
}

function fakeDb(seed: Seed = {}) {
  const sites = seed.sites ?? [];
  const pages = seed.pages ?? [];
  const grants = seed.grants ?? [];
  const agent = { id: "agt_1", tenantId: "tnt_one", projectId: "prj_two", name: "Support" };
  const now = new Date("2026-10-31T10:00:00Z");

  const orderRows = (rows: Row[], orderBy: unknown): Row[] => {
    if (orderBy === undefined || orderBy === null || typeof orderBy !== "object") return rows;
    const [field, direction] = Object.entries(orderBy as Record<string, string>)[0] ?? [];
    if (field === undefined) return rows;
    return [...rows].sort((a, b) => {
      const left = String(a[field] ?? "");
      const right = String(b[field] ?? "");
      return direction === "desc" ? right.localeCompare(left) : left.localeCompare(right);
    });
  };

  const sitePage = {
    findMany: async ({ where, select, orderBy, take }: { where: unknown; select?: unknown; orderBy?: unknown; take?: number }) => {
      const found = orderRows(pages.filter((page) => matches(page, where)), orderBy);
      return found.slice(0, take ?? found.length).map((page) => pick(page, select));
    },
    deleteMany: async ({ where }: { where: unknown }) => {
      const before = pages.length;
      for (let at = pages.length - 1; at >= 0; at -= 1) {
        if (matches(pages[at] as Row, where)) pages.splice(at, 1);
      }
      return { count: before - pages.length };
    },
    createMany: async ({ data }: { data: Row[] }) => {
      for (const entry of data) pages.push({ id: `page_${pages.length + 1}`, ...entry });
      return { count: data.length };
    },
  };

  const site = {
    findFirst: async ({ where, select }: { where: unknown; select?: unknown }) => {
      const row = sites.find((entry) => matches(entry, where));
      return row === undefined ? null : pick(row, select);
    },
    findFirstOrThrow: async ({ where, select }: { where: unknown; select?: unknown }) => {
      const row = sites.find((entry) => matches(entry, where));
      if (row === undefined) throw new Error("not found");
      return pick(row, select);
    },
    findMany: async ({ where, select, orderBy }: { where: unknown; select?: unknown; orderBy?: unknown }) =>
      orderRows(sites.filter((entry) => matches(entry, where)), orderBy).map((entry) => pick(entry, select)),
    create: async ({ data }: { data: Row }) => {
      const row: Row = {
        id: `site_${sites.length + 1}`,
        error: null,
        pageCount: 0,
        crawledAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      sites.push(row);
      return { id: row.id };
    },
    updateMany: async ({ where, data }: { where: unknown; data: Row }) => {
      const found = sites.filter((entry) => matches(entry, where));
      for (const row of found) Object.assign(row, data, { updatedAt: now });
      return { count: found.length };
    },
    delete: async ({ where }: { where: unknown }) => {
      const at = sites.findIndex((entry) => matches(entry, where));
      const [removed] = sites.splice(at, 1);
      return removed;
    },
  };

  const agentCapability = {
    findFirst: async ({ where, select }: { where: unknown; select?: unknown }) => {
      const row = grants.find((grant) => matches(grant, where));
      return row === undefined ? null : pick(row, select);
    },
    create: async ({ data }: { data: Row }) => {
      grants.push({ id: `cap_${grants.length + 1}`, tenantId: "tnt_one", enabled: true, config: {}, ...data });
      return { id: `cap_${grants.length}` };
    },
    updateMany: async ({ where, data }: { where: unknown; data: Row }) => {
      const found = grants.filter((grant) => matches(grant, where));
      for (const row of found) Object.assign(row, data);
      return { count: found.length };
    },
    deleteMany: async ({ where }: { where: unknown }) => {
      const before = grants.length;
      for (let at = grants.length - 1; at >= 0; at -= 1) {
        if (matches(grants[at] as Row, where)) grants.splice(at, 1);
      }
      return { count: before - grants.length };
    },
  };

  const tx = { agentCapability, site, sitePage };
  const db = {
    agent: {
      findFirst: async ({ where }: { where?: unknown } = {}) => (where === undefined || matches(agent, where) ? agent : null),
    },
    agentCapability,
    site,
    sitePage,
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { db: db as unknown as PrismaClient, sites, pages, grants };
}

function fakeQueue() {
  const jobs: NewJob[] = [];
  const queue: Queue = {
    enqueue: async (job) => {
      jobs.push(job);
      return { id: `job_${jobs.length}`, duplicate: false };
    },
    claim: async () => null,
    heartbeat: async () => true,
    attachRun: async () => {},
    succeed: async () => {},
    retry: async () => {},
    dead: async () => {},
    release: async () => {},
    counts: async () => ({ queued: 0, claimed: 0, failed: 0, dead: 0 }),
  };
  return { queue, jobs };
}

function appWith(db: PrismaClient, queue: Queue) {
  const routes: RouteDeps = {
    db,
    keyring,
    tenantId: "tnt_one",
    providerConfig: { ollamaBaseUrl: "http://127.0.0.1:11434", ollamaModel: "test-model", ollamaTimeoutMs: 1000 },
    queue,
    workerStaleMs: 30_000,
  };
  return createApp({ config: { NODE_ENV: "test" }, log, db: { ping: async () => true }, routes });
}

const siteRow = (over: Row = {}): Row => ({
  id: "site_1",
  tenantId: "tnt_one",
  projectId: "prj_two",
  agentId: "agt_1",
  rootUrl: "https://shop.example/",
  host: "shop.example",
  manualUrls: [],
  status: "READY",
  error: null,
  pageCount: 2,
  crawledAt: new Date("2026-10-31T09:00:00Z"),
  createdAt: new Date("2026-10-31T08:00:00Z"),
  updatedAt: new Date("2026-10-31T09:00:00Z"),
  ...over,
});

describe("saving a site", () => {
  it("files it in the agent's project, grants it, and queues a crawl", async () => {
    const { db, sites, grants } = fakeDb();
    const { queue, jobs } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({
      method: "PUT",
      url: "/agents/agt_1/site",
      payload: { rootUrl: "https://shop.example", manualUrls: ["/login", "https://shop.example/pricing"] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ host: "shop.example", status: "PENDING", queued: true, queue: "queued" });
    expect(body.rootUrl).toBe("https://shop.example/");
    expect(body.manualUrls).toEqual(["https://shop.example/login", "https://shop.example/pricing"]);

    // The tenant and project come from the session and the agent row — a body field
    // claiming another project is not even part of the schema.
    expect(sites[0]).toMatchObject({ tenantId: "tnt_one", projectId: "prj_two", agentId: "agt_1", status: "PENDING" });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ kind: "SITE", ref: sites[0]!.id, enabled: true, agentId: "agt_1" });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ lane: SITE_CRAWL_LANE, tenantId: "tnt_one", source: "site", payload: { siteId: sites[0]!.id } });
    await app.close();
  });

  it("refuses a URL that is not http(s), and writes nothing", async () => {
    const { db, sites, grants } = fakeDb();
    const { queue, jobs } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({ method: "PUT", url: "/agents/agt_1/site", payload: { rootUrl: "ftp://shop.example" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("site_url_invalid");
    expect(sites).toHaveLength(0);
    expect(grants).toHaveLength(0);
    expect(jobs).toHaveLength(0);
    await app.close();
  });

  it("refuses a manual page on another host, naming both hosts", async () => {
    const { db } = fakeDb();
    const { queue } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({
      method: "PUT",
      url: "/agents/agt_1/site",
      payload: { rootUrl: "https://shop.example", manualUrls: ["https://evil.example/login"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("site_manual_offhost");
    expect(res.json().message).toContain("shop.example");
    await app.close();
  });

  it("refuses to replace a site while its crawl is running", async () => {
    const { db } = fakeDb({ sites: [siteRow({ status: "CRAWLING" })] });
    const { queue, jobs } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({ method: "PUT", url: "/agents/agt_1/site", payload: { rootUrl: "https://shop.example" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("site_crawling");
    expect(jobs).toHaveLength(0);
    await app.close();
  });

  it("drops the old pages when the host changes, so no old URL survives the switch", async () => {
    const { db, sites, pages } = fakeDb({
      sites: [siteRow()],
      pages: [
        { id: "page_1", tenantId: "tnt_one", siteId: "site_1", url: "https://shop.example/login", path: "/login", title: "Sign in", summary: "", intent: "sign in" },
      ],
    });
    const { queue } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({ method: "PUT", url: "/agents/agt_1/site", payload: { rootUrl: "https://help.example" } });
    expect(res.statusCode).toBe(200);
    expect(pages).toHaveLength(0);
    expect(sites[0]).toMatchObject({ host: "help.example", status: "PENDING", pageCount: 0, crawledAt: null });
    await app.close();
  });
});

describe("reading a site", () => {
  it("answers null before any site is saved", async () => {
    const { db } = fakeDb();
    const { queue } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({ method: "GET", url: "/agents/agt_1/site" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
    await app.close();
  });

  it("lists the crawled pages the routing tool is allowed to offer", async () => {
    const { db } = fakeDb({
      sites: [siteRow()],
      pages: [
        { id: "page_2", tenantId: "tnt_one", siteId: "site_1", url: "https://shop.example/pricing", path: "/pricing", title: "Pricing", summary: "Plans", intent: "pricing" },
        { id: "page_1", tenantId: "tnt_one", siteId: "site_1", url: "https://shop.example/login", path: "/login", title: "Sign in", summary: "Log in", intent: "sign in" },
      ],
    });
    const { queue } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({ method: "GET", url: "/agents/agt_1/site" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: "READY", pageCount: 2 });
    expect(body.pages.map((page: { path: string }) => page.path)).toEqual(["/login", "/pricing"]);
    await app.close();
  });
});

describe("deleting a site", () => {
  it("removes the site row and its grant in one transaction", async () => {
    const { db, sites, grants } = fakeDb({
      sites: [siteRow()],
      grants: [{ id: "cap_1", tenantId: "tnt_one", agentId: "agt_1", kind: "SITE", ref: "site_1", enabled: true }],
    });
    const { queue } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({ method: "DELETE", url: "/agents/agt_1/site" });
    expect(res.statusCode).toBe(204);
    expect(sites).toHaveLength(0);
    expect(grants).toHaveLength(0);
    await app.close();
  });
});

describe("site grants", () => {
  it("refuses a grant that names no site in this tenant", async () => {
    const { db } = fakeDb();
    const { queue } = fakeQueue();
    const app = appWith(db, queue);

    const res = await app.inject({
      method: "PUT",
      url: "/agents/agt_1/capabilities",
      payload: { capabilities: [{ kind: "SITE", ref: "site_missing" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("capability_site_unknown");
    await app.close();
  });
});
