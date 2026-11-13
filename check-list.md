# Build Verification Checklist — AI Agent Integration SaaS

A `[x]` means the behaviour exists *and* something runs it — a test, a script, or a screen
showing live rows. An unticked line with an `As built:` note is the honest version of a
sentence that is only partly true. Deliberate non-goals say so instead of hiding.

## Tech Stack
[ ] - Tech Stack - Frontend scaffold - React + Vite + TypeScript with TanStack Router/Query installed and configured
      As built: React 18 + Vite + TS + TanStack Query 5, all live. Routing is react-router 6, not TanStack Router.
[x] - Tech Stack - Backend scaffold - Node.js + TypeScript + Fastify server initialized
[ ] - Tech Stack - Queue setup - BullMQ configured on Redis for background jobs
      As built: no BullMQ, no Redis. Jobs run on a Postgres lease table (`packages/core/src/pg-queue.ts`, `FOR UPDATE SKIP LOCKED`) with a worker heartbeat row.
[x] - Tech Stack - Database setup - PostgreSQL + Prisma ORM configured with migrations
[ ] - Tech Stack - Cache/rate-limit store - Redis instance configured, separate DB index from queue
      As built: `REDIS_URL` is parsed in config and read by nothing. There is no Redis client.
[ ] - Tech Stack - Auth setup - Lucia or Auth.js configured with email/password + Google OAuth
      As built: no login and no session cookie. One tenant is resolved at process boot (`apps/api/src/session.ts`) and injected into the route scope; the browser never sends a tenant id.
[ ] - Tech Stack - Billing setup - Stripe integrated for metered billing + fixed plans
      As built: no Stripe dependency. Plans and quotas are Postgres rows; the billing page says payment wiring is deferred.
[ ] - Tech Stack - Secrets encryption utility - libsodium sealed boxes (or KMS) implemented for credentials at rest
      As built: Keyring is node:crypto AES-256-GCM with key rotation and its own test suite — not libsodium, not KMS.
[ ] - Tech Stack - Observability setup - pino structured logging + OpenTelemetry traces + Sentry error tracking configured
      As built: pino with secret redaction only. No OpenTelemetry, no Sentry.
[ ] - Tech Stack - Deployment - Dockerized app deployed to Railway/Render/Fly.io
      As built: no Dockerfile or deploy config in apps/, packages/, scripts/ or the root. Local dev against Neon only.

## Database Schema (Prisma)
[x] - Schema - Tenant model - id, name, plan relation, tokenBalance, cycleResetAt, createdAt
[ ] - Schema - User model - id, tenantId, email, role, passwordHash, googleRefreshToken (encrypted)
      As built: every column exists; nothing writes or reads `passwordHash` / `googleRefreshToken`, and no user row authenticates anything.
[x] - Schema - Plan model - id, name, monthlyPriceUsd, tokenQuota, maxIntegrations, features json
[x] - Schema - Agent model - id, tenantId, name, status, systemPrompt, modelProvider, modelName, temperature, maxOutputTokens
[x] - Schema - Integration model - id, tenantId, type, credentialsEncrypted, externalId, status
[x] - Schema - AgentIntegration model - join table linking Agent to Integration with direction INPUT/OUTPUT
[x] - Schema - Conversation model - id, agentId, externalChatId, createdAt
[x] - Schema - ConversationMessage model - role, content, inputTokens, outputTokens
[x] - Schema - UsageEvent model - tenantId, agentId, kind, tokensUsed, costUsdEstimate, metadata
[ ] - Schema - WebhookEventLog model - externalMessageId unique constraint, status tracking
      As built: status tracking yes; the unique key is composite `(source, externalMessageId)`, not `externalMessageId` alone.

## Model Provider Adapter
[x] - Model Providers - ModelProvider interface - run() returns content + inputTokens + outputTokens
[ ] - Model Providers - GroqProvider - implements ModelProvider interface — not built (Ollama-only by decision; `validateAgent` refuses an unregistered provider)
[ ] - Model Providers - GeminiProvider - implements ModelProvider interface — not built (same)
[ ] - Model Providers - OpenAIProvider - implements ModelProvider interface — not built (same)
[x] - Model Providers - OllamaProvider - implements ModelProvider interface
[x] - Model Providers - Real token usage - reads usage.* from provider's actual API response, not a local tokenizer estimate
      `prompt_eval_count` / `eval_count`; when the daemon omits them the round raises `UsageUnavailableError` rather than inventing a number.

## Output Connector Adapter
[ ] - Output Connectors - OutputConnector interface - type + write() defined
      As built: no interface — the webhook sink is inlined in `deliverSink`.
[ ] - Output Connectors - GoogleSheetsConnector - appends a row via Sheets API — not built; `SHEETS_OUT` throws `sink_not_wired`
[ ] - Output Connectors - GoogleDriveConnector - creates a file via Drive API — not built; `DRIVE_OUT` throws `sink_not_wired`
[ ] - Output Connectors - GenericWebhookConnector - POSTs JSON to an arbitrary URL
      As built: the behaviour is real and tested (POST to the decrypted URL); there is just no class named after it.

