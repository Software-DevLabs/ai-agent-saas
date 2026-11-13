-- AlterTable
ALTER TABLE "Sheet" ADD COLUMN     "exportError" TEXT,
ADD COLUMN     "exportedAt" TIMESTAMP(3),
ADD COLUMN     "externalSheetName" TEXT,
ADD COLUMN     "externalSpreadsheetId" TEXT,
ADD COLUMN     "externalUrl" TEXT;
