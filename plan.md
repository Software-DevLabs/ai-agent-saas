# Plan — Website support agent: knowledge, embed, sentiment, page routing, sheets

Written 2026-10-31. This is a proposal, not a start signal — nothing here is built until you say go.

## 0. What you asked for, in plain terms

| You said | What we build |
|---|---|
| "i can create a project, in project i can create agent" | Create an agent **from inside a project** (it already carries `projectId`; the form just never offered it) and see it in that project's tab |
| "for agent i give it file or write prompt" | Knowledge sources: uploaded text/markdown/csv/json/html files, pasted notes, plus the system prompt — each one chunked, embedded and searchable at answer time |
| "i can get embed code to add it in my website" | A Publish tab per project that hands you a one-line `<script>` snippet + a hosted iframe widget, with a copy button, live preview and an origin allow-list |
| "ai can gathering all info, anything question and see hows customers feel" | Every visitor question is stored with a model-classified **sentiment** + intent; the project gets a Questions feed and a sentiment-over-time panel |
| "you can provide it with url of all pages and it can route user … i ask where is page login it's directly shows me button routing" | A site crawler (root URL, same-origin, depth/page caps, robots.txt honoured) that builds a **page table** per project; a `find_page` tool answers with a validated URL and the widget renders a real **Go to page** button |
| "in project it's have status of user question and their feel" | Project → Questions tab: list, filters, sentiment chips, counts, per-day chart, click-through to the transcript |
| "ai agent can create sheets and shows us that" | A `make_sheet` tool that produces a real stored table (columns + rows) you can view in the project, export as CSV, and later push to Google Sheets |
| "take many features from mastra" | Port Mastra Studio's leaf components (see §6) and its RAG chunking / PgVector / classifier algorithms into our own packages, Apache-2.0 notices kept |

## 1. Facts this plan is built on (audited today, not assumed)

- `Agent`, `Integration`, `Workflow`, `AgentRun` have `projectId`. `Conversation`, `ConversationMessage`, `UsageEvent`, `WebhookEventLog` do **not** — that has to change for a per-project feed.
- Nothing file/document/knowledge/page/site/embed-key/sentiment/sheet-shaped exists yet. Confirmed by grep over `schema.prisma`.
- `POST /agents/:id/run` returns **one JSON object**, no SSE anywhere. Progress today is polled from `AgentRun` / `AgentRunStep` rows — a proven pattern we already ship in the Playground. The widget will use the same, so no new streaming infrastructure.
- Ollama tool-calling is real and working (`packages/providers/src/ollama.ts:109-122`, `parseToolCalls:81-92`; core loop `packages/core/src/agent-run.ts:309-355`, cap 6 steps). But `AgentTool.execute()` must return a **string**, and `AgentTurnOutcome` exposes only `reply: string` — so a structured "navigate" action needs a new typed field, not a new protocol.
- `registerRoutes(app, deps)` closes over a **boot-time** `deps.tenantId` (`routes.ts:163`); there is no auth hook, no CORS plugin, no multipart plugin, and `bodyLimit` is 1 MiB (`app.ts:26`). A public embed route is the first caller that cannot reuse this shape — it needs its own route family that resolves tenant+project+agent **server-side from a key**.
- `safeCompare` exists, is tested, and is used by nothing (`shared/src/crypto.ts:85`). Embed keys will use a sha-256 hash lookup instead (indexed, constant-time by construction), and the plaintext key is shown once and masked after — same one-way rule as credentials.
- **Bug found while planning:** `TENANT_SCOPED_MODELS` (`packages/db/src/scoped.ts:18-30`) is missing `agentRun` and `agentRunStep`, so a scoped client would throw on them today. Every new table must be added here **and** get a `packages/db/test/scoped.test.ts` case, or the "tenant isolation at query layer" claim quietly stops covering them.
- `createIntegration` ignores a client-sent project and forces the default one (`writes.ts:283`) — so "connections inside a project" is only half true today. Fix in Phase A.
- **No embedding model is installed.** `GET http://127.0.0.1:11434/api/tags` returns `{"models":[]}` (the chat model in use is account-backed cloud). Retrieval therefore ships with a keyword path that works with zero models, and the vector path is a real, visible upgrade — never a silent fake similarity.
- Mastra Studio (`resources/mastra-main/packages/playground-ui`) is **React 19 + Tailwind 4 + Base UI**. We are React 18 + Tailwind 3 + hand-rolled primitives that already speak the same oklch token names. Their `@theme`/`@utility` generated classes cannot be back-ported; their **leaf components can be translated**. Everything we touch is Apache-2.0; anything under `**/ee/**` is source-available-not-open and off-limits, and their brand marks are not licensed.

