-- CreateEnum
CREATE TYPE "KnowledgeKind" AS ENUM ('FILE', 'PAGE', 'NOTE');

-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('PENDING', 'INDEXING', 'INDEXED', 'FAILED');

-- CreateTable
CREATE TABLE "KnowledgeDoc" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "projectId" TEXT,
    "sourceId" TEXT,
    "kind" "KnowledgeKind" NOT NULL,
    "title" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "byteSize" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT NOT NULL,
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "textTsv" tsvector,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeDoc_tenantId_status_idx" ON "KnowledgeDoc"("tenantId", "status");

-- CreateIndex
CREATE INDEX "KnowledgeDoc_tenantId_projectId_sha256_idx" ON "KnowledgeDoc"("tenantId", "projectId", "sha256");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_tenantId_idx" ON "KnowledgeChunk"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_docId_seq_key" ON "KnowledgeChunk"("docId", "seq");

-- AddForeignKey
ALTER TABLE "KnowledgeDoc" ADD CONSTRAINT "KnowledgeDoc_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDoc" ADD CONSTRAINT "KnowledgeDoc_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_docId_fkey" FOREIGN KEY ("docId") REFERENCES "KnowledgeDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Full-text index. Hand-written because the Prisma datamodel cannot name an
-- access method, and a B-tree over a tsvector is not something Postgres will
-- build: the search in `packages/core/src/knowledge/search.ts` matches this
-- column with `@@`, which is exactly what a GIN index serves.
CREATE INDEX "KnowledgeChunk_textTsv_gin" ON "KnowledgeChunk" USING GIN ("textTsv");
