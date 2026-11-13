-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "KnowledgeChunkEmbedding" (
    "chunkId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dim" INTEGER NOT NULL,
    "embedding" vector NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunkEmbedding_pkey" PRIMARY KEY ("chunkId","model")
);

-- CreateIndex
CREATE INDEX "KnowledgeChunkEmbedding_model_dim_idx" ON "KnowledgeChunkEmbedding"("model", "dim");

-- AddForeignKey
ALTER TABLE "KnowledgeChunkEmbedding" ADD CONSTRAINT "KnowledgeChunkEmbedding_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "KnowledgeChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