## 2. Decisions

Taken from your answers:
1. **Sheets**: in-app artifact first (stored rows, table view, CSV export), Google Sheets push as a later sink behind the same `SHEETS_OUT` type.
2. **Embed**: hosted iframe + one-line snippet as the default, an optional React package later.
3. **Retrieval**: pgvector + Ollama embeddings, with keyword search as the honest fallback when no embed model exists.
4. **Crawl**: start from one root URL, same-origin, depth/page caps — and always allow pasting an explicit URL list or an `sitemap.xml`.

Mine, say no to any:
5. **No Tailwind 4 / React 19 upgrade in this pass.** We translate the Mastra components we want onto our existing utilities. A framework migration would touch every screen and is not what you asked for.
6. **We do not depend on `@mastra/*` packages.** We port algorithms (chunkers, the PgVector DDL, the classifier-scorer prompt shape) into `packages/core` so our billing, tenant scoping and Ollama-only invariants stay in one piece. Their `domains/*` data layer is typed to `@mastra/client-js` and is reference-only.
7. **PDF/DOCX are refused with a message, not half-supported.** v1 accepts `.txt .md .csv .json .html`. Adding a real PDF extractor is its own phase with a real test.
8. **Sentiment is one billed model call per visitor message**, parsed with zod; an unparseable answer stores `unknown`. No heuristic guessing.
9. **A navigate action may only point at a URL already in that project's page table.** The model cannot invent a domain.
10. **Visitor data is minimal**: a random visitor token we issue, the messages, and the sentiment. No cookie, no fingerprint, no PII column.

## 3. Data model (one migration per phase, `prisma migrate dev`, deployed before any build that references it)

```
Site            id tenantId* projectId* baseUrl name status(NEW|CRAWLING|READY|FAILED)
                maxPages maxDepth lastCrawledAt error? createdAt updatedAt
                @@unique([projectId, baseUrl]) @@index([tenantId, status])
SitePage        id tenantId* projectId* siteId* url path title? textPreview
                headings[] wordCount statusCode status(PENDING|INDEXED|FAILED) crawledAt
                @@unique([siteId, url]) @@index([projectId, path])        <- the router's table
KnowledgeSource id tenantId* projectId* agentId? kind(FILE|PAGE|NOTE) name mime? bytes?
                sitePageId? status(READY|PENDING_EMBED|INDEXING|FAILED) error? createdAt
                @@index([tenantId, projectId, status])
KnowledgeChunk  id tenantId* sourceId* seq text tokens metadata json
                embedding Unsupported("vector(768)")?
                @@unique([sourceId, seq])
                -- migration also runs: CREATE EXTENSION IF NOT EXISTS vector;
                -- and an HNSW index on (embedding vector_cosine_ops)
Embed           id tenantId* projectId* agentId* name keyHash unique keyPreview
                allowedOrigins[] theme json welcomeMessage status(ACTIVE|PAUSED)
                lastUsedAt createdAt  -- plaintext key returned exactly once, at creation
Spreadsheet     id tenantId* projectId* agentId? runId? title columns json kind(SHEET)
                status createdAt
SpreadsheetRow  id tenantId* spreadsheetId* seq values json  @@unique([spreadsheetId, seq])
```

