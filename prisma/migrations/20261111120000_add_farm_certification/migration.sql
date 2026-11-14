-- CreateEnum
CREATE TYPE "FarmCertificationType" AS ENUM ('ORGANIC_SISORG', 'GLOBALGAP', 'RAINFOREST_ALLIANCE', 'FAIR_TRADE', 'OTHER');

-- CreateEnum
CREATE TYPE "CertificationOrigin" AS ENUM ('UPLOADED', 'PURCHASED');

-- CreateEnum
CREATE TYPE "CertificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "CertificationDocumentType" AS ENUM ('CERTIFICATE', 'AUDIT_REPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "CertificationEventAction" AS ENUM ('SUBMITTED', 'RESUBMITTED', 'APPROVED', 'REJECTED', 'REVOKED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'FARM_CERTIFICATION_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'FARM_CERTIFICATION_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'FARM_CERTIFICATION_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'FARM_CERTIFICATION_REVOKED';
ALTER TYPE "NotificationType" ADD VALUE 'FARM_CERTIFICATION_EXPIRING';
ALTER TYPE "NotificationType" ADD VALUE 'FARM_CERTIFICATION_EXPIRED';

-- CreateTable
CREATE TABLE "FarmCertification" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "farm_name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "uf" VARCHAR(2) NOT NULL,
    "ccir" TEXT,
    "car" TEXT,
    "area_hectares" DECIMAL(12,2) NOT NULL,
    "type" "FarmCertificationType" NOT NULL,
    "certifier_name" TEXT NOT NULL,
    "certifier_cnpj" TEXT NOT NULL,
    "certificate_number" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "valid_until" TIMESTAMP(3) NOT NULL,
    "origin" "CertificationOrigin" NOT NULL DEFAULT 'UPLOADED',
    "status" "CertificationStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "review_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FarmCertification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FarmCertificationDocument" (
    "id" TEXT NOT NULL,
    "certification_id" TEXT NOT NULL,
    "doc_type" "CertificationDocumentType" NOT NULL DEFAULT 'CERTIFICATE',
    "s3_key" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FarmCertificationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FarmCertificationEvent" (
    "id" TEXT NOT NULL,
    "certification_id" TEXT NOT NULL,
    "action" "CertificationEventAction" NOT NULL,
    "from_status" "CertificationStatus",
    "to_status" "CertificationStatus" NOT NULL,
    "actor_id" TEXT,
    "document_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FarmCertificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FarmCertification_user_id_status_idx" ON "FarmCertification"("user_id", "status");

-- CreateIndex
CREATE INDEX "FarmCertification_status_created_at_idx" ON "FarmCertification"("status", "created_at");

-- CreateIndex
CREATE INDEX "FarmCertification_status_valid_until_idx" ON "FarmCertification"("status", "valid_until");

-- CreateIndex
CREATE INDEX "FarmCertificationDocument_certification_id_idx" ON "FarmCertificationDocument"("certification_id");

-- CreateIndex
CREATE INDEX "FarmCertificationEvent_certification_id_created_at_idx" ON "FarmCertificationEvent"("certification_id", "created_at");

-- AddForeignKey
ALTER TABLE "FarmCertification" ADD CONSTRAINT "FarmCertification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmCertification" ADD CONSTRAINT "FarmCertification_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmCertificationDocument" ADD CONSTRAINT "FarmCertificationDocument_certification_id_fkey" FOREIGN KEY ("certification_id") REFERENCES "FarmCertification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmCertificationDocument" ADD CONSTRAINT "FarmCertificationDocument_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmCertificationEvent" ADD CONSTRAINT "FarmCertificationEvent_certification_id_fkey" FOREIGN KEY ("certification_id") REFERENCES "FarmCertification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmCertificationEvent" ADD CONSTRAINT "FarmCertificationEvent_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FarmCertificationEvent" ADD CONSTRAINT "FarmCertificationEvent_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "FarmCertificationDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

