import { randomUUID } from "crypto";
import { CertificationDocumentType, CertificationEventAction, CertificationStatus, Prisma } from "@prisma/client";
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

// ─── Histórico (eventos) ─────────────────────────────────────────────────────────

/** Quem fez a ação, retratado no evento (o histórico não muda se o usuário mudar de nome/papel). */
export interface EventActor {
  id: string | null;
  name: string | null;
  role: string;
}

export const SYSTEM_ACTOR: EventActor = { id: null, name: "Sistema", role: "system" };

export function actorFields(actor: EventActor) {
  return { actorId: actor.id, actorName: actor.name, actorRole: actor.role };
}

/** "Quem certificou": certificadora e certificado no momento da ação, com a revisão dos dados. */
export function certificateSnapshot(cert: {
  certifierName: string;
  certifierCnpj: string;
  certificateNumber: string;
  issuedAt: Date;
  validUntil: Date;
}): Prisma.InputJsonObject {
  return {
    certifierName: cert.certifierName,
    certifierCnpj: cert.certifierCnpj,
    certificateNumber: cert.certificateNumber,
    issuedAt: cert.issuedAt.toISOString(),
    validUntil: cert.validUntil.toISOString(),
  };
}

/**
 * Um evento DOCUMENT_ADDED por arquivo anexado, logo após o evento de envio/reenvio (1 ms de distância
 * cada, para a ordem do histórico ficar estável — eventos da mesma transação teriam o mesmo horário).
 */
export function documentAddedEvents(
  certificationId: string,
  documents: UploadedDocument[],
  actor: EventActor,
  revision: number,
  at: Date
) {
  return documents.map((doc, index) => ({
    certificationId,
    action: CertificationEventAction.DOCUMENT_ADDED,
    fromStatus: CertificationStatus.PENDING,
    toStatus: CertificationStatus.PENDING,
    ...actorFields(actor),
    revision,
    documentId: doc.id,
    details: { originalName: doc.originalName, docType: doc.docType, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes },
    createdAt: new Date(at.getTime() + index + 1),
  }));
}

/** Campos lidos de cada evento (sem relações vivas: quem fez vem do retrato gravado no evento). */
export const historyEventSelect = {
  id: true,
  action: true,
  fromStatus: true,
  toStatus: true,
  actorId: true,
  actorName: true,
  actorRole: true,
  revision: true,
  note: true,
  details: true,
  createdAt: true,
  document: { select: { id: true, docType: true, originalName: true } },
} as const;

type RawHistoryEvent = {
  id: string;
  action: CertificationEventAction;
  fromStatus: CertificationStatus | null;
  toStatus: CertificationStatus;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  revision: number | null;
  note: string | null;
  details: Prisma.JsonValue;
  createdAt: Date;
  document: { id: string; docType: CertificationDocumentType; originalName: string } | null;
};

/**
 * Evento no formato da API: `actor` = quem fez (null = sistema), `performedBy` = papel no momento
 * (producer | buyer | admin | system), `document` = arquivo referenciado, `details` = retrato dos dados.
 */
export function toHistoryEvent(event: RawHistoryEvent) {
  const { actorId, actorName, actorRole, ...rest } = event;
  return {
    ...rest,
    performedBy: actorRole ?? (actorId ? null : "system"),
    actor: actorId ? { id: actorId, name: actorName, role: actorRole } : null,
  };
}

function jsonString(details: Prisma.JsonValue, key: string): string | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const value = (details as Prisma.JsonObject)[key];
  return typeof value === "string" ? value : null;
}

/**
 * Resumo da aprovação mais recente (pedido do cliente): quando, "quem deu o aval" (admin do evento
 * APPROVED), com qual documento, sobre qual revisão, e "quem certificou" (certificadora retratada no
 * evento; para eventos antigos, sem retrato, usa os dados atuais da certificação). Null se nunca aprovada.
 */
export function approvalSummary(
  events: RawHistoryEvent[],
  current: { certifierName: string; certifierCnpj: string; certificateNumber: string; validUntil: Date }
) {
  const approved = [...events].reverse().find((event) => event.action === CertificationEventAction.APPROVED);
  if (!approved) return null;
  return {
    approvedAt: approved.createdAt,
    approvedBy: approved.actorId ? { id: approved.actorId, name: approved.actorName } : null,
    revision: approved.revision,
    document: approved.document,
    note: approved.note,
    certifiedBy: {
      certifierName: jsonString(approved.details, "certifierName") ?? current.certifierName,
      certifierCnpj: jsonString(approved.details, "certifierCnpj") ?? current.certifierCnpj,
      certificateNumber: jsonString(approved.details, "certificateNumber") ?? current.certificateNumber,
      validUntil: jsonString(approved.details, "validUntil") ?? current.validUntil.toISOString(),
    },
  };
}

/** Retrato de um usuário como autor de evento. */
export function userActor(user: { id: string; name: string; role: string }): EventActor {
  return { id: user.id, name: user.name, role: user.role };
}