## Channel Adapter
[ ] - Channels - ChannelAdapter interface - verifyWebhook, parseIncoming, sendReply defined — exists only in the architecture doc
[ ] - Channels - TelegramChannel - bot token + sendMessage implemented — not built; the canvas inspector says outright that this build has no Telegram or WhatsApp adapter
[ ] - Channels - WhatsAppCloudChannel - Meta Cloud API implemented — not built (`WHATSAPP_IN` is an enum value and a credential form field)
[ ] - Channels - Telegram webhook signature check - secret token header verified — not built: there is no inbound webhook route to verify
[ ] - Channels - WhatsApp webhook signature check - X-Hub-Signature-256 HMAC verified — not built: same. `safeCompare` exists and is unit-tested, imported by no route.

## Token Ledger
[ ] - Billing Ledger - reserveTokens() - optimistic pre-check before model call, rejects early if balance is 0
      As built: the balance is read before the turn and a 0 balance answers 402 `quota_exhausted`. There are no reservation/hold semantics to release.
[x] - Billing Ledger - commitUsage() - atomic decrement + writes a UsageEvent
[ ] - Billing Ledger - resetCycle() - cron job resets tokenBalance to plan.tokenQuota on billing anniversary
      As built: `cycleResetAt` is only *read*, to window the usage charts. Nothing ever resets it or the balance.

## Worker (processMessage)
[ ] - Worker - processMessage() full pipeline - load agent → check balance → call provider → commit usage → save messages → write connectors → reply → mark webhook processed
      As built: balance → provider → bill → messages → sink → `queue.succeed` are all real. The reply step is the webhook sink only — there is no channel adapter.
[ ] - Worker - Agent paused check - skips processing when agent.status is not ACTIVE
      As built: only `PAUSED` is refused; an `ERROR` agent still runs.
[ ] - Worker - Quota exceeded reply - sends a quota-exceeded message when balance is 0 or less
      As built: the condition is detected (402 → a BLOCKED run, visible in Runs) but no message reaches anyone.
[x] - Worker - Conversation history load - loads last N messages for context before calling the provider
[ ] - Worker - Retry with backoff - wraps provider.run, connector.write, and channel.sendReply
      As built: provider.run is wrapped and the job itself backs off; the sink POST has no retry.
[ ] - Worker - Dead-letter queue - failed jobs after max retries routed to a DLQ and surfaced in the dashboard
      As built: the DEAD lane and the Runs failure tab are real SQL, but no test or script has ever produced a DEAD row.

## Security
[ ] - Security - Unverified webhook traffic rejected - nothing processed without a passing signature check
      As built: vacuously true — no inbound webhook endpoint exists, so nothing can arrive unverified.
[ ] - Security - Credential encryption - bot tokens, OAuth refresh tokens, API keys all encrypted at rest
      As built: every Integration credential is encrypted and never returned to the browser (tested). User-level OAuth tokens are never written at all.
[ ] - Security - Tenant isolation at query layer - every Prisma query filtered by session-derived tenantId, request-body tenantId never trusted
      As built: no body schema accepts a tenantId and every read carries the session one; the `tenantScoped` helper is used by tests only, and run-row writes key on `runId`.
[ ] - Security - Per-tenant rate limiting - implemented, not just a global rate limit — not built, in either form
[x] - Security - Log redaction - secrets and tokens redacted before any log line is written
[ ] - Security - Idempotent webhook processing - enforced via externalMessageId at the queue-enqueue step
      As built: the P2002 dedupe on `(source, externalMessageId)` is real and sits on the enqueue path; no test exercises it (every queue in the suite is a stub).

## Non-Functional
[ ] - Observability - Structured worker logs - tenantId, agentId, jobId, provider, inputTokens, outputTokens, latencyMs, status logged per run
      As built: workerId, jobId, outcome, runId, tokensUsed. Not the tenant/agent/provider/latency split.
[ ] - Scalability - Stateless worker - no per-request state cached beyond a single job's lifetime
      As built: job state is per-run, but a module-level provider capability cache (5-min TTL) survives across jobs and processes.
[x] - Reliability - Graceful provider failure - a down provider surfaces a clear error, not a silent timeout
[ ] - Testing - Unit tests for processMessage - fake ModelProvider, OutputConnector, ChannelAdapter, zero live network calls
      As built: `executeGraph` is tested against a fake runner, queue and db with `fetch` stubbed and zero network. There are no connector/adapter fakes because there are no adapters.

## Dashboard & API
[x] - Dashboard - Agent CRUD API - create, read, update, delete agents
[x] - Dashboard - Agent builder page - minimal UI to create an agent
[x] - Dashboard - Usage/billing page - reads from UsageEvent, shows current token balance
[ ] - Dashboard - Integrations page - connect Telegram bot token, Google OAuth consent flow
      As built: the Telegram bot token connects for real (encrypted, masked, revocable). There is no OAuth consent flow — Drive/Sheets take a pasted token or service-account JSON and have no connector behind them.
[ ] - Billing - Stripe subscription wiring - enforces maxIntegrations and tokenQuota per plan
      As built: both limits are enforced from the Plan row (a third integration is refused live). No Stripe.

