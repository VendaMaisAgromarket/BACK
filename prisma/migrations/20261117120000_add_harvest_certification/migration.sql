-- CreateEnum
CREATE TYPE "HarvestCertificationType" AS ENUM ('TRACEABILITY', 'RESIDUE_ANALYSIS', 'ORGANIC', 'GLOBALGAP', 'OTHER');

-- CreateEnum
CREATE TYPE "HarvestProductionUnit" AS ENUM ('KG', 'TON');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'HARVEST_CERTIFICATION_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'HARVEST_CERTIFICATION_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'HARVEST_CERTIFICATION_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'HARVEST_CERTIFICATION_REVOKED';
ALTER TYPE "NotificationType" ADD VALUE 'HARVEST_CERTIFICATION_EXPIRING';
ALTER TYPE "NotificationType" ADD VALUE 'HARVEST_CERTIFICATION_EXPIRED';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "harvestCertificationId" TEXT;

-- CreateTable
CREATE TABLE "HarvestCertification" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "harvest_season" TEXT NOT NULL,
    "crop" TEXT NOT NULL,
    "variety" TEXT,
    "plot_identifier" TEXT NOT NULL,
    "planted_area_hectares" DECIMAL(12,2) NOT NULL,
    "estimated_production" DECIMAL(14,2) NOT NULL,
    "production_unit" "HarvestProductionUnit" NOT NULL,
    "planting_date" TIMESTAMP(3) NOT NULL,
    "harvest_date" TIMESTAMP(3) NOT NULL,
    "type" "HarvestCertificationType" NOT NULL,
    "certifier_name" TEXT NOT NULL,
    "certifier_cnpj" TEXT NOT NULL,
    "certificate_number" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3) NOT NULL,
    "origin" "CertificationOrigin" NOT NULL DEFAULT 'UPLOADED',
    "status" "CertificationStatus" NOT NULL DEFAULT 'PENDING',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "review_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HarvestCertification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HarvestCertificationDocument" (
    "id" TEXT NOT NULL,
    "certification_id" TEXT NOT NULL,
    "doc_type" "CertificationDocumentType" NOT NULL DEFAULT 'CERTIFICATE',
    "s3_key" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HarvestCertificationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HarvestCertificationEvent" (
    "id" TEXT NOT NULL,
    "certification_id" TEXT NOT NULL,
    "action" "CertificationEventAction" NOT NULL,
    "from_status" "CertificationStatus",
    "to_status" "CertificationStatus" NOT NULL,
    "actor_id" TEXT,
    "document_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HarvestCertificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HarvestCertification_user_id_status_idx" ON "HarvestCertification"("user_id", "status");

-- CreateIndex
CREATE INDEX "HarvestCertification_status_created_at_idx" ON "HarvestCertification"("status", "created_at");

-- CreateIndex
CREATE INDEX "HarvestCertification_status_valid_until_idx" ON "HarvestCertification"("status", "valid_until");

-- CreateIndex
CREATE INDEX "HarvestCertificationDocument_certification_id_idx" ON "HarvestCertificationDocument"("certification_id");

-- CreateIndex
CREATE INDEX "HarvestCertificationEvent_certification_id_created_at_idx" ON "HarvestCertificationEvent"("certification_id", "created_at");

-- CreateIndex
CREATE INDEX "Product_harvestCertificationId_idx" ON "Product"("harvestCertificationId");

-- AddForeignKey
ALTER TABLE "HarvestCertification" ADD CONSTRAINT "HarvestCertification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarvestCertification" ADD CONSTRAINT "HarvestCertification_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarvestCertificationDocument" ADD CONSTRAINT "HarvestCertificationDocument_certification_id_fkey" FOREIGN KEY ("certification_id") REFERENCES "HarvestCertification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarvestCertificationDocument" ADD CONSTRAINT "HarvestCertificationDocument_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarvestCertificationEvent" ADD CONSTRAINT "HarvestCertificationEvent_certification_id_fkey" FOREIGN KEY ("certification_id") REFERENCES "HarvestCertification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarvestCertificationEvent" ADD CONSTRAINT "HarvestCertificationEvent_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HarvestCertificationEvent" ADD CONSTRAINT "HarvestCertificationEvent_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "HarvestCertificationDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_harvestCertificationId_fkey" FOREIGN KEY ("harvestCertificationId") REFERENCES "HarvestCertification"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- O mesmo certificado de safra (dono + tipo + número, sem diferenciar maiúsculas/minúsculas) não pode
-- estar aberto (PENDING ou APPROVED) duas vezes, nem sob envios simultâneos. Índice parcial e por
-- expressão: não representável no schema do Prisma (ver nota em HarvestCertification).
CREATE UNIQUE INDEX "HarvestCertification_open_certificate_unique"
  ON "HarvestCertification" ("user_id", "type", lower("certificate_number"))
  WHERE "status" IN ('PENDING', 'APPROVED');
