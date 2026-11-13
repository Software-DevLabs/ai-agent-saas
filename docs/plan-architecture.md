# AI Agent Integration SaaS — Architecture & Build Plan

> Project brief + phase-by-phase task list. Feed this to the coding agent one phase at a time.
> Rules of engagement: never start a phase until the previous phase's EXIT GATE passes.
> A new provider/channel/connector is a new adapter file + registry line — never a new `if` inside core logic.
> Any new third-party dependency not listed in §2 requires asking first.

---

## 1. The product in one page

A non-technical user creates an **Agent** in a dashboard. The agent:

1. Listens on an **input channel** (Telegram first, WhatsApp Cloud API second).
2. Sends each incoming message through a **pluggable model provider** (Groq → Gemini/OpenAI/Ollama later).
3. Writes the reply to **output connectors** (Google Sheets → Drive/Webhook/Notion later).
4. Is **metered**: every model call debits the tenant's token balance, tied to a Stripe plan.

Core loop, end to end:

```
Telegram update ──▶ webhook (verify → dedupe → enqueue → 200)
                        │
                        ▼
                  BullMQ (Redis)
                        │
                        ▼
        worker: load agent → check balance → provider.run(text + history)
                → commitUsage(ledger) → save messages → connectors.write()
                → channel.sendReply() → mark processed
        (failure after N tries → dead-letter queue, surfaced in dashboard)
```

Milestones:

| # | Milestone | Proves |
|---|-----------|--------|
| M0 | Foundation | repo boots, CI green, secrets encrypted, logs redacted |
| M1 | Schema + migrations | data model survives first real query patterns |
| M2 | Auth + tenancy | two tenants cannot see each other's rows |
| M3 | Provider layer | one working provider, usage numbers are real |
| M4 | Agent CRUD + dashboard | a user can create an agent in the UI |
| M5 | **Vertical slice** | a Telegram message gets an AI reply end to end |
| M6 | Ledger + quota | over-quota tenants are blocked and told why |
| M7 | Sheets connector | the reply lands in the tenant's spreadsheet |
| M8 | Usage dashboard + Stripe | plans enforced, usage visible, money collected |
| M9 | More providers | adding Gemini/OpenAI is a small diff, no core edits |
| M10 | WhatsApp | channel abstraction holds for a second input type |

---

## 2. Locked stack decisions

| Layer | Choice | Notes |
|-------|--------|-------|
| Frontend | React + Vite + TypeScript, TanStack Router + Query | SPA dashboard, no SSR |
| Backend API | Node.js + TypeScript + **Fastify** | tenant/auth middleware as plugins |
| Jobs / queue | **BullMQ on Redis** | webhook must never await a model call |
| Database | **PostgreSQL + Prisma** | source of truth for tenants/ledger |
| Cache / rate limit | Redis (same instance, separate DB index) | |
| Auth | **Auth.js or better-auth** (email/password + Google OAuth) | see §10 decision note — the original brief said Lucia; Lucia 1.x is unmaintained. Google OAuth doubles as the Sheets/Drive consent gate |
| Billing | Stripe (subscriptions + plan mapping) | |
| Secrets at rest | libsodium sealed box (`sodium-native` / `libsodium-wrappers`) | one `encrypt()/decrypt()` utility, used everywhere |
| Observability | pino + OpenTelemetry + Sentry | |
| Deploy | Docker on Railway/Render/Fly | compose file for local dev |

Package manager: **pnpm workspaces** (monorepo, three apps + shared packages).
Tests: **vitest**. Lint/typecheck: ESLint + `tsc --noEmit`. All free-tier-sized; no Kubernetes, no microservices, no service mesh.

---

## 3. System architecture