## Console Theme & Shell
[x] - Theme - A primary button keeps its label colour - tailwind-merge did not know our type scale, so `text-body-sm` was filed as a text colour and deleted the `text-primary-foreground` in front of it. The scale is registered in `cn()` now; New agent / New project / Connect channel compute bg 0.9851 + color 0.1286 in dark and the reverse in light.
[x] - Shell - No permanent filter on the page frame - the entrance used to end on `filter: blur(0px)`, which leaves a composited layer and a containing block on every page. The rise is opacity + translate now, and a settled `main` computes `filter: none`, `transform: none`.
[x] - Shell - A route mount is not gated on an exit animation - the shell's `AnimatePresence mode="wait"` could strand an empty content area (sidebar painted, page never mounted) until a reload. Each page owns its own entrance; the shell mounts immediately.
[x] - Shell - Pass - typecheck clean, 124 tests pass, web build clean, bundle budget inside limits (initial 156.9/200 kB gz, canvas 72.2/130 kB gz), both theme screenshot passes clean.

## Agent Activity (the console's "what are the agents doing" layer)
[x] - Activity - AgentRun / AgentRunStep schema - one row per direct turn, one row per model round and tool call; migration deployed to Neon (`prisma migrate status` clean)
[x] - Activity - Observer in @saas/core - start / round / stepDone / finish / fail, wrapped best-effort so an activity write can never roll back a billed round
[x] - Activity - GET /activity - merges direct turns with AGENT/ORCHESTRATOR workflow nodes newest first, tenant-scoped, filters by agent / status / limit
[x] - Activity - GET /agent-runs and /agent-runs/:id - steps in seq order; a foreign run id answers 404 with the id and nothing else
[x] - Activity - Ledger link - every UsageEvent a turn produces carries its agentRunId, and the run's token total equals the sum of those rows (checked live)
[x] - Activity - Live while running - the run row is observable in RUNNING while the turn is still in flight (scripts/verify-activity.ts)
[x] - Activity - Console mounts - Overview live board, Runs activity / agent-runs / workflow-runs tabs, agent detail Activity tab, Playground live rounds plus last-run card, run drawer with rounds and tool calls

## Website support agent — P0 scope and serving fixes
[x] - Scope - Scoped-model completeness is enforced, not remembered - `packages/db/test/scoped.test.ts` parses `schema.prisma` and fails if any model declaring a `tenantId` column is missing from `TENANT_SCOPED_MODELS`; `agentRun`, `skill` and `agentCapability` are in the list now, `agentRunStep`/`skillVersion` stay out on purpose (no tenant column, reachable only through the parent)
[x] - Scope - The project a row is filed into is the server's decision - creating an agent or a connection honours a client-named project, validated through `requireProject`; a foreign project id is a 404 that writes nothing (`apps/api/test/scope.test.ts`)
[x] - Scope - A brand-new agent is a DRAFT - it is parked until the operator activates it, and a turn against a non-ACTIVE agent answers `agent_not_active` instead of answering (`apps/api/test/scope.test.ts`, `packages/core/test/agent-run.test.ts`)
[x] - Billing - The balance is re-read inside the transaction - a multi-round tool turn used to decrement a stale number and could end negative; now the pre-round check sees the previous round's write, and only the round that actually ran is billed (`packages/core/test/agent-run.test.ts:207`)
[x] - Serving - The API origin serves the widget - `apps/api/src/static.ts` is mounted and answers `/embed/*` from `apps/web/dist`
      As built: only the `/embed/` prefix is served, not the whole SPA — enough for one same-origin embed story. Proven live by `verify-embed.ts`: the API serves the exact versioned file the snippet names (200, 11 931 bytes). The paste-into-a-real-site step still needs a hosted origin.

## Website support agent — P1 capability system and skills
[x] - Schema - Skill / SkillVersion / AgentCapability + the limits - `Skill.status` DRAFT|PUBLISHED|ARCHIVED with a version snapshot per publish, `AgentCapability (agentId, kind, ref)` unique, `AgentRun.capability`/`capabilityHash`, `Agent.maxToolSteps`/`perTurnTokenBudget`/`dailyTokenBudget`; migration `20261031091358_skills` deployed and `prisma migrate status` reports up to date against Neon
[x] - Capabilities - One registry, one grant table - nothing about a feature is hardcoded in a prompt: skills, tools and (from P2) knowledge are rows in `AgentCapability` resolved by one assembler (`packages/core/src/capability/*`)
[x] - Skills - Versioned, and lazy - the system prompt carries the catalogue (key + name + description); the body is returned by `use_skill(key)` only when the model opens it, so ten skills cost ten lines rather than ten prompts
[x] - Skills - Validation splits structure from taste - key slug, name ≤ 64, description ≤ 1024 and a required body are errors; a 500-line body and a 200-character description are warnings, because the body is billed only when read (`packages/core/src/skills/validate.ts`, limits ported — see `docs/attribution.md`)
[x] - Capabilities - Assembly is deterministic - same grants, same `capabilityHash`; entries sorted; the budget is measured on the assembled string and an overflow is a `capability_overflow` refusal naming the offending list, never a silent truncation (27 tests in `packages/core/test/capability.test.ts`)
[x] - Capabilities - Degradation, not fiction - a grant whose `requires` is unmet resolves to UNAVAILABLE: its tool is absent from the provider request, the reason is persisted on `AgentRun.capability`, and the model is told about it under `## Not available in this turn` (tested: the tool list and the prompt are both asserted)
[x] - Capabilities - The playground and the embed path share one assembly - `assembleTurn` lives in `@saas/core` so the two surfaces cannot drift into different prompts
[x] - Console - Capabilities tab - the agent detail page shows the catalogue with state badges and reasons, skill/tool switches that write one replace-all PUT, the assembled prompt on demand, and the stored rows that are switched off at the API level (they are left alone, not deleted)
[x] - Console - Skills page - `/skills` lists drafts and published rows with live version + hash, publishes (a republish says "frozen as vN" vs "unchanged" differently), archives and deletes; built-ins are read-only
[x] - Capabilities - Proven against the live API - `scripts/verify-capability.ts` reads every one of the above back over HTTP: a DRAFT grant degrades, a publish makes it READY and derived `use_skill`, the catalogue is in the prompt while the body is not, a core-skill gap refuses `surface=public` with 409 while `console` stays 200, the run row's `capabilityHash` equals the preview's, and a granted skill cannot be deleted
      As built: clean against the live API on 2026-10-31. The local model opened the skill (one `use_skill` tool step), the recorded hash matched the preview (`db4c1759…`), and the probe that grants `http.fetch` is refused `capability_tool_unknown` — the P1-era expectation that `knowledge_search` would be unknown was retired once P2 registered it.

