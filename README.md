# ai-agent-saas

Multi-tenant SaaS: chat channel → pluggable AI provider → output connectors, metered by a token ledger.
Build phases and architecture: see [`docs/plan-architecture.md`](./plan-architecture.md) (in repo root copy) / `plan-architecture.md`.
Decision deviations: [`docs/decisions.md`](./docs/decisions.md).

## Current state (2026-10-30)

Phases 0, 1, 3 complete — M0, M1, M3 exit gates verified live:

- pnpm monorepo: `apps/{api,worker}` + `packages/{shared,db,providers}`
- Postgres: Neon (`ep-small-rice-b4djyxxr`), migration `init` applied, seeded Free/Pro plans + demo tenant
- Provider: **Ollama** (`gemma4:31b-cloud` @ `127.0.0.1:11434`) — live smoke returns real usage counts
- Credentials at rest: AES-256-GCM `v1:<keyId>` blobs via one `Keyring` (`.env` holds the key; never commit it)
- Registry rule: duplicate provider name = fatal at boot
- Console UI: `apps/web` — Vite + React + Tailwind, calm light/dark tokens, all nine pages over a typed query layer
- Tests: 40/40 (`pnpm test`), typecheck clean (`pnpm typecheck` covers server **and** web)

Console data note: every page except the health pill reads fixtures in
`apps/web/src/lib/fixtures.ts`, because the REST routes are Phase 4. Run the
console against the real API with `VITE_API_LIVE=1 pnpm dev:web` once those
routes exist — the query keys and response types are already the intended
contract (`/agents`, `/integrations`, `/usage`, `/webhook-events`, `/tenant`).

Not yet: auth (Phase 2), agent CRUD (Phase 4), queue/worker Telegram slice (Phase 5 — **blocked on Redis**, see decisions D4).

## Run

```
pnpm install
pnpm dev:api      # Fastify on :3000 → GET /healthz
pnpm dev:web      # console on :5173, proxies /api → :3000
pnpm dev:worker   # idle until Phase 5 wires the queue
pnpm test
pnpm typecheck
```

`pnpm --filter @saas/web build` produces the static bundle in `apps/web/dist`.

Requires `.env` (copy `.env.example`, generate keys: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
