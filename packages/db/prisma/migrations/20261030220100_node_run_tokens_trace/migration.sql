-- Migration: per-node cost and the per-call trace.
--
-- An orchestrator turn is several billed model calls inside one node, so a node
-- row needs its own token total and a per-call audit. Both are additive with
-- defaults, so existing runs read exactly as before (0 tokens, no trace) and
-- no reader has to special-case a null total.
ALTER TABLE "WorkflowNodeRun" ADD COLUMN     "tokensUsed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "trace" JSONB;