## Website support agent — P2 keyword knowledge
[x] - Schema - KnowledgeDoc / KnowledgeChunk, project-owned and grant-scoped - a document belongs to the agent's project, and an agent may read it only through an enabled `AgentCapability` row of kind KNOWLEDGE; `textTsv` carries a GIN index; migration `20261031103715_knowledge`
[x] - Ingest - Upload / note / reindex / delete over HTTP - one file per multipart upload on an encapsulated instance with its own 8 MiB limit, so the API-wide 1 MiB body limit is untouched (asserted: a 1.3 MB HTML upload is 201 while a 1.4 MB JSON body is 413); a PDF is refused with the accepted-format list instead of being stored empty (`apps/api/test/knowledge.test.ts`)
[x] - Ingest - Duplicate bytes are one document - the same `(projectId, sha256)` returns the existing row with `duplicate:true` and queues no second job, so a re-upload cannot fork the index
[x] - Indexing - A worker lane, not the request - `knowledge.index` writes INDEXING, then INDEXED — or FAILED with the reason before the job is retried or dead-lettered, so a stuck document is observable (`apps/worker/src/knowledge-handler.ts`)
[x] - Chunking - Deterministic, budget-bounded, format-aware - fenced code and table rows are atomic units (the test caught `fill` cutting through a fence — fixed), a heading travels into its own chunks and is never merged across headings, sentences split with abbreviation handling, and the same text chunks identically twice (`packages/core/test/knowledge.test.ts`)
[x] - Retrieval - Keyword, with no embedding model installed - Postgres `websearch_to_tsquery`/`ts_rank` over the grant scope only, with `backend: "keyword"|"none"` always reported; `knowledge_search` takes a question and a count, never a document id, because the scope is fixed at assembly time
[x] - Console - Knowledge tab - documents with status/chunks/hash, a per-document grant switch, upload with optional title, paste-a-note, re-index, delete, and a search box that names the backend that answered (`apps/web/src/components/agents/knowledge-panel.tsx`)
[x] - Knowledge - Proven against the live API - `scripts/verify-knowledge.ts` uploads a real markdown file, polls the row to INDEXED, asks a question answerable only from that file, and requires a recorded `knowledge_search` TOOL step naming the uploaded document's chunk
      As built: clean against the live API on 2026-10-31 — the only-source number (forty-two days) came back only after a recorded VECTOR `knowledge_search` step, so the answer cannot have come from model memory. Running it surfaced a real bug the fake-db tests could not see: `left(c."text", $1)` bound the length as `bigint` and every search was a 500 (`function left(text, bigint) does not exist`) until the cast became `::int` in both raw queries (`packages/core/src/knowledge/search.ts`). With P3's embeddings live, the script accepts either real backend and leaves the vector-only demand to `verify-embeddings.ts`.

