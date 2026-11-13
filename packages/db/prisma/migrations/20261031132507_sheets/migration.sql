-- CreateTable
CREATE TABLE "Sheet" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SheetRow" (
    "id" TEXT NOT NULL,
    "sheetId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "cells" JSONB NOT NULL,

    CONSTRAINT "SheetRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Sheet_projectId_createdAt_idx" ON "Sheet"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Sheet_tenantId_createdAt_idx" ON "Sheet"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SheetRow_sheetId_rowIndex_key" ON "SheetRow"("sheetId", "rowIndex");

-- AddForeignKey
ALTER TABLE "Sheet" ADD CONSTRAINT "Sheet_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sheet" ADD CONSTRAINT "Sheet_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sheet" ADD CONSTRAINT "Sheet_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SheetRow" ADD CONSTRAINT "SheetRow_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "Sheet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