```
                ┌──────────────────────────────────────────┐
                │            React Dashboard (apps/web)     │
                │   agent builder · connections · usage ·   │
                │   billing · failed-messages view           │
                └───────────────────┬──────────────────────┘
                                    │ REST (JSON, authenticated session)
                ┌───────────────────▼──────────────────────┐
                │          Fastify API (apps/api)           │
                │  auth + tenant middleware · rate limiter  │
                │  CRUD: agents / integrations / billing    │
                │  webhooks: /hooks/telegram/:integrationId │
                │           /hooks/whatsapp/:integrationId  │
                └───────┬───────────────────────┬──────────┘
                        │ enqueue               │ read/write
               ┌────────▼────────┐     ┌────────▼────────┐
               │ BullMQ (Redis)  │     │  PostgreSQL     │
               │  message-jobs   │     │  (source of     │
               │  message-jobs-  │     │   truth)        │
               │  dead  ·  cron  │     └────────▲────────┘
               └────────┬────────┘              │
                        │ dequeue               │
               ┌────────▼───────────────────────┴─────────┐
               │           Worker (apps/worker)            │
               │  stateless · N processes behind the queue │
               └───┬──────────────┬───────────────┬────────┘
                   │              │               │
        ┌──────────▼───┐  ┌───────▼────────┐  ┌───▼──────────────┐
        │ providers/   │  │ channels/      │  │ connectors/      │
        │ groq gemini  │  │ telegram       │  │ sheets drive     │
        │ openai ollama│  │ whatsapp       │  │ webhook notion…  │
        └──────────────┘  └────────────────┘  └──────────────────┘
```

Four invariants this architecture buys:

1. **The webhook handler is thin.** verify → dedupe → enqueue → `200`. Never awaits a model call.
2. **The worker is stateless.** Any instance can take any job; nothing is cached in process memory beyond one job's lifetime.
3. **Postgres is the truth. Redis is transport.** Ledger balance lives in Postgres; Redis holds queue + rate-limit windows only.
4. **Idempotency is enforced at the edge**, not inside the worker (see §5 `WebhookEventLog`).

---

## 4. Repository layout

```
ai-agent-saas/
├── apps/
│   ├── api/            # Fastify server: routes, auth, webhooks
│   ├── worker/         # BullMQ consumer: processMessage, cron jobs
│   └── web/            # Vite + React dashboard
├── packages/
│   ├── db/             # prisma schema, client, migrations, seed
│   ├── core/           # domain services: ledger, conversations, agent runner
│   ├── providers/      # ModelProvider interface + one file per adapter
│   ├── channels/       # ChannelAdapter interface + one file per adapter
│   ├── connectors/     # OutputConnector interface + one file per adapter
│   └── shared/         # config (zod env), logger, crypto, errors, retry
├── infra/
│   ├── docker-compose.yml   # local postgres + redis
│   └── Dockerfile           # api and worker images
├── .github/workflows/ci.yml
├── .env.example             # every variable, one line of comment each
├── docs/
│   ├── plan-architecture.md  # this file
│   ├── runbooks.md           # set-webhook, rotate key, replay DLQ
│   └── decisions.md          # ADR log — one page per locked decision
└── package.json (pnpm workspace root)
```

Dependency rule: `shared ← db ← core ← {providers, channels, connectors} ← {api, worker}`.
Adapters import **only** `shared` types, never `db` and never each other. `core` orchestrates; adapters are dumb and individually testable.

---

## 5. Data model (Prisma)

Models (full field list in the brief; deltas and indexes noted here):

| Model | Responsibility | Watch-outs |
|-------|----------------|-----------|
| `Tenant` | owns everything; plan + cached `tokenBalance` | `@@index([cycleResetAt])` for the reset sweep |
| `User` | OWNER/ADMIN/MEMBER within one tenant | `googleRefreshToken` stores the **encrypted** blob only |
| `Plan` | price, `tokenQuota`, `maxIntegrations`, `features` Json | seed Free/Pro in migration |
| `Agent` | prompt + provider/model/temperature/maxOutputTokens | `modelProvider`/`modelName` validated against the registry, not a bare string in UI |
| `Integration` | one credential set, `credentialsEncrypted` single blob | `status` should be an enum `CONNECTED / ERROR / REVOKED`, not a string |
| `AgentIntegration` | joins agent ↔ integration with direction | add `@@unique([agentId, integrationId])` |
| `Conversation` | one external chat thread | add `@@unique([agentId, externalChatId])` — upsert on this key |
| `ConversationMessage` | history + per-message token counts | load recent window by `(conversationId, createdAt)` index |
| `UsageEvent` | the audit ledger; balance is a cache, this is truth | `@@index([tenantId, createdAt])`; never mutate rows |
| `WebhookEventLog` | idempotency guard | `externalMessageId @unique` is the whole point; store a **hash** of the id if the raw id can be long |