## Website support agent — P3 embeddings + pgvector
[x] - Schema - An embedding side table, not a column on the chunk - `KnowledgeChunkEmbedding { chunkId, model, dim, embedding vector }` with composite PK `(chunkId, model)`: a model change adds rows instead of mixing two vector spaces, no `Unsupported("vector(768)")` on the chunk row, and no HNSW index yet (exact cosine at these row counts); pgvector enabled on Neon, migration `20261031122736_embeddings` deployed
[x] - Provider - Ollama embeddings, validated rather than trusted - `embed()` posts `/api/embed` and refuses ragged, non-finite or count-mismatched vectors before a row of the wrong dim is written; a missing model names the exact `ollama pull <model>` command; `listEmbedModels()` keeps only tags whose `/api/show` declares an `embedding` capability (`packages/providers/test/ollama.test.ts`, 22 tests across chat + embed)
[x] - Worker - Its own lane, and unmetered - `knowledge.embed` is queued only after indexing succeeds; a failure records `meta.embeddingError` and retries twice, then dead-letters with the reason on the document; no `UsageEvent` and no balance decrement, because Ollama reports no usage for embeddings and an invented number would be worse than none
[x] - Retrieval - Vector first, keyword fallback, and `backend` never lies - cosine over the side table filtered to one model + one dim with a 0.6 similarity floor so `NO_MATCHES` stays meaningful (measured on `nomic-embed-text`: an unrelated sentence scored 0.556 and cleared the old 0.3 floor as noise, a real question scored 0.90 — see the live note below); an embedder that fails degrades the turn to keyword rather than failing it, and the console's search box reports which engine answered and whether the hybrid chain ran (`packages/core/test/knowledge.test.ts`, 7 vector tests)
[x] - Console - The Knowledge tab states each document's semantic state - `vector · <model> <dim>d · N chunks` when the embed lane recorded a row, `keyword only` when it did not, the recorded error when it failed; the tab says embeddings are not metered rather than showing an invented cost
[x] - Embeddings - Proven against the live API - `scripts/verify-embeddings.ts` asks Ollama first and fails out loud with `ollama pull nomic-embed-text` when the model is absent (checked at `/api/show`, not inferred from the name); otherwise it uploads a real file, waits for the embed lane's own row, demands `backend:"vector"` on the question the keyword phase already answered, asserts an unmatchable query reports `none` with "tried vector, then keyword", and checks the usage ledger did not move
      As built: clean against the live API on 2026-10-31. `nomic-embed-text` answered 768d, the embed lane covered 1/1 chunks, the same question scored 0.901 by vector, gibberish (`zzqxv-<stamp>`) reported `backend:"none"` once the floor was raised to 0.6, and no `UsageEvent` was written. The first live run failed the floor check at 0.3 — a real quality gap, not a script bug. The keyword-answered fallback branch is still proven by unit test, not live: with the daemon up, the API always offers a vector first.

## Website support agent — P4 public widget
[x] - Contract - The public projection is a hand-written allowlist, enforced by test - `projectEmbedMessage` names the six fields a visitor may see; `apps/api/test/embed.test.ts` builds a row holding `systemPrompt`, `tokensUsed`, `tenantId`, `conversationId` and asserts none of the eight `FORBIDDEN_PROJECTION_KEYS` survive, and that a FAILED row exposes only its stored public text
[x] - Gate - The key resolves to server-owned scope; the origin allowlist is the gate - `Embed.keyHash` (sha-256) + `keyHint` only, raw key returned once at create/rotate; tenant/project/agent/origins read from the row, never the body (`tenantId: "tnt_evil"` in a test body is ignored). A denied origin leaves with **no** `access-control-allow-origin` — the first test run caught the gate setting the header before checking the list, and the fix sets it only after the allowlist says yes; a missing Origin is refused too
[x] - Turn - Queued on `embed.turn`, answered by the worker, polled by the widget - API writes `EmbedMessage` PENDING and returns 202 + id; `apps/worker/src/embed-handler.ts` assembles with `publicSurface: true` (a DRAFT agent or unavailable core skill refuses before billing), runs the same `runAgentTurn` as the console with `requireActive`, records ANSWERED/FAILED plus actions/citations, retries only `provider_failed`, and writes visitor-safe error text while the true error stays on the run and queue rows
[x] - Continuity - One visitor session, one thread, no cookie - `externalChatId = embed:<embedId>:<sessionId>` from a `sessionStorage` token; the poll route requires the same session token, so guessing a message id reads nothing; a duplicate delivery of an ANSWERED message is `skipped`, not answered twice
[x] - Rate limit - Postgres token bucket, refusals are rows - one upsert refills-and-spends under a row lock; a refusal increments `rejected` without moving the timestamp; tests assert the bucket allows exactly capacity, then every refusal is counted (`rejected` === observed 429s) and that a 429 writes no message row; the console reads the same numbers back
[x] - Widget - Its own bundle, shadow DOM, 4.3 kB gz - `apps/web/embed/embed.ts` + `embed.css?inline`, built by `vite.embed.config.ts` into a content-addressed `v<hash8>/embed.js` + `manifest.json`; own DOM-building renderer (no innerHTML, links limited to http(s)), real PENDING/RUNNING status drives the typing indicator, action buttons and source lines; `scripts/bundle-budget.ts` now fails under 40 kB gz (entry 158.6 / 200, canvas 71.3 / 130, embed 4.3 / 40)
[x] - Console - Embed tab: create, origins, pause, rotate, delete, rates - the snippet is shown exactly once (create or rotate) because only the hash is stored; the tab warns when the bundle is not built or the agent is not active, and the rates panel shows each visitor bucket's tokens and refused count
[x] - Widget - Proven live, from a stranger's origin - `scripts/verify-embed.ts` creates a widget over HTTP, fetches the versioned bundle the snippet names, asserts an allowed origin reads config with its own ACAO and a foreign one gets 403 with no ACAO, asks two real questions on the worker's lane and polls both to ANSWERED, asserts one conversation (`embed:<id>:<session>`) with four messages, then drains the bucket and compares the 429s it saw with `/embeds/:id/rates`
      As built: clean against the live API on 2026-10-31 — allowed origin 200 with its own `access-control-allow-origin`, foreign origin 403 with none, one thread with four messages, and 4 observed 429s matched by 4 recorded refusals. Loading the pasted snippet in a real third-party page is still unverified until an HTTPS origin is hosted (plan §6) — locally the API, projection, CORS headers and served bundle are what is proven.

