-- AlterTable
ALTER TABLE "WebhookEventLog" ADD COLUMN     "tenantId" TEXT;

-- CreateIndex
CREATE INDEX "WebhookEventLog_tenantId_receivedAt_idx" ON "WebhookEventLog"("tenantId", "receivedAt");
