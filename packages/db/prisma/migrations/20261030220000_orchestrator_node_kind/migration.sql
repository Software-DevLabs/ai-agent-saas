-- Migration: the ORCHESTRATOR node kind.
--
-- Kept alone in its own migration because Postgres cannot use a new enum value
-- in the same transaction that added it. The columns that carry `ORCHESTRATOR`
-- rows ship in the next migration, which deploys after this one.
ALTER TYPE "WorkflowNodeKind" ADD VALUE 'ORCHESTRATOR';