## Website support agent — P5 crawl + page routing
[x] - Schema - One site per agent, its pages in a child table - `Site { agentId @unique, rootUrl, host, manualUrls[], status PENDING|CRAWLING|READY|FAILED, error, pageCount, crawledAt }` + `SitePage { siteId, url, path, title, summary, intent }` with `@@unique([siteId, url])`; `CapabilityKind` gains `SITE`; migration `20261031130021_site` deployed and applied to Neon
[x] - Guard - SSRF is judged on the address actually dialled - `parseHttpUrl` accepts http(s) only (no credentials, hash stripped) and `resolveAddresses` classifies every resolved address (loopback, RFC-1918, link-local, CGNAT, benchmarking, multicast, unspecified, IPv6 equivalents); the vetted address is then pinned through a custom `lookup`, so a second DNS answer cannot swap in a private IP between the check and the connect (`packages/core/src/site/fetch.ts`, `packages/core/test/site.test.ts`)
[x] - Guard - Redirects and size are bounded, and private crawling is opt-in - every hop re-enters the guard (`MAX_REDIRECTS = 4`), the body is capped at 2 MiB while streaming, a non-HTML response is not parsed as a page, and `SITE_ALLOW_PRIVATE_IPS=1` is the only way to crawl a loopback address (used locally by the verifier, default 0)
[x] - Crawl - robots.txt is obeyed, and a rule's scope is the path it matched - `User-agent`/`Allow`/`Disallow` with `*` and `$`; the longest matched **path span** wins and an equally long `Allow` wins ties. Writing the test caught the naive version comparing pattern *text* length, so `Disallow: /*.pdf$` lost to a longer `Allow: /secret/public` and a disallowed PDF was fetched — fixed in `packages/core/src/site/robots.ts`
[x] - Crawl - Same host, breadth-first, depth and page caps, no duplicate fetches - links are enqueued only below `maxDepth` and only on the site's host; `maxPages` (25) stops the walk; visited URLs are normalised (host lower-cased, default port removed, trailing slash) before the seen-set; a non-200 root throws rather than yielding an empty site, and pages skipped by robots are absent rather than silently blank (`packages/core/test/site.test.ts` — `/secret` is skipped, `evil.example` is never fetched)
[x] - Routing - find_page can only offer a page that was actually crawled - the tool is derived from a READY site with pages, never a separate toggle; it scores title ×4 / intent ×3 / path ×3 (cap 2) / summary ×1 (cap 2) with a floor of 3, and a `url` argument is verified against `SitePage` **and** the site host before an `AgentAction { kind:"goto" }` is recorded — an off-host or uncrawled URL throws `PAGE_NOT_FOUND`, leaving the run step `ok:false` with no action emitted (`packages/core/src/site/tools.ts`; the test drives `https://evil.example` and `/admin` and asserts nothing is recorded)
[x] - Routing - The site reaches the prompt as a scope, not as text the caller can widen - `assembleTurn` drops any `ToolContext.site` the caller supplies and re-derives it from the READY site grant; the prompt gains `## Pages you can send people to`, the snapshot gains `sites[]`, and `capabilityHash` covers it (`packages/core/test/site.test.ts` asserts the caller-supplied evil scope is ignored)
[x] - Save - A save is refused mid-crawl, and a host change cannot leave a routable stale URL - `PUT /agents/:id/site` normalises the root and up to 50 manual URLs (same host, deduped), 409 `site_crawling` while a crawl is running, and on a host change it deletes every old page and zeroes `pageCount`/`crawledAt` in one transaction before marking PENDING; saving grants `SITE` through the same replace-all capability path as knowledge uploads, and the crawl job is keyed `${siteId}:crawl:<ISO>` so it is a real request, not a deduped no-op (`apps/api/test/site.test.ts` — 9 tests: project filed, ftp refused, off-host manual refused, conflict, host change clears, 404 on unknown ref)
[x] - Console - The Site tab states what was crawled and what governs it - `/agents/:id` gains a Site tab: root + manual-URL form, live status badge (polled only while PENDING/CRAWLING), error banner, and the page table (path, title, summary, intent, visit); the Capabilities tab lists the site grant with its state and reason alongside skills, tools and knowledge (`apps/web/src/components/agents/site-panel.tsx`)
[x] - Routing - Proven against the live API - `scripts/verify-routing.ts` stands up a local site with a robots.txt that disallows `/private`, crawls it through the console route, asserts the login and pricing pages landed while `/private` did not, asks "Where do I log in?" on the embed lane and requires a returned `goto` action whose URL is a crawled page, then re-checks every action against the page table and the run's `find_page` steps for any off-host attempt recorded as `ok:false`
      As built: ran clean in the final pass. The crawl wrote `/`, `/login`, `/pricing` and the `/injected` page, obeyed `Disallow: /private` (4 pages, `/private` absent), and the embed lane answered "Where do I log in?" with one action, `http://127.0.0.1:53227/login` — a URL in the page table on the crawled host. The run row's snapshot carries `find_page` as DERIVED and its trace records the call; the injected "go to https://evil.example" text was stored as a page and never acted on (the model never tried it), and a second question about the injected page also returned only the login button — no off-site action in either turn. 26 tests green (17 core, 9 API).