Three design decisions baked in:

- **Dedupe at enqueue.** The webhook handler inserts `WebhookEventLog` and enqueues in the *same transaction path*; a unique-violation on `externalMessageId` returns `200` and does nothing else. Redelivered webhooks can never double-reply or double-bill.
- **Two-entry token accounting.** `Tenant.tokenBalance` is a fast read; `UsageEvent` is append-only truth. A periodic reconciliation compares `quota − Σ usage` against the balance and alarms on drift.
- **One encrypted blob per integration.** Never split secrets into columns. Format: `v1:<keyId>:<base64 nonce+box>` so rotation is possible (§10).

---

## 6. Module contracts (the interfaces everything hides behind)

```ts
// packages/providers/src/types.ts
export interface ModelRunInput {
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxOutputTokens: number;
  temperature: number;
}
export interface ModelRunResult {
  content: string;
  inputTokens: number;   // MUST come from the provider's usage payload
  outputTokens: number;  // never a local tokenizer estimate
}
export interface ModelProvider {
  readonly name: string;
  run(input: ModelRunInput): Promise<ModelRunResult>;
}

// packages/channels/src/types.ts
export interface IncomingMessage {
  externalChatId: string;
  text: string;
  externalMessageId: string;
  receivedAt: Date;
}
export interface ChannelAdapter {
  readonly type: "telegram" | "whatsapp";
  verifyWebhook(req: { headers: Record<string, string>; rawBody: string },
                integration: DecodedIntegration): boolean;   // constant-time compare
  parseIncoming(body: unknown): IncomingMessage | null;
  sendReply(input: { externalChatId: string; text: string;
                     credentials: DecodedCredentials }): Promise<void>;
}

// packages/connectors/src/types.ts
export interface OutputConnector {
  readonly type: string;
  write(input: { agentId: string; tenantId: string;
                 data: Record<string, unknown>;
                 credentials: DecodedCredentials }): Promise<void>;
}

// packages/core/src/ledger.ts
export interface Ledger {
  getBalance(tenantId: string): Promise<bigint>;
  commitUsage(tenantId: string, agentId: string,
              usage: { inputTokens: number; outputTokens: number }): Promise<void>;
  resetCycle(tenantId: string): Promise<void>;
}
```

**Registry rule (security, not tidiness):** every adapter type has a registry map
(`resolveProvider(name)`, `resolveConnector(type)`, `resolveChannel(type)`).
**Duplicate registration is fatal at boot** — a silent overwrite lets a later module
shadow an earlier adapter's behavior while callers still believe they got the original.

`processMessage` receives its collaborators by injection (`{ provider, channel, ledger, connectors, store }`)
so the highest-leverage test in the codebase runs with fakes and zero network.

---

## 7. Cross-cutting rules (non-negotiable)

**Security**
1. Every webhook verifies before parsing — Telegram secret-token header, WhatsApp `X-Hub-Signature-256` HMAC; constant-time comparison.
2. Every credential at rest goes through the single `packages/shared/crypto.ts` (libsodium sealed box). No raw secret column anywhere.
3. Tenant isolation at the query layer: Prisma client **extension** injects `tenantId` from the authenticated session; `tenantId` in a request body is ignored, always.
4. Rate limiting per tenant (Redis sliding window, key `rl:{tenantId}`) — one noisy tenant cannot burn the shared Groq quota.
5. No secrets in logs: pino `redact` paths + never logging credential blobs.
6. Idempotent webhook intake enforced at enqueue (unique `externalMessageId`).
7. No secret ever goes into argv, a URL, or a log line; adapters read credentials from config/DB once and pass them via header/env.

**Reliability**
- Every external call wrapped in `withRetry(fn, { retries, backoffMs })`; retries only on transient errors (429/5xx/network), never on guard refusals or 4xx.
- Job fails after max attempts → dead-letter queue `message-jobs-dead` → dashboard shows "failed messages" per agent. Nothing is silently dropped.
- Provider down: fail cleanly with a clear user-facing error (secondary-provider fallback is v2, out of scope).

