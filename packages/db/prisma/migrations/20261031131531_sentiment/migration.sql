-- CreateEnum
CREATE TYPE "Sentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE', 'UNKNOWN');

-- AlterEnum
ALTER TYPE "UsageKind" ADD VALUE 'CLASSIFY';

-- CreateTable
CREATE TABLE "EmbedFeedback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "embedId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "sentiment" "Sentiment" NOT NULL DEFAULT 'UNKNOWN',
    "score" DOUBLE PRECISION,
    "source" TEXT NOT NULL,
    "model" TEXT,
    "error" TEXT,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmbedFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmbedFeedback_messageId_key" ON "EmbedFeedback"("messageId");

-- CreateIndex
CREATE INDEX "EmbedFeedback_embedId_createdAt_idx" ON "EmbedFeedback"("embedId", "createdAt");

-- CreateIndex
CREATE INDEX "EmbedFeedback_tenantId_createdAt_idx" ON "EmbedFeedback"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "EmbedFeedback_tenantId_sentiment_idx" ON "EmbedFeedback"("tenantId", "sentiment");

-- AddForeignKey
ALTER TABLE "EmbedFeedback" ADD CONSTRAINT "EmbedFeedback_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmbedFeedback" ADD CONSTRAINT "EmbedFeedback_embedId_fkey" FOREIGN KEY ("embedId") REFERENCES "Embed"("id") ON DELETE CASCADE ON UPDATE CASCADE;