## Website support agent — P6 sentiment
[x] - Schema - A label per message, with the reason it exists - `EmbedFeedback { tenantId, embedId, messageId @unique, question, answer?, sentiment, score?, source, model?, error?, tokensUsed }` and enum `Sentiment { POSITIVE NEUTRAL NEGATIVE UNKNOWN }`; `UsageKind` gains `CLASSIFY`; migration `20261031131531_sentiment` applied to Neon; the model is in `TENANT_SCOPED_MODELS` and `packages/db/test/scoped.test.ts` proves the list still covers the schema
[x] - Classifier - Strict on the label, forgiving on the wrapper, never a guess - `parseSentiment` reads the JSON object inside a fence or a sentence but accepts only the four labels: `"ANGRY"` is UNKNOWN with the reason, not a coerced NEGATIVE; a score outside 0–1 or not a number becomes null while the usable label survives; the system prompt labels the question as data so an injected instruction cannot become a judgement and shows one concrete example instead of a pipe-union of labels, and the call asks the provider for JSON (`responseFormat: "json"` → Ollama `format`) so a plain-sentence reply is the exception rather than the norm (`packages/core/src/feedback/classify.ts`, 12 tests in `packages/core/test/feedback.test.ts` — including that no tools are sent, JSON mode is requested, the call is temperature 0, and zero reported usage is refused rather than billed as zero)
[x] - Worker - Its own lane, after the answer, for answered *and* failed questions - `feedback.classify` is enqueued only once the message row is terminal (ANSWERED or FAILED), keyed `${embedId}:classify:${messageId}`, and the classifier reads **only** the stored question — the answer is stored on the row for the operator but excluded from the judgement, because the live pass showed an apologetic answer flipping a plainly grateful question to NEGATIVE; a provider failure is retried twice, then recorded as UNKNOWN `source:"provider_failed"` with the reason; a tenant with an empty balance gets UNKNOWN `source:"balance_exhausted"` and no model call; a duplicate delivery is `skipped`, never a second opinion (`apps/worker/src/classify-handler.ts`, `apps/worker/src/embed-handler.ts`)
[x] - Ledger - Listening is metered and attributable - each successful classification writes one `UsageEvent { kind: "CLASSIFY", tokensUsed }` in the same transaction as the feedback row and the balance decrement, with `embedId`/`messageId`/`sentiment`/`source` in its metadata; an unparseable reply still bills the call it cost; the Usage page lists the new kind as `sentiment classify`
[x] - Console - Project Insights tab - `/projects/:id/insights` and `/embeds/:id/insights` return the four counts plus the last 20 rows; the `sentiment` filter narrows the list but never the counters (asserted); rows whose `source` is not `model` render as “not classified” with the reason instead of a feeling badge, and the footer states that one CLASSIFY ledger row per question is what listening costs (`apps/web/src/components/projects/insights-panel.tsx`; 6 API tests in `apps/api/test/feedback.test.ts` cover project scope, foreign-project 404, filter-vs-totals, empty project and validation)
[x] - Sentiment - Proven against the live API - `scripts/verify-sentiment.ts` asks two questions through a fresh widget — one plainly grateful, one plainly fed up — waits for the answer lane and then the classifier's own rows, and asserts exactly one `EmbedFeedback` row per message whose `source` is `model` with a named model and positive tokens; the grateful question must read POSITIVE and the frustrated one NEGATIVE, the project and widget views must count the rows in the session tenant, the POSITIVE filter must leave the totals untouched, and the ledger must hold one CLASSIFY row per judged question carrying the same label
      As built: ran clean in the final pass — the grateful question read POSITIVE and the frustrated one NEGATIVE (`llama3.2:3b`), the counts read `{"POSITIVE":1,"NEUTRAL":0,"NEGATIVE":1,"UNKNOWN":0,"total":2}`, filtering to POSITIVE narrowed the list to one row without moving the counters, and the ledger held 2 CLASSIFY rows for 2 judged questions. The live run earned its keep twice: the first pass produced no parsable label at all (prose instead of JSON, fixed with provider JSON mode) and the second labelled the grateful question NEGATIVE with score 0.8 because the agent's apologetic answer was in the classifier input (fixed by judging the question alone). Both were product changes, recorded above; the 12 core tests cover the deterministic parts (parse, UNKNOWN on unreadable output, retry and ledger semantics), and the script is where the model's actual judgement is observed.

