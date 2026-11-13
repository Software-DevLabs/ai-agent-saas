# Decision log

Every deviation from the original brief, with the reason. The plan
(`plan-architecture.md` §10) predicted these; this file records what was
actually decided while building.

## D1 — node:crypto AES-256-GCM instead of libsodium sealed box
**Date:** build start. **Status:** active.
Sealed boxes are asymmetric (unauthenticated sender → public key); our use is
service-encrypts/service-decrypts, where a symmetric AEAD is the right primitive.
`sodium-native` needs a native build on Windows with no guaranteed prebuilt —
the stdlib gives the same security claim (one blob, one utility, authenticated)
with zero dependencies. The `v1:<keyId>:` envelope keeps rotation possible,
which is the part teams actually lose when they "just encrypt a column".

## D2 — tenantId added to Conversation and ConversationMessage
The brief's schema makes history reads join through Agent to scope by tenant.
Denormalizing `tenantId` one level down lets the scoped client filter every
table uniformly and gives the usage pages a single-table index path. The
foreign-key to Agent still exists; this column is derived on write, never trusted from input.

## D3 — WebhookEventLog uniqueness is `@@unique([source, externalMessageId])`
Telegram and WhatsApp message ids are separate namespaces; a global unique on
the raw id would make a WhatsApp id collide with a Telegram one and silently
swallow a legitimate message. Composite is strictly safer for the same cost.

## D4 — Redis is not installed on the dev machine
BullMQ (plan §7 queue) needs a Redis the current host does not have, and there
is no Docker to conjure one. **Decision deferred to Phase 5** — options at
that point: run Redis via Memurai/WSL, use a free hosted Redis, or swap to
`pg-boss` (Postgres-backed; the Neon database is already the source of truth).
Everything built so far is queue-agnostic on purpose: the worker placeholder
and the provider layer touch neither.

## D5 — Provider is Ollama only, per operator instruction
The brief listed Groq first; the operator chose the local Ollama daemon
(`gemma4:31b-cloud` at `http://127.0.0.1:11434`) — the same one the `cli`
project uses. The registry rule (new adapter = new file, duplicate = fatal)
makes the deferred Groq/Gemini/OpenAI adapters the small diffs they were
promised to be. Verified live on 2026-10-30: chat round-trip returned
`prompt_eval_count` / `eval_count`, so usage billing has real numbers.

## D6 — Auth library: deferred with Phase 2
better-auth is the plan default (Lucia 1.x is unmaintained). Nothing in
Phases 0–3 needs sessions, so the decision is not paid for yet.

## D7 — The queue is `WebhookEventLog`, in Postgres
**Date:** workflow builder, phase A. **Status:** active. Closes D4.
No Redis on this host and no Docker to conjure one (D4), so the job queue lives
in the table that already guarantees idempotency. `pg-boss` was the other
candidate and was rejected on three counts: it keeps its own job table with its
own dedupe key, so two keys can disagree and produce a double reply; it is a
second unlisted dependency; and it relies on prepared statements plus
`LISTEN/NOTIFY`, which Neon's transaction-mode pooler does not honour. A
single-statement claim (`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)
RETURNING`) holds no session state and is pooling-safe.

The cost is that `WebhookEventLog` is now two things with opposite natures: the
append-only idempotency guard it always was, and mutable lease/attempt state.
That holds because the *identity* — `(source, externalMessageId)` — is never
re-keyed or deleted, and only the state inside a row changes. `payload` had to
be added: the table previously carried a key and a status and nothing a worker
could act on. Two guards keep the dual role honest: `pg-queue.ts` is the only
file allowed to touch the lease columns, and `lane` defaults to `inbox` — the
inert lane — so an insert that forgets to name its lane cannot silently become a
job. If the role ever rots, a dedicated `QueueJob` table is a one-file swap
behind the `Queue` interface.

## D8 — The graph is authoritative for wiring; `AgentIntegration` is legacy
**Date:** workflow builder, phase E. **Status:** active, with a follow-up.
`AgentIntegration` answers "which channels does this agent use", and
`Workflow.dependencies` answers "which rows does this graph wire". Two sources of
truth for one question is how a console starts showing a connection the runner
never uses. The graph wins: the worker reads only `definition` + the derived
dependency index. `attachIntegration` still writes `AgentIntegration` because the
agent page uses it today; the follow-up either derives it from ACTIVE graphs or
retires the table. Until then it is compat data, and nothing in the run path
consults it.

## D9 — Activation is gated on the worker's own heartbeat
**Date:** workflow builder, phase F. **Status:** active.
"Active" is a promise about a *second process*. The API cannot observe that
process, so it refuses to make the promise from its own state: `setWorkflowStatus`
reads `WorkerHeartbeat`, a row the worker upserts about itself every
`WORKER_LEASE_MS / 3`, and refuses `worker_not_running` when the youngest row is
older than `WORKER_STALE_MS`. A worker that dies stops beating and activation
goes back to being refused, on its own. The row is infrastructure, not tenant
data — no `tenantId`, so D2/D3 do not apply — and the console's toolbar reads the
same answer from `GET /worker` instead of printing a hard-coded label.
