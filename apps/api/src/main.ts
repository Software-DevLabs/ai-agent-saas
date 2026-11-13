import { createLogger, Keyring, loadConfigFromEnv } from "@saas/shared";
import { makeDb } from "@saas/db";
import { PgQueue } from "@saas/core";
import { registeredProviders, resolveProvider } from "@saas/providers";
import { createApp } from "./app.ts";
import { defaultEmbedRoot, inspectEmbedBundle, serveEmbedBundle } from "./static.ts";
import { createPgRateLimiter } from "./embed/rate-limit.ts";
import { resolveConsoleTenant } from "./session.ts";

const config = loadConfigFromEnv();
const log = createLogger(config);
const db = makeDb(config);

const keyring = Keyring.fromEnv(config);
const session = await resolveConsoleTenant(db, config.CONSOLE_TENANT_ID);
const queue = new PgQueue(db);
const providerConfig = {
  ollamaBaseUrl: config.OLLAMA_BASE_URL,
  ollamaModel: config.OLLAMA_MODEL,
  ollamaTimeoutMs: config.OLLAMA_TIMEOUT_MS,
  ollamaEmbedModel: config.OLLAMA_EMBED_MODEL,
};

// Read before the app exists, because the console's snippet has to name the file
// that is actually on disk — including the content-addressed path the build wrote.
const embedRoot = config.EMBED_ROOT ?? defaultEmbedRoot();
const bundle = await inspectEmbedBundle(embedRoot);

const app = createApp({
  config,
  log,
  db: {
    ping: async () => {
      const rows = await db.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
      return rows[0]?.ok === 1;
    },
  },
  routes: {
    db,
    keyring,
    tenantId: session.tenantId,
    providerConfig,
    queue,
    workerStaleMs: config.WORKER_STALE_MS,
    embedBundle: { served: bundle.served, file: bundle.file },
    // Activation asks the provider itself, through the same adapter a run would
    // use. A provider with no probe answers "no", which refuses honestly.
    probeTools: async (provider, model) => {
      const adapter = resolveProvider(provider, { config: { ...providerConfig, ollamaModel: model } });
      return adapter.supportsTools ? adapter.supportsTools() : false;
    },
  },
  embed: {
    db,
    queue,
    limiter: createPgRateLimiter(db, {
      capacity: config.EMBED_RATE_CAPACITY,
      refillPerMinute: config.EMBED_RATE_REFILL_PER_MIN,
    }),
    // The session secret already exists to sign state; mixing it into the IP hash
    // means a dump of the rate table cannot be reversed into a list of addresses.
    ipSalt: config.SESSION_SECRET,
  },
});

log.info(
  { providers: registeredProviders(), port: config.PORT, tenant: session.tenantId, sessionVia: session.via },
  "api booting",
);

// A missing bundle is reported, not quietly skipped: the console will offer an
// embed snippet, and the difference between "nothing listening at /embed" and
// "the widget was never built" is the whole diagnosis.
const embed = await serveEmbedBundle(app, config.EMBED_ROOT ?? defaultEmbedRoot(), {
  immutable: config.NODE_ENV === "production",
});
if (embed.served) log.info({ root: embed.root, served: true }, embed.note);
else log.warn({ root: embed.root, served: false }, embed.note);

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (error) {
  log.fatal({ err: error }, "api failed to listen");
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info({ signal }, "shutting down");
    void app.close().finally(() => db.$disconnect());
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