## Website support agent — P7 in-app sheets
[x] - Schema - A table an agent made is rows, not a blob - `Sheet { tenantId, projectId, agentId, title, columns Json, rowCount, createdAt }` + `SheetRow { sheetId, rowIndex, cells Json }` with `@@unique([sheetId, rowIndex])`; `rowCount` is written from the insert in the same transaction; migration `20261031132507_sheets` applied to Neon; `sheet` is in `TENANT_SCOPED_MODELS` (the `sheetRow` child stays out, like `agentRunStep`) and `packages/db/test/scoped.test.ts` still proves the list covers the schema
[x] - Tool - make_sheet refuses rather than truncates - registered in the capability registry with effect `write` and no world requirement, so it is available exactly when the operator grants it; every header and cell is re-validated before the transaction opens — 1–24 distinct headers (≤ 80 chars), ≤ 500 rows, every row exactly as wide as the header, cells only text/finite number/boolean/null and ≤ 2000 chars; a refusal names the row or column and stores **nothing** (`packages/core/src/sheets/tools.ts`; 11 tests in `packages/core/test/sheets.test.ts`, including 501 rows, 25 columns, a ragged row, duplicate headers, an object cell, an oversized cell and a missing agent)
[x] - Tool - The count in the reply is the count in the database - the tool creates the sheet, inserts the rows, writes `rowCount` from `createMany().count` and replies with that number, so the accepted property (claimed count = stored rows = `rowCount`) is a fact about the write rather than the model's arithmetic; the sheet is filed under the agent's own project, resolved from the agent row and never from a caller-supplied scope
[x] - API - Sheets are read-only over HTTP - `GET /projects/:id/sheets` (project guard, newest first, capped at 50) and `GET /sheets/:id` (tenant-scoped, rows by `rowIndex`, take = the 500 write cap so a read can never show fewer rows than were stored); JSON cells narrow to primitives and anything else renders empty rather than “[object Object]”; a foreign sheet or project is a 404 (`apps/api/test/sheets.test.ts`, 6 tests — including `rowCount === rows.length`)
[x] - Console - The Sheets tab renders the stored table and exports it - `/projects/:id` gains a Sheets tab: newest-first list with agent name and stored count, a real table with a row-number column, and Export CSV built from the rows on screen; leading `= + - @` cells are prefixed with `'` so a model-written formula exports as text, and a UTF-8 BOM keeps Excel from mangling the file (`apps/web/src/components/projects/sheets-panel.tsx`)
[x] - Grant - Nothing else changed to make it available - `make_sheet` appears in `toolKeys()`, so the Capabilities tab's tool list, the grant PUT validation and the skill editor's legal tool names all pick it up without a second list; the registry comment that said it “joins in its own phase” now records that it joined

## Website support agent — P8 Google Sheets sink
[x] - Schema - The push leaves a state, not a blank - `Sheet` gains `exportedAt`, `externalSpreadsheetId`, `externalSheetName`, `externalUrl` and `exportError`; migration `20261031132958_sheet_export` applied to Neon; the in-app rows remain the source of truth — a push copies them and never edits or deletes them
[x] - Credential - The OAuth secret is a stored integration, not a query argument - the connection is an existing `Integration` row of type `SHEETS_OUT` whose Keyring-encrypted blob must hold `{clientId, clientSecret, refreshToken}`; a blob that decrypts to anything else is a 422 `sheets_credential_invalid` with zero outbound calls, and the plaintext never reaches the API response or the browser — the console form and its masked preview come from the same channel path as every other connection
[x] - Request - The network target cannot be steered by the caller - the token exchange is always `https://oauth2.googleapis.com/token` and the append is always `https://sheets.googleapis.com/v4/spreadsheets/<id>/values/<range>:append`; the only caller-controlled path segment is the spreadsheet id (regex-limited, or extracted from a pasted `/spreadsheets/d/<id>` URL), the A1 tab name is length-bounded, control-character-checked and single-quote-escaped (so `Q3 '26` becomes `'Q3 ''26'`), and every call is aborted at 10 s
[x] - Append - A partial append is a failure, not a success - `valueInputOption=RAW` with `insertDataOption=INSERT_ROWS` sends header + rows as strings (null cells as empty); an append whose `updatedRows` differs from the values sent throws naming the rows appended, and Google's own error text is what gets recorded; Google's 403/`invalid_grant` are both proven to land in `exportError` (`apps/api/test/sheet-export.test.ts`, 11 tests — happy path incl. URL-decoded quoted range and bearer header, connection-spreadsheet fallback, 403, partial append, token failure with append never called, no/ambiguous connection, explicit connection choice, plain-string credential with zero fetches, bad target, foreign sheet before any fetch, other-project connection ignored)
[x] - State - Failure and never-sent are different states - a preflight refusal (no connection, ambiguous connection, unreadable credential, bad spreadsheet/tab) throws without touching the row; only a started Google call writes `exportError`, and only a full success writes `exportedAt` and clears the error — so the badge can say “never pushed” versus “push failed, here is why” (`apps/api/test/sheets.test.ts` now 8 tests, including the export-state mapping served by `GET /sheets/:id`)
[x] - Console - The push is an explicit per-sheet action - each sheet's card carries the connection picker (only when more than one CONNECTED `SHEETS_OUT` exists), spreadsheet and tab inputs, an “Append header + N row(s)” button with busy/error/success text, and the last push's time plus an Open link or the stored error; success updates the cached sheet without a reload (`apps/web/src/components/projects/sheets-panel.tsx`, `POST /sheets/:id/export`)
[x] - Limit - Google itself is not reached in this environment - there is no live OAuth client or spreadsheet here, so the connector is proven against a scripted stand-in of Google's token and append endpoints; the real-credential step is unverified until a tenant connects its own Sheets account

## Scope Guard (confirm these were NOT built prematurely)
[x] - Scope - No Kubernetes or service mesh introduced
[x] - Scope - No CRM / churn-prediction / media-buyer features built yet
[x] - Scope - No plugin marketplace or public connector API built yet
[x] - Scope - No RBAC beyond OWNER / ADMIN / MEMBER
