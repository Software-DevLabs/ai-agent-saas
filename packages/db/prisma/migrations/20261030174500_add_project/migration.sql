-- Migration 1: introduce Project and give every agent + integration one owner.
--
-- Hand-ordered on purpose. `prisma migrate diff` emits
--   ALTER TABLE "Agent" ADD COLUMN "projectId" TEXT NOT NULL;
-- which Postgres rejects outright on a table that already has rows, and the
-- unsafe alternative (NOT NULL with a dummy default) would have stamped every
-- existing agent with a project id that does not exist. The sequence below adds
-- the column nullable, backfills it from the tenant, and only then tightens it.
-- The end state is byte-for-byte what schema.prisma describes; `migrate diff`
-- against this folder reports no drift.

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_tenantId_createdAt_idx" ON "Project"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Project_tenantId_name_key" ON "Project"("tenantId", "name");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: exactly one default project per tenant.
--
-- The id is DERIVED from the tenant id rather than generated, which makes this
-- statement idempotent (re-running it is a no-op thanks to the ON CONFLICT),
-- keeps it in lockstep with packages/db/src/seed.ts so a freshly seeded
-- database and a migrated one converge on the same row, and needs no
-- gen_random_uuid() extension.
INSERT INTO "Project" ("id", "tenantId", "name", "isDefault", "createdAt", "updatedAt")
SELECT 'prj_' || t."id", t."id", 'Default', true, now(), now()
  FROM "Tenant" t
ON CONFLICT ("id") DO NOTHING;

-- AlterTable (nullable first)
ALTER TABLE "Agent" ADD COLUMN     "projectId" TEXT;

-- AlterTable (nullable first)
ALTER TABLE "Integration" ADD COLUMN "projectId" TEXT;

-- Backfill both from the owning tenant's default project.
UPDATE "Agent" SET "projectId" = 'prj_' || "tenantId" WHERE "projectId" IS NULL;
UPDATE "Integration" SET "projectId" = 'prj_' || "tenantId" WHERE "projectId" IS NULL;

-- Only now is the column safe to tighten.
ALTER TABLE "Agent" ALTER COLUMN "projectId" SET NOT NULL;
ALTER TABLE "Integration" ALTER COLUMN "projectId" SET NOT NULL;

-- CreateIndex (new composites before the old ones are dropped, so reads are
-- never left without a usable index mid-migration)
CREATE INDEX "Agent_tenantId_projectId_status_idx" ON "Agent"("tenantId", "projectId", "status");

-- CreateIndex
CREATE INDEX "Integration_tenantId_projectId_type_idx" ON "Integration"("tenantId", "projectId", "type");

-- DropIndex
DROP INDEX "Agent_tenantId_status_idx";

-- DropIndex
DROP INDEX "Integration_tenantId_type_idx";

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