Alterations to existing tables:
- `Conversation`: `+ projectId`, `+ channel (CONSOLE|EMBED)`, `+ visitorTokenHash?`, `@@index([tenantId, projectId, createdAt])`.
- `ConversationMessage`: `+ sentiment (JOYFUL|NEUTRAL|FRUSTRATED|ANGRY|UNKNOWN)`, `+ intent?`, `+ topicTags text[]`, `@@index([tenantId, sentiment, createdAt])`.
- `AgentRun`: `@@index([tenantId, projectId, startedAt])` (the column exists, the index does not) and `+ embedId?` so a public turn is attributable.
- `MessageRole` untouched. New enums go in the same migration that adds them.
- Every one of these models is added to `TENANT_SCOPED_MODELS`, **and** `agentRun`/`agentRunStep` are added there as the bug fix, with tests. `WebhookEventLog` stays out (its `tenantId` is nullable by design) — that gets a comment, not a silent omission.

## 4. Backend

### 4.1 Knowledge ingest
- `packages/core/src/knowledge/chunk.ts` — port Mastra's `recursive` + `markdown` + `sentence` strategies (size/overlap from config), pure functions, unit-tested on real fixtures.
- `packages/core/src/knowledge/embed.ts` — `embedText(provider, model, texts[])` against Ollama `/api/embeddings` through our existing `ModelProvider` boundary (a new method on the interface, not an `if`); missing model ⇒ `EmbedUnavailableError`, which is what flips a source to `PENDING_EMBED`.
- `packages/core/src/knowledge/search.ts` — one entry point, two backends: `vector` (pgvector `<=>` through `$queryRaw`, tenant+project clause always in the SQL) and `keyword` (Postgres `websearch_to_tsquery` over chunk text). The backend in use is reported in the response and shown in the UI.
- Upload route uses `@fastify/multipart` with its own 8 MiB cap (the global 1 MiB stays for JSON), text decodes only, and a file that is not valid UTF-8 in an accepted mime is refused.

### 4.2 Crawler
- New queue lane `knowledge` in `PgQueue` (declared in the lane enum, worker polls it alongside `graph`), so the API never promises processing inside a request and the heartbeat contract still gates "live".
- Rules: same-origin only, `robots.txt` fetched and honoured (disallow = skip, recorded), 1 req/s, 8 s timeout, `maxDepth` ≤ 3, `maxPages` ≤ 200, HTML → text with nav/footer/script stripped, non-2xx and binary content stored as `FAILED` with the status code.
- A crawl is idempotent per `(siteId, url)`; re-crawling updates in place and re-chunks only when the text hash changed.

