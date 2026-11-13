-- Migration 3: the lane default from migration 2 was backwards.
--
-- Defaulting every new row to 'graph.run' means an insert that does not name
-- its lane — which is every insert that exists today — silently declares itself
-- a job, and a worker would claim it and look for a graph that is not there.
-- 'inbox' is the inert lane: a row stays a console display row until a producer
-- opts it into the queue explicitly.

ALTER TABLE "WebhookEventLog" ALTER COLUMN "lane" SET DEFAULT 'inbox';

-- The rows already written all came from the console run path, which has no
-- workflow and no run behind any of them. They are not jobs.
UPDATE "WebhookEventLog"
   SET "lane" = 'inbox'
 WHERE "workflowId" IS NULL
   AND "runId" IS NULL;
