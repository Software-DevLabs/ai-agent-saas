import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Queue } from "@saas/core";
import { Keyring, createLogger } from "@saas/shared";
import { createApp } from "../src/app.ts";
import type { RouteDeps } from "../src/routes.ts";

const log = createLogger({ LOG_LEVEL: "fatal", LOG_PRETTY: "0" });
const keyring = new Keyring({ id: "k1", key: Buffer.alloc(32, 7) });

/** Console routes are not exercised by these probes, so an empty client is enough. */
const routes = {
  db: {} as unknown as PrismaClient,
  keyring,
  tenantId: "tnt_test",
  providerConfig: { ollamaBaseUrl: "http://127.0.0.1:11434", ollamaModel: "test-model", ollamaTimeoutMs: 1000 },
  queue: {
    enqueue: async () => ({ id: "job_1", duplicate: false }),
    claim: async () => null,
    heartbeat: async () => true,
    attachRun: async () => {},
    succeed: async () => {},
    retry: async () => {},
    dead: async () => {},
    release: async () => {},
    counts: async () => ({ queued: 0, claimed: 0, failed: 0, dead: 0 }),
  } satisfies Queue,
  workerStaleMs: 30_000,
} satisfies RouteDeps;

describe("/healthz", () => {
  it("reports up when the database answers", async () => {
    const app = createApp({ config: { NODE_ENV: "test" }, log, db: { ping: async () => true }, routes });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, db: "up", env: "test" });
    await app.close();
  });

  it("reports down — never 500s at a load balancer — when the probe throws", async () => {
    const app = createApp({
      config: { NODE_ENV: "test" },
      log,
      routes,
      db: {
        ping: async () => {
          throw new Error("connection reset");
        },
      },
    });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, db: "down" });
    await app.close();
  });
});
