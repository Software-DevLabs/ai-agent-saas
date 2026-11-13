import { z } from "zod";
import { ConfigError } from "./errors.ts";
import { loadEnvFiles } from "./env.ts";

const B64_KEY = z.string().regex(/^[A-Za-z0-9+/]{43,44}={0,2}$/, "must be base64 of 32 random bytes");

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  LOG_PRETTY: z.enum(["0", "1"]).default("0"),

  DATABASE_URL: z.string().refine((v) => v.startsWith("postgres://") || v.startsWith("postgresql://"), "must be a postgres URL"),
  DATABASE_DIRECT_URL: z.string().optional(),

  CREDENTIALS_KEY: B64_KEY,
  CREDENTIALS_KEY_ID: z.string().min(1).default("k1"),
  CREDENTIALS_KEY_PREVIOUS: z.string().optional(),
  CREDENTIALS_KEY_PREVIOUS_ID: z.string().optional(),
  SESSION_SECRET: B64_KEY,

  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().min(1).default("gemma4:31b-cloud"),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60000),
  // The embedding model the knowledge index asks for. Named separately from the
  // chat model because no chat model embeds: one daemon, two roles.
  OLLAMA_EMBED_MODEL: z.string().min(1).default("nomic-embed-text"),

  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),

  // The queue is Postgres (docs/decisions.md D7): these are the worker's own
  // timings, and every one has a default so a bare .env runs the loop.
  WORKER_LEASE_MS: z.coerce.number().int().min(5_000).default(120_000),
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(1_500),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(25).default(3),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  // How long a worker's heartbeat stays believable. Activation is refused past it:
  // 'active' is a promise that the next message gets an answer, and only a live
  // consumer can keep it.
  WORKER_STALE_MS: z.coerce.number().int().min(5_000).default(30_000),
  // A local Ollama can hold a request for minutes and withRetry repeats it,
  // so a run needs its own ceiling rather than inheriting the lease.
  WORKFLOW_RUN_DEADLINE_MS: z.coerce.number().int().min(10_000).default(900_000),

  // Tool loops multiply cost: one agent turn is up to this many model calls,
  // and one orchestrator turn fans out to that many subagent turns.
  AGENT_MAX_TOOL_STEPS: z.coerce.number().int().min(1).max(10).default(6),
  ORCHESTRATOR_MAX_SUBAGENT_CALLS: z.coerce.number().int().min(1).max(6).default(4),

  // Phase 2 (auth) replaces this: until sessions exist the console needs a
  // tenant to scope every query to. Unset means "resolve from the database".
  CONSOLE_TENANT_ID: z.string().optional(),

  // The directory the website widget bundle is built into. Unset resolves to
  // `apps/web/dist/embed` beside this workspace.
  EMBED_ROOT: z.string().optional(),
  // A public widget is an unauthenticated, paid surface, so it gets its own
  // bucket per visitor address and its own ceiling on a single answer. A token
  // bucket rather than a fixed window: a visitor who was quiet gets a full
  // handful back, and a script cannot burst past the capacity.
  EMBED_RATE_CAPACITY: z.coerce.number().int().min(1).max(500).default(20),
  EMBED_RATE_REFILL_PER_MIN: z.coerce.number().min(0.1).max(120).default(8),
  EMBED_TURN_DEADLINE_MS: z.coerce.number().int().min(10_000).default(120_000),

  // Crawling a tenant's own site reaches whatever address the URL resolves to.
  // The guard refuses private and reserved ranges by default; the switch exists
  // so a local verification site can be crawled on purpose, never by accident.
  SITE_ALLOW_PRIVATE_IPS: z.enum(["0", "1"]).default("0"),
  SITE_CRAWL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  SITE_CRAWL_MAX_PAGES: z.coerce.number().int().min(1).max(200).default(25),
  SITE_CRAWL_MAX_DEPTH: z.coerce.number().int().min(0).max(4).default(2),
});

export type AppConfig = z.infer<typeof envSchema> & { envFileLoaded: boolean };

/**
 * Parse once at boot, fail loudly naming the variables. A typed `config`
 * object is the only way any module may reach environment values.
 * `source` is injectable so tests never mutate `process.env`.
 */
export function loadConfig(source: Record<string, string | undefined> = process.env, opts: { envFiles?: string[] } = {}): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`invalid environment: ${problems}`);
  }
  return Object.freeze({ ...parsed.data, envFileLoaded: (opts.envFiles?.length ?? 0) > 0 });
}

/** Boot helper for entrypoints: load .env files, then parse the real environment. */
export function loadConfigFromEnv(): AppConfig {
  return loadConfig(process.env, { envFiles: loadEnvFiles() });
}
