-- CreateEnum
CREATE TYPE "CapabilityKind" AS ENUM ('SKILL', 'TOOL', 'KNOWLEDGE');

-- CreateEnum
CREATE TYPE "SkillStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "dailyTokenBudget" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "maxToolSteps" INTEGER NOT NULL DEFAULT 6,
ADD COLUMN     "perTurnTokenBudget" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "capability" JSONB,
ADD COLUMN     "capabilityHash" TEXT;

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "requires" JSONB NOT NULL DEFAULT '[]',
    "tools" JSONB NOT NULL DEFAULT '[]',
    "core" BOOLEAN NOT NULL DEFAULT false,
    "status" "SkillStatus" NOT NULL DEFAULT 'DRAFT',
    "activeVersionId" TEXT,
    "latestVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillVersion" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "instructions" TEXT NOT NULL,
    "requires" JSONB NOT NULL DEFAULT '[]',
    "tools" JSONB NOT NULL DEFAULT '[]',
    "hash" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCapability" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" "CapabilityKind" NOT NULL,
    "ref" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCapability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Skill_tenantId_status_idx" ON "Skill"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_tenantId_key_key" ON "Skill"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "SkillVersion_skillId_versionNumber_key" ON "SkillVersion"("skillId", "versionNumber");

-- CreateIndex
CREATE INDEX "AgentCapability_tenantId_kind_ref_idx" ON "AgentCapability"("tenantId", "kind", "ref");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCapability_agentId_kind_ref_key" ON "AgentCapability"("agentId", "kind", "ref");

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillVersion" ADD CONSTRAINT "SkillVersion_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCapability" ADD CONSTRAINT "AgentCapability_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCapability" ADD CONSTRAINT "AgentCapability_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