### 4.3 Agent tools (this is where "Mastra features" actually help)
`runAgentTurn` gains an optional `tools: AgentTool[]` from the caller (today only the graph's `subagent` exists). Three tools, each with a zod input schema, each returning a string to the model and a structured side-channel to us:
- `knowledge_search(query, k?)` → top chunks with source name + page path; every hit is written into `AgentRunStep` so the drawer can cite it.
- `find_page(hint)` → matches `SitePage` by path/title/token similarity, returns up to 3 candidates; a chosen candidate is pushed onto `outcome.actions` as `{ kind: "navigate", url, title, reason }`.
- `make_sheet(title, columns, rows)` → inserts `Spreadsheet` + rows in one transaction (capped at 500 rows / 24 columns), returns the id and pushes `{ kind: "sheet", spreadsheetId, title }` onto the outcome.
- `AgentTurnOutcome` gains `actions: AgentAction[]` (validated server-side, max 3) and `citations: {sourceId,name,path}[]`. The widget and the Playground both render from these.

### 4.4 Sentiment
- Post-turn job on the `knowledge` lane (never blocks the visitor reply): one model call with a strict-JSON prompt (port of Mastra's `classifier-scorer` shape), zod-parsed to `{sentiment, intent, topicTags}`; parse failure ⇒ `UNKNOWN` + the raw text kept for a later re-run.
- Billed as its own `UsageEvent` kind so the cost is visible rather than hidden inside the answer.

### 4.5 Public embed API — a separate route family
`apps/api/src/embed-routes.ts`, registered with its own prefix and **no** `deps.tenantId`:
- `POST /embed/:embedId/boot` → `{ welcome, theme, agentName, visitor: {token} }`; origin checked against `allowedOrigins`.
- `POST /embed/:embedId/messages` `{visitorToken, text}` → 202 `{runId}`; the turn runs through the **same** `runAgentTurn` with the embed's agent, `channel: EMBED`, quota enforced (402 ⇒ the widget shows "support is paused", which is true).
- `GET /embed/:embedId/runs/:runId` → a projection with only `status`, `reply`, `actions`, `citations`, `updatedAt`. Never tokens, cost, system prompt, or another conversation.
- `@fastify/cors` with a per-embed origin function; rate limit = Postgres counter table `EmbedRate(embedId, minuteBucket, count)` upserted atomically, per-visitor and per-embed ceilings from config. No Redis.
- Tests: a foreign `embedId` cannot read another tenant's run; a disallowed origin gets no CORS header; the rate ceiling actually 429s; the projection contains no `systemPrompt`/`tokensUsed` substring.

## 5. The widget

- `apps/web/embed/` — a second Vite entry (`embed.ts`) that is a **self-contained** ~30 kB bundle: it creates a shadow-DOM host, injects its own styles (so our Tailwind cannot leak into your site and your CSS cannot leak into us), renders launcher + panel, and talks to `/embed/*` with its own tiny fetch helper. No React Router, no TanStack Query, no app shell.
- Snippet we hand you:
  ```html
  <script async src="https://<our-host>/embed.js" data-embed="<embedId>" data-key="<publishableKey>"></script>
  ```
  plus an iframe mode (`<iframe src="https://<our-host>/w/<embedId>">`) for sites that forbid third-party scripts from touching the DOM.
- `@fastify/static` (or a small route that serves the built file) — today **nothing serves `apps/web/dist`**, so this also gives the console a real home; dev keeps using the Vite proxy.
- Script supply chain: `embed.js` is served by **us**, from our own origin, at a versioned immutable path (`/embed/v<build>/embed.js`) with a long `Cache-Control`. The Publish tab shows the `integrity="sha384-…"` hash and a `crossorigin="anonymous"` variant of the snippet for sites that want SRI, so a compromise of our build output cannot silently run on a customer page without their checksum noticing.
- The `data-key` in the snippet is a **publishable** value by design (it identifies the embed, it is not a secret — the same way a Google Analytics id is public). Nothing that must stay private is ever placed in it, and the server authorises by `embedId` + origin allow-list + rate limit, not by trusting the key alone.
- Visitor UX: message list, composer, typing state driven by run polling, **Go to page** button (`window.location.href = action.url` inside the host page — same-origin by construction), sheet cards, "was this helpful" that becomes a sentiment signal.
- Optional later: `packages/embed-react` exposing `<SupportAgent embedId key>` built on the same core.

## 6. Console UI

New project tabs (`pages/project-detail.tsx` already has a `<Tabs>` at :203 — this extends it, not rewrites it):
- **Knowledge** — file drop + note paste + page table, per-source status (`INDEXED / PENDING_EMBED / FAILED` with the real reason), which agent it is bound to, chunk counts, search backend banner.
- **Publish** — embed list per project, create → key shown once → copy snippet, origin allow-list, theme picker, live preview iframe, pause/delete.
- **Questions** — the feed: visitor, agent, time, sentiment chip, intent, first line, click → transcript drawer; filters by sentiment/agent/date; KPI row + a per-day sentiment chart.
- **Sheets** — artifact list, table view, CSV export, "push to Google Sheets" (disabled with a reason until the connector exists).
- Agent form gains: project picker (defaults to the current project), prompt field (exists), knowledge binding, and the three tools toggled on.
- Run drawer gains citations + action chips, so a public turn is inspectable from the console.

Mastra components to translate (leaf, presentational; each lands with our tokens, an Apache-2.0 `NOTICE` entry, and their brand marks stripped):
`Table` + `Pagination` + `SearchInput` + `RelativeTimestamp` + `ClampedText` + `FilterBar`/`PropertyFilter` → Questions + Knowledge lists · `Steps/process-step-list` + `StatusIndicators` → run drawer · `Message` + `Composer` + `MessageScroller` + `MarkdownRenderer` + `AttachmentCard` → Playground **and** the widget (one chat core, two shells) · `MetricsLineChart` + `MetricsCard` + `Sparkline` + `Meter` → sentiment/analytics panels · `FileDropBackdrop` → knowledge upload · `Notice` + `EmptyState` → status banners.
Explicitly not taken: `domains/*` data layer, Base UI, `ee/` anything, Connect/Nango, Inngest/Temporal, Tailwind 4.

## 7. Phases, each ending in something you can click

- **A — Project owns its things.** Fix `createIntegration` forcing the default project; project-scoped agent create; `TENANT_SCOPED_MODELS` fix + tests; `Conversation.projectId`/`channel`; serve `dist` for real. *Accept:* a connection and an agent created under project B are listed only under B, and a scoped-client test proves `agentRun` works.
- **B — Knowledge.** Chunkers + search (keyword first, vector when a model exists), upload route with multipart, notes, project Knowledge tab, `knowledge_search` tool wired into a run, citations in the drawer. *Accept:* upload a file, ask a question only answerable from it, and the console shows the chunk it used and the tokens it cost; with no embed model installed it says "keyword search" out loud instead of pretending.
- **C — Site linking + routing.** Crawler on the `knowledge` lane with robots/depth/origin caps, `SitePage` table, `find_page`, `outcome.actions`, the widget's Go-to-page button. *Accept:* give it a real site, ask "where do I log in?", get a button whose `href` is a URL that exists in our page table — and a prompt-injected `https://evil.example` is refused by validation, with a test proving it.
- **D — Public widget.** Embed CRUD + one-time key + origins, `/embed/*` route family, CORS, Postgres rate limit, `embed.ts` entry + shadow DOM + snippet/iframe, quota refusal path. *Accept:* a page on another origin with only the snippet gets a full answer, a second tenant's key cannot read the first tenant's run, and the ceiling returns 429.
- **E — Sentiment + Questions feed.** Classifier job, columns + enums + indexes, Questions tab with filters/KPIs/chart, transcript drawer. *Accept:* ask three questions in deliberately different tones through the widget and the feed labels them, with the classifier's own billed row visible; a garbage model answer stores `unknown`.
- **F — Sheets.** `make_sheet`, `Spreadsheet`/`SpreadsheetRow`, project Sheets tab, CSV export, action card in the widget. *Accept:* "make a sheet of the 5 questions you got this week with sentiment" produces a real stored table you can export, and the row count matches what the model claimed.
- **G — Google Sheets sink** (only after F, and only if you still want it): service-account credential behind `SHEETS_OUT`, real append, a test against a throwaway sheet.

## 8. Verification (one consolidated pass at the end, per your token instruction)

`pnpm typecheck` · `pnpm test` (new suites: knowledge chunk/search, scoped models incl. the fix, embed routes, crawl rules, sentiment parse, sheet tool) · `pnpm db:migrate` + `prisma migrate status` against Neon · new `scripts/verify-embed.ts` (real widget turn end-to-end through HTTP only, cross-tenant refusal, 429) · new `scripts/verify-knowledge.ts` (file → chunk → answer with citation; crawl → `find_page` → action URL present in DB) · `pnpm --filter @saas/web build` + `scripts/bundle-budget.ts` (the embed entry gets its own budget: ≤ 40 kB gz) · `scripts/shots.ts` in both themes with the four new tabs · `check-list.md` updated so every new `[x]` names what proved it.

## 9. What this will not do

No auth/login, no multi-tenant sessions, no Stripe, no Docker/deploy, no Redis, no OpenAI/Groq/Gemini, no WhatsApp, no Telegram channel adapter — unless you ask. A public widget on `localhost` is fine for building it; putting it on a real customer site needs a deployed HTTPS origin first, which is its own (small, unaddressed) step.

## 10. What I need from you before Phase B/C

1. **`ollama pull nomic-embed-text`** (≈274 MB) — without it, retrieval is keyword-only. Say the word and I will run it.
2. **Permission to run `CREATE EXTENSION vector`** on your Neon database (Neon supports it; it is additive and reversible).
3. **One real website URL** to crawl during Phase C — your own site, so the crawler is tested against something that exists rather than a fixture I invent.
4. Confirm the phase order (A→G) or tell me to lead with the widget (D) so you can see it on your site sooner.
