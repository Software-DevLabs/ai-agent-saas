-- CreateEnum
CREATE TYPE "AgentRunStepKind" AS ENUM ('MODEL', 'TOOL');

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "triggerSource" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "conversationId" TEXT,
    "externalChatId" TEXT,
    "input" TEXT NOT NULL,
    "output" TEXT,
    "error" TEXT,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "deadlineAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRunStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "kind" "AgentRunStepKind" NOT NULL,
    "tool" TEXT,
    "argsPreview" TEXT,
    "resultPreview" TEXT,
    "ok" BOOLEAN,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRunStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentRun_tenantId_startedAt_idx" ON "AgentRun"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentRun_tenantId_status_startedAt_idx" ON "AgentRun"("tenantId", "status", "startedAt");

-- CreateIndex
CREATE INDEX "AgentRun_agentId_startedAt_idx" ON "AgentRun"("agentId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentRunStep_runId_seq_idx" ON "AgentRunStep"("runId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRunStep_runId_seq_key" ON "AgentRunStep"("runId", "seq");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRunStep" ADD CONSTRAINT "AgentRunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