**Observability**
- One structured log line per worker run:
  `{ tenantId, agentId, jobId, provider, modelName, inputTokens, outputTokens, latencyMs, status }`.
- Sentry on api + worker; OpenTelemetry traces spanning webhook → queue → provider → connectors.

**Testing**
- vitest everywhere; provider/channel/connector adapters tested against fake HTTP, never live APIs.
- Approval/billing paths tested at boundaries (zero balance, concurrent commits, redelivered webhook).
- CI gate: typecheck + lint + unit tests + `prisma migrate diff` clean.

---

## 8. Build plan — phases and tasks

Format per the brief: `- [ ] - Task name`, then the explanation.

### Phase 0 — Foundation  → M0

- [ ] - T0.1 - Scaffold monorepo
      pnpm workspaces; create `apps/api`, `apps/worker`, `apps/web`, `packages/{db,core,providers,channels,connectors,shared}`. Strict tsconfig base shared by all packages; vitest configured per package; ESLint flat config. `pnpm dev` must boot all three apps.
- [ ] - T0.2 - Local infra
      `infra/docker-compose.yml` with postgres:16 and redis:7 (queue on db 0, rate-limit on db 1). `.env.example` listing every variable with one comment line each: `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `CREDENTIALS_KEY`, `CREDENTIALS_KEY_ID`, `GROQ_API_KEY`, `TELEGRAM_WEBHOOK_SECRET`, `STRIPE_*`, `SENTRY_DSN`. Nothing reads `process.env` outside the config module.
- [ ] - T0.3 - Config module
      `packages/shared/config.ts`: zod schema over the env, parsed once at boot, fail-fast with a readable error naming the missing variable. Export typed `config` only.
- [ ] - T0.4 - Structured logger with redaction
      pino instance in `shared/logger.ts`; `redact: { paths: ["credentials*", "*.token", "*.apiKey", "authorization", ...], censor: "[redacted]" }`. Unit test: a log line containing a fake token does not print it.
- [ ] - T0.5 - Crypto utility (sealed box)
      `shared/crypto.ts`: `encrypt(plain): string` → `v1:<keyId>:<b64>` and `decrypt(blob): string`; unknown `keyId` throws with a rotation hint. Keys from config; support two active keys (current + previous) so rotation is not a big-bang event. Round-trip + wrong-key + tampered-box tests.
- [ ] - T0.6 - CI pipeline
      GitHub Actions: install → typecheck → lint → vitest → `prisma validate && prisma migrate diff --exit-empty`. Green from the first real commit; later phases may not merge red.

EXIT GATE: `pnpm dev` boots api+worker+web against local compose; CI green; crypto and logger tests prove secrets stay out of logs and out of the DB in plaintext.

### Phase 1 — Schema & migrations  → M1

- [ ] - T1.1 - Write Prisma schema
      All ten models from §5 with the added uniques (`AgentIntegration`, `Conversation`) and indexes (`UsageEvent(tenantId, createdAt)`, `Tenant(cycleResetAt)`); enums for `Role`, `Plan`, `AgentStatus`, `IntegrationType`, `IntegrationStatus`, `Direction`.
- [ ] - T1.2 - First migration + seed
      `prisma migrate dev` baseline; `seed.ts` creates Free and Pro plans and a demo tenant so the dashboard has something to render in dev.
- [ ] - T1.3 - Tenant-scoped Prisma extension
      `packages/db/scopedClient.ts`: `$extends` variant of the client that requires a `tenantId` at creation and auto-filters/inputs it on tenant-scoped models. Plain client is banned in `apps/api` route code (ESLint rule or convention + review).
- [ ] - T1.4 - BigInt/Decimal serialization helpers
      `shared/json.ts`: provider/REST layer converts BigInt↔string, Decimal↔number at the edges; nothing downstream does ad-hoc conversion. Test the round trip through a real Fastify reply.

EXIT GATE: migration applies on a fresh DB; scoped-client test proves a query for tenant A cannot return tenant B rows.

### Phase 2 — Auth & tenancy  → M2

- [ ] - T2.1 - Auth integration
      Auth.js (or better-auth — decision in §10) with email/password + Google OAuth. Google is required now, not later: it is the consent gate reused by the Sheets/Drive flow in Phase 7.
- [ ] - T2.2 - Signup creates Tenant + OWNER
      One transaction: user row + tenant row + default Free plan assignment. New-user session carries `tenantId` only.
- [ ] - T2.3 - Fastify auth + tenant middleware
      Session verification hook populating `request.user` / `request.tenantId`; `requireAuth` and `requireRole("ADMIN")` route-level hooks. All webhooks mounted on a separate prefix that explicitly skips session auth (they use their own verification).
- [ ] - T2.4 - Per-tenant rate limiter
      Redis sliding-window keyed `rl:{tenantId}`; Fastify hook; 429 with `Retry-After`. Test: two tenants get independent budgets.
- [ ] - T2.5 - Minimal web auth screens
      Sign in / sign up / agent list shell in TanStack Router with protected routes.

EXIT GATE: two tenants registered; API test proves tenant A with a valid session cannot read tenant B's agent by ID.

### Phase 3 — Provider layer  → M3

- [ ] - T3.1 - ModelProvider interface + registry
      Interface exactly as §6; `resolveProvider(name)`; registry entries registered once at module load; **duplicate name throws at boot**. Test the throw.
- [ ] - T3.2 - GroqProvider
      OpenAI-compatible `/chat/completions` via plain `fetch`. Reads `usage.prompt_tokens`/`completion_tokens` from the response — never estimates. Maps 429/5xx to a `TransientProviderError`, 4xx to `ProviderError` with the provider's message. Timeout via AbortSignal (60s).
- [ ] - T3.3 - withRetry helper
      `shared/retry.ts`: exponential backoff + jitter; retries only `TransientError` subclasses; respects `Retry-After` when the error carries one. Tests with a fake clock and a failing fake.

EXIT GATE: a unit test with a mocked HTTP response yields content + real token counts; a 429-then-200 fake exhausts exactly the configured retries.

### Phase 4 — Agent CRUD + minimal dashboard  → M4

- [ ] - T4.1 - Agents REST API
      create / list / get / update / pause / resume, all through the scoped client. `modelProvider`/`modelName` validated against the registry so the UI cannot save a provider that does not exist.
- [ ] - T4.2 - Integrations API
      Create stores `encrypt(credentials)`; a `GET` returns type + masked preview (`****1234`) only — the decrypt path exists only inside the worker. Update / revoke status transitions.
- [ ] - T4.3 - Dashboard agent builder page
      Form: name, system prompt, provider + model select, temperature, max output tokens; live connection list with connect/disconnect. TanStack Query wired to the API; typed errors surface inline.
- [ ] - T4.4 - Smoke path
      Script or test: sign up → create agent → create Telegram integration → rows correct, credentials column does not contain the bot token (assert on the raw SQL value).

EXIT GATE: a user can build an agent in the browser; DB inspection shows no plaintext secret anywhere.

> **Console already standing (2026-10-30, built ahead of the API).** `apps/web` is a
> Vite + React + TS + Tailwind workspace package: sidebar shell with spring `layoutId`
> nav, light/dark semantic tokens, and nine pages (overview, agents, agent detail,
> connections, runs, usage, playground, billing, settings). It reads fixtures from
> `apps/web/src/lib/fixtures.ts` through the same query hooks that will call the REST
> routes — `VITE_API_LIVE=1` flips every read to `apiFetch` with no page changes, so
> T4.1/T4.2 are the only thing between this and a live console. The health pill is
> already live (`/api/healthz` through the dev proxy). T4.3 stays open until the form
> writes to the API and the plaintext-secret assertion in T4.4 passes.

### Phase 5 — Telegram vertical slice  → M5 (the milestone that matters)

- [ ] - T5.1 - TelegramChannel
      `verifyWebhook`: constant-time compare of the `X-Telegram-Bot-Api-Secret-Token` header against the integration's stored secret. `parseIncoming`: extract chat id, text, message id; drop non-text and edits/bot's-own-messages with a reason. `sendReply`: `sendMessage` with MarkdownV2 escaping — escaping bugs here are the classic Telegram footgun; a wrong entity type 400s the whole reply.
- [ ] - T5.2 - Webhook endpoint + idempotent enqueue
      `POST /hooks/telegram/:integrationId` → resolve integration → verify → **insert `WebhookEventLog` and enqueue in one flow**; unique violation = replay → `200` and stop. Always `200` fast (Telegram retries); parse failures log + `200` (nothing to retry).
- [ ] - T5.3 - Queue + job payload
      `message-jobs` in BullMQ. Job = `{ tenantId, agentId, integrationId, conversationKey, externalChatId, text, externalMessageId }` — the whole job is plain JSON, so the worker never needs the webhook's request context. Consumer: idempotency re-check on `processedAt IS NULL` before doing work.
- [ ] - T5.4 - Worker processMessage (thin version)
      Order of operations exactly: load agent (`status !== ACTIVE` → skip) → upsert Conversation → load last 10 messages → `provider.run` → save both messages with token counts → `channel.sendReply` → mark processed. Ledger is a stub returning `Infinity` here; real accounting is Phase 6 — keep the call-site in place so the phase is a wiring change, not a restructure.
- [ ] - T5.5 - Dead-letter queue + attempt limits
      Worker: `attempts: 3`, backoff on `TransientProviderError`; final failure moves to `message-jobs-dead` with the error, and flips nothing silently. Dashboard agent page shows dead-letter count.
- [ ] - T5.6 - Vertical-slice test (highest-leverage test — write it in this phase, not later)
      `processMessage` with fake provider, fake channel, in-memory store: (a) happy path replies once and records both messages; (b) redelivered `externalMessageId` replies zero additional times; (c) provider transient failure twice then succeeds → one reply; (d) provider permanent failure → dead-letter, no reply, no half-written assistant message.
- [ ] - T5.7 - setWebhook script + manual runbook
      `scripts/set-telegram-webhook.ts` (bot token + URL + secret) and a `docs/runbooks.md` section: register a real bot, send it a message, watch the structured log line.

EXIT GATE: T5.6 green; a real Telegram message gets a real Groq reply end to end on dev infra.

### Phase 6 — Token ledger & quota  → M6

- [ ] - T6.1 - Ledger implementation
      `commitUsage`: one Postgres transaction — atomic decrement of `tokenBalance` (with `WHERE tokenBalance >= n` guard) + append `UsageEvent(kind: "model_call")`. `getBalance`: fast read. Overdraft is impossible by construction: a negative balance can never be written.
- [ ] - T6.2 - Quota enforcement in the worker
      Pre-check `getBalance ≤ 0` → skip provider entirely, send `QUOTA_EXCEEDED_MESSAGE`, still mark the webhook processed (a blocked tenant must not create a retry storm).
- [ ] - T6.3 - Cycle reset (BullMQ repeatable job)
      Daily sweep: tenants where `cycleResetAt ≤ now` → set balance to `plan.tokenQuota`, roll `cycleResetAt`, write `UsageEvent(kind: "quota_reset")`. Sweep-not-per-cron rationale is in the runbook; a missed sweep self-heals the next day.
- [ ] - T6.4 - Reconciliation job
      Nightly compare `quota − Σ(model_call usage)` vs `tokenBalance`; drift beyond epsilon logs an alarm line and tags the tenant. This catches every double-decrement bug ever written.
- [ ] - T6.5 - Concurrency tests
      Parallel `commitUsage` against real Postgres (test DB): N concurrent debits on balance M never drive M negative; the loser gets the over-quota path, not a negative row.

EXIT GATE: the over-quota tenant gets the quota reply instead of an AI reply; concurrency test passes; UsageEvent sum equals balance change for a scripted day.

### Phase 7 — Sheets connector + OAuth consent  → M7

- [ ] - T7.1 - OutputConnector registry
      Same shape as providers; duplicate `type` fatal at boot.
- [ ] - T7.2 - Google OAuth consent flow
      "Connect Google" in the dashboard → OAuth (scopes: `spreadsheets`, `drive.file`) → `googleRefreshToken` stored encrypted on the User; connecting a sheet creates a `SHEETS_OUT` integration holding `{spreadsheetId, sheetName, userRef}` encrypted. Consent state param carries the tenant — verify it server-side, never trust the callback's query param alone.
- [ ] - T7.3 - GoogleSheetsConnector
      Append one row: `{ timestamp, externalChatId, user text, reply, tokens }` via the Sheets API with a service-acquired access token. Refresh-on-401 exactly once, then fail as transient (goes through `withRetry`).
- [ ] - T7.4 - Wire into processMessage
      After reply: fan out to all OUTPUT integrations of the agent; one connector failing must not undo the reply — it retries, then dead-letters with `kind: "connector_write"` context.
- [ ] - T7.5 - Sheet check helper
      On connect: read row 1, confirm header row matches the expected columns, otherwise write the header. A user pasting a random sheet ID gets a clear error, not silent column drift.

EXIT GATE: a real Telegram conversation appends real rows to a real Google sheet, including after the access token expires mid-run (refresh-once path tested with a fake).

### Phase 8 — Usage dashboard + Stripe  → M8

- [ ] - T8.1 - Usage page
      Chart + table over `UsageEvent` for the tenant (daily rollup query with the `(tenantId, createdAt)` index), broken down per agent; visible dead-letter and blocked-for-quota counts. This is the support page.
- [ ] - T8.2 - Stripe checkout + subscription webhook
      Price book per Plan; checkout session; webhook (`checkout.session.completed`, `customer.subscription.updated/deleted`) maps `price → planId` and updates `Tenant.planId` + balance. Stripe webhook verified by signature, same idempotency discipline as channels (reuse `WebhookEventLog` shape).
- [ ] - T8.3 - Plan enforcement
      Creating an integration beyond `maxIntegrations` → 402-style API error with upgrade link; `tokenQuota` flows into the cycle reset (T6.3) — verify both directions after a plan change.
- [ ] - T8.4 - Downgrade / cancel handling
      On subscription cancel: plan → Free, balance clamped to Free quota; integrations beyond limit become `status: REVOKED`, not deleted. One structured event per transition.

EXIT GATE: test-mode Stripe e2e: upgrade → quota reflects plan → cancel → clamps. Usage page numbers match the ledger sum.

### Phase 9 — More providers  → M9 (the abstraction audit)

- [ ] - T9.1 - GeminiProvider
      `generateContent` with `systemInstruction`; token counts from `usageMetadata` (promptTokenCount / candidatesTokenCount); map `finishReason` safety blocks to a clean ProviderError.
- [ ] - T9.2 - OpenAIProvider
      Same OpenAI-compatible path as Groq but distinct key/base-url and its own usage quirks (`include: true` where needed).
- [ ] - T9.3 - OllamaProvider
      `/api/chat` with `stream: false`; some Ollama models omit usage unless the prompt-format exposes it — if the response lacks counts, throw a typed `UsageUnavailableError`; the ledger refuses to bill an estimate. (Same rule as this repo's own `cli` provider experience: tool-call argument payloads differ by model family; accumulate defensively.)
- [ ] - T9.4 - Provider config UI polish
      Model select fed by a per-provider allow-list endpoint, not a hardcoded client array.

EXIT GATE: adding three adapters touched zero core files; diff is `providers/*` + registry lines + tests. If a phase-9 adapter requires a core edit, that is a design bug — stop and fix the interface.

### Phase 10 — WhatsApp channel (separate milestone)  → M10

- [ ] - T10.1 - Meta app + webhook handshake
      Verify-token challenge/response endpoint; message template categories require Meta app review — track review lead time as a calendar dependency, not a code task.
- [ ] - T10.2 - WhatsAppChannel
      `X-Hub-Signature-256` HMAC over the raw body against app secret (constant-time, before JSON parsing); `parseIncoming` for text messages with `messageId` → `externalMessageId`; 24-hour customer-service window rule handled at reply time with a clear error, not a silent drop.
- [ ] - T10.3 - Reuse everything
      Wire it into queue + worker with no core edits — this is the channel abstraction's own audit, exactly as Phase 9 is the provider audit.
- [ ] - T10.4 - Runbook + docs
      Sandbox-number test procedure; media/attachments explicitly unsupported in v1.

EXIT GATE: same fake-driven tests as T5.6, run against WhatsAppChannel; a real sandbox number replies.

---

## 9. Global definition of done

A phase is not "done" until:

- [ ] - D1 - Typecheck + lint + tests green in CI
- [ ] - D2 - The phase's EXIT GATE line verified on dev infra, not argued
- [ ] - D3 - Any new secret column went through `crypto.ts` and a test asserts ciphertext in the raw DB value
- [ ] - D4 - Any new external call goes through `withRetry` and appears in one structured log line
- [ ] - D5 - The new adapter registered without a core-logic `if` branch

---

## 10. Decisions to lock before T0.1, and known risks

**Open decisions** (ask the operator; default in bold):

| Question | Options | Default | Why |
|----------|---------|---------|-----|
| Auth library | Auth.js / better-auth / hand-rolled sessions | **better-auth** | brief said Lucia — Lucia 1.x is effectively unmaintained. better-auth is TS-native, ships org/role primitives we can use later |
| Hosting target | Railway / Render / Fly | **Railway** | Postgres + Redis add-ons, Docker, free-tier-sized |
| One Google account per tenant? | per-user / per-tenant service account | **per-user (first owner)** | matches the OAuth flow we already need for consent |
| Token pricing unit | raw tokens / normalized "credits" | **credits** | cross-provider tokenization differs; credits keep plans honest when you swap Groq↔Gemini |
| WhatsApp scope | templates + sessions / sessions only | **sessions only (v1)** | template approval is a review dependency |

**Risks worth naming now:**

- Telegram MarkdownV2 escaping — reply failures will cluster here; budget a half-day for escaping + tests, or ship plain-text first.
- Provider free-tier quotas are *account-wide* — per-tenant rate limiting (T2.4) alone doesn't stop the Groq key being exhausted across tenants; the worker queue must also have a global concurrency cap per provider.
- BigInt over JSON silently corrupts if any layer stringifies twice — T1.4 helpers + one test at the Fastify edge.
- Stripe metered billing usage reporting is slow to set up — fixed plans + our internal ledger ship first; metered overage can come later without re-architecting.
- Key rotation for `credentialsEncrypted`: handled by the `v1:<keyId>` prefix (T0.5) — without it, rotating the master key means mass-decrypt/re-encrypt with a live outage.

---

## 11. Explicitly out of scope for this build

- Multi-region, Kubernetes, service mesh.
- CRM / churn-prediction / media-buyer agent features (post-PMF).
- Plugin marketplace or public connector API.
- RBAC finer than OWNER/ADMIN/MEMBER.
- Streaming AI replies into the chat channel (Telegram can't do it cleanly anyway).
- Voice / image / attachment handling on any channel.

Keep the system small enough that one person holds the whole architecture in their head. Every module above is a handful of files, not a package empire.

---

## 12. Task index (flat checklist for tracking)

Copy-paste status tracker — details for every ID are in §8.

```
Phase 0  [ ] T0.1  [ ] T0.2  [ ] T0.3  [ ] T0.4  [ ] T0.5  [ ] T0.6
Phase 1  [ ] T1.1  [ ] T1.2  [ ] T1.3  [ ] T1.4
Phase 2  [ ] T2.1  [ ] T2.2  [ ] T2.3  [ ] T2.4  [ ] T2.5
Phase 3  [ ] T3.1  [ ] T3.2  [ ] T3.3
Phase 4  [ ] T4.1  [ ] T4.2  [ ] T4.3  [ ] T4.4
Phase 5  [ ] T5.1  [ ] T5.2  [ ] T5.3  [ ] T5.4  [ ] T5.5  [ ] T5.6  [ ] T5.7
Phase 6  [ ] T6.1  [ ] T6.2  [ ] T6.3  [ ] T6.4  [ ] T6.5
Phase 7  [ ] T7.1  [ ] T7.2  [ ] T7.3  [ ] T7.4  [ ] T7.5
Phase 8  [ ] T8.1  [ ] T8.2  [ ] T8.3  [ ] T8.4
Phase 9  [ ] T9.1  [ ] T9.2  [ ] T9.3  [ ] T9.4
Phase 10 [ ] T10.1 [ ] T10.2 [ ] T10.3 [ ] T10.4
```
