-- Migration 2: the workflow graph, its derived dependency index, run history,
-- and the queue columns on WebhookEventLog.
--
-- Purely additive — no DROP of a table, column or index appears below, so the
-- running console keeps working at every commit between this and migration 1.
-- The one thing to notice is the WebhookEventLog alter: `payload` is what makes
-- the row usable as a job at all (it previously carried only an idempotency
-- key and a status), and the lease columns are what let two workers coexist.
-- docs/decisions.md D7 records that this table is now inbox *and* queue.

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "WorkflowNodeKind" AS ENUM ('INBOUND', 'AGENT', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "WorkflowDependencyKind" AS ENUM ('AGENT', 'INTEGRATION');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "NodeRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "WebhookEventLog" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lane" TEXT NOT NULL DEFAULT 'graph.run',
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lockedAt" TIMESTAMP(3),
ADD COLUMN     "lockedBy" TEXT,
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "maxAttempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "runId" TEXT,
ADD COLUMN     "workflowId" TEXT;

-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "definition" JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowDependency" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "kind" "WorkflowDependencyKind" NOT NULL,
    "refId" TEXT NOT NULL,

    CONSTRAINT "WorkflowDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "workflowName" TEXT,
    "workflowVersion" INTEGER NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "triggerSource" TEXT NOT NULL,
    "externalMessageId" TEXT,
    "input" TEXT NOT NULL,
    "output" TEXT,
    "error" TEXT,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowNodeRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "kind" "WorkflowNodeKind" NOT NULL,
    "label" TEXT,
    "refId" TEXT,
    "status" "NodeRunStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "input" TEXT,
    "output" TEXT,
    "error" TEXT,
    "durationMs" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "WorkflowNodeRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Workflow_tenantId_status_idx" ON "Workflow"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Workflow_projectId_status_idx" ON "Workflow"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_projectId_name_key" ON "Workflow"("projectId", "name");

-- CreateIndex
CREATE INDEX "WorkflowDependency_tenantId_kind_refId_idx" ON "WorkflowDependency"("tenantId", "kind", "refId");

-- CreateIndex
CREATE INDEX "WorkflowDependency_refId_idx" ON "WorkflowDependency"("refId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowDependency_workflowId_kind_refId_key" ON "WorkflowDependency"("workflowId", "kind", "refId");

-- CreateIndex
CREATE INDEX "WorkflowRun_tenantId_startedAt_idx" ON "WorkflowRun"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_workflowId_startedAt_idx" ON "WorkflowRun"("workflowId", "startedAt");

-- CreateIndex
CREATE INDEX "WorkflowNodeRun_tenantId_status_idx" ON "WorkflowNodeRun"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowNodeRun_runId_nodeKey_key" ON "WorkflowNodeRun"("runId", "nodeKey");

-- CreateIndex
CREATE INDEX "WebhookEventLog_lane_status_lockedUntil_receivedAt_idx" ON "WebhookEventLog"("lane", "status", "lockedUntil", "receivedAt");

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDependency" ADD CONSTRAINT "WorkflowDependency_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowDependency" ADD CONSTRAINT "WorkflowDependency_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowNodeRun" ADD CONSTRAINT "WorkflowNodeRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowNodeRun" ADD CONSTRAINT "WorkflowNodeRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

