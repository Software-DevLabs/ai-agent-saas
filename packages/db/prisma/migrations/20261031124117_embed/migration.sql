-- CreateEnum
CREATE TYPE "EmbedStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "EmbedMessageStatus" AS ENUM ('PENDING', 'RUNNING', 'ANSWERED', 'FAILED');

-- CreateTable
CREATE TABLE "Embed" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Website widget',
    "keyHash" TEXT NOT NULL,
    "keyHint" TEXT NOT NULL,
    "origins" TEXT[],
    "status" "EmbedStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Embed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmbedRate" (
    "embedId" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "tokens" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmbedRate_pkey" PRIMARY KEY ("embedId","ipHash")
);

-- CreateTable
CREATE TABLE "EmbedMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "embedId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "status" "EmbedMessageStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "agentRunId" TEXT,
    "actions" JSONB NOT NULL DEFAULT '[]',
    "citations" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "EmbedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Embed_keyHash_key" ON "Embed"("keyHash");

-- CreateIndex
CREATE INDEX "Embed_tenantId_agentId_idx" ON "Embed"("tenantId", "agentId");

-- CreateIndex
CREATE INDEX "EmbedMessage_embedId_sessionId_createdAt_idx" ON "EmbedMessage"("embedId", "sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "EmbedMessage_tenantId_createdAt_idx" ON "EmbedMessage"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "Embed" ADD CONSTRAINT "Embed_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Embed" ADD CONSTRAINT "Embed_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Embed" ADD CONSTRAINT "Embed_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmbedRate" ADD CONSTRAINT "EmbedRate_embedId_fkey" FOREIGN KEY ("embedId") REFERENCES "Embed"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmbedMessage" ADD CONSTRAINT "EmbedMessage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmbedMessage" ADD CONSTRAINT "EmbedMessage_embedId_fkey" FOREIGN KEY ("embedId") REFERENCES "Embed"("id") ON DELETE CASCADE ON UPDATE CASCADE;
