import { randomUUID } from "crypto";
import { CertificationDocumentType, CertificationStatus, Prisma } from "@prisma/client";
import { startOfTodayInBrasilia } from "../../lib/brasiliaTime";
import { logger } from "../../lib/logger";
import { UploadS3Service } from "../upload-S3/uploadS3.service";
import { CertificationError } from "./certification.errors";

// Regras e utilitários comuns às certificações (fazenda e safra).

/** Arquivos por envio (criação ou reenvio) e no total da certificação. */
export const MAX_FILES_PER_UPLOAD = 5;
export const MAX_DOCUMENTS_PER_CERTIFICATION = 15;
/** Quantos dias antes do vencimento o dono é avisado. */
export const EXPIRING_REMINDER_DAYS = 30;
/** Validade da URL assinada de um documento. */
export const DOCUMENT_URL_TTL_SECONDS = 600;

/** Certificações que ainda "ocupam a vaga": impedem enviar outra igual. */
export const OPEN_STATUSES: CertificationStatus[] = [CertificationStatus.PENDING, CertificationStatus.APPROVED];

export const DUPLICATE_MESSAGE = "Este certificado já foi enviado e está pendente ou aprovado.";

/**
 * Quem pode ter (enviar, corrigir, listar) certificação: qualquer usuário autenticado que não seja admin.
 * Na plataforma o mesmo usuário compra e vende — um `buyer` também anuncia produtos. Admin só avalia.
 */
export function canOwnCertification(role: string | null | undefined): boolean {
  return Boolean(role) && role !== "admin";
}

/**
 * Violação do índice único parcial de certificado aberto: dois envios simultâneos do mesmo certificado
 * passam pela checagem prévia, mas só um grava.
 */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/** Selo no ar: aprovada e dentro da validade (calendário de Brasília). */
export function isBadgeActive(cert: { status: CertificationStatus; validUntil: Date }, now: Date = new Date()): boolean {
  return cert.status === CertificationStatus.APPROVED && cert.validUntil >= startOfTodayInBrasilia(now);
}

/** Filtro do selo ativo (status + validade), para usar no `where` de qualquer certificação. */
export function activeCertificationFilter(now: Date = new Date()) {
  return { status: CertificationStatus.APPROVED, validUntil: { gte: startOfTodayInBrasilia(now) } };
}

export type UploadedDocument = {
  id: string;
  docType: CertificationDocumentType;
  s3Key: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
};

/** Sobe os arquivos para o S3 no prefixo dado; se algum falhar, remove os que subiram e aborta (502). */
export async function uploadCertificationDocuments(
  uploads: UploadS3Service,
  prefix: string,
  files: Express.Multer.File[],
  docTypes: CertificationDocumentType[]
): Promise<UploadedDocument[]> {
  const results = await Promise.allSettled(files.map((file) => uploads.upload(file, prefix)));

  const documents: UploadedDocument[] = [];
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") return;
    const file = files[index];
    documents.push({
      id: randomUUID(),
      docType: docTypes[index],
      s3Key: result.value.key,
      originalName: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    });
  });

  if (documents.length !== files.length) {
    await discardCertificationUploads(uploads, documents);
    throw new CertificationError(502, "Falha ao enviar os documentos. Tente novamente.");
  }
  return documents;
}

/** Rollback de arquivos que um envio acabou de subir e não chegaram a ser gravados. */
export async function discardCertificationUploads(uploads: UploadS3Service, documents: UploadedDocument[]): Promise<void> {
  await Promise.allSettled(
    documents.map((doc) =>
      uploads.deleteModuleOwnedUpload(doc.s3Key).catch((err: unknown) => {
        logger.error(`[Certification] arquivo órfão no S3 (${doc.s3Key}):`, err instanceof Error ? err.message : err);
      })
    )
  );
}

/** Documento que representa o envio no histórico: o certificado, ou o primeiro arquivo. */
export function primaryDocumentId(documents: { id: string; docType: CertificationDocumentType }[]): string | null {
  const certificate = documents.find((doc) => doc.docType === CertificationDocumentType.CERTIFICATE);
  return (certificate ?? documents[0])?.id ?? null;
}
