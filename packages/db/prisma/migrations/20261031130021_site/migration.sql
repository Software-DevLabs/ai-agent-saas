-- CreateEnum
CREATE TYPE "SiteStatus" AS ENUM ('PENDING', 'CRAWLING', 'READY', 'FAILED');

-- AlterEnum
ALTER TYPE "CapabilityKind" ADD VALUE 'SITE';

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "rootUrl" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "manualUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "SiteStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "crawledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SitePage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "intent" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "SitePage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Site_agentId_key" ON "Site"("agentId");

-- CreateIndex
CREATE INDEX "Site_tenantId_status_idx" ON "Site"("tenantId", "status");

-- CreateIndex
CREATE INDEX "SitePage_tenantId_siteId_idx" ON "SitePage"("tenantId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "SitePage_siteId_url_key" ON "SitePage"("siteId", "url");

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SitePage" ADD CONSTRAINT "SitePage_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
