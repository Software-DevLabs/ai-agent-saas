import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { jsonSafe, type AppConfig } from "@saas/shared";
import { registerRoutes, toReply, type RouteDeps } from "./routes.ts";
import { registerEmbedApi, type EmbedApiDeps } from "./embed/routes.ts";

/**
 * The API is created from injected parts so every test can hand it a fake
 * probe and never touch Neon. `main.ts` is the only place that reads the real
 * world.
 *
 * `log` is typed with fastify's own logger contract: pino's concrete Logger
 * satisfies it, and taking the wider type avoids pinning two pino copies
 * against each other in the workspace.
 */
export interface HealthProbe {
  ping(): Promise<boolean>;
}

export interface AppParts {
  config: Pick<AppConfig, "NODE_ENV">;
  log: FastifyBaseLogger;
  db: HealthProbe;
  routes: RouteDeps;
  /**
   * The public widget surface. It is registered only when an entrypoint supplies
   * it, so a test of the console routes cannot accidentally expose a route that
   * answers strangers — and no test has to fake a limiter it does not exercise.
   */
  embed?: EmbedApiDeps;
}

export function createApp(parts: AppParts): FastifyInstance {
  const app = Fastify({ loggerInstance: parts.log, bodyLimit: 1_048_576 });

  app.setErrorHandler((error, request, reply) => {
    const mapped = toReply(error);
    if (mapped.status >= 500) {
      // Never echo internals to callers; the real cause stays in the log only.
      parts.log.error({ err: error, url: request.url }, "request failed");
    } else {
      parts.log.warn({ url: request.url, code: mapped.body.error }, mapped.body.message);
    }
    void reply.status(mapped.status).send(mapped.body);
  });

  app.get("/healthz", async () => {
    let dbUp = false;
    try {
      dbUp = await parts.db.ping();
    } catch {
      dbUp = false;
    }
    return jsonSafe({ ok: dbUp, db: dbUp ? "up" : "down", env: parts.config.NODE_ENV }) as { ok: boolean };
  });

  registerRoutes(app, parts.routes);
  if (parts.embed !== undefined) registerEmbedApi(app, parts.embed);

  return app;
}
