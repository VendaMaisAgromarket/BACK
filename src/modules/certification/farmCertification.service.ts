import { randomUUID } from "crypto";
import {
  CertificationDocumentType,
  CertificationEventAction,
  CertificationStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { brasiliaDateKey, startOfTodayInBrasilia } from "../../lib/brasiliaTime";
import { logger } from "../../lib/logger";
import { NotificationService } from "../notification/notification.service";
import { UploadS3Service } from "../upload-S3/uploadS3.service";
import { CertificationError, CertificationRequester } from "./certification.errors";
import {
  approveSchema,
  FarmCertificationInput,
  farmCertificationInputSchema,
  listFarmCertificationsQuerySchema,
  parseDocumentTypes,
  parseOrThrow,
  rejectOrRevokeSchema,
} from "./farmCertification.schema";

/** Arquivos por envio (criação ou reenvio) e no total da certificação. */
export const MAX_FILES_PER_UPLOAD = 5;
export const MAX_DOCUMENTS_PER_CERTIFICATION = 15;
/** Quantos dias antes do vencimento o produtor é avisado. */
export const EXPIRING_REMINDER_DAYS = 30;
/** Validade da URL assinada de um documento. */
export const DOCUMENT_URL_TTL_SECONDS = 600;

const DAY_MS = 86_400_000;
const DEFAULT_PAGE_SIZE = 20;

/** Certificações que ainda "ocupam a vaga": impedem enviar outra igual. */
const OPEN_STATUSES: CertificationStatus[] = [CertificationStatus.PENDING, CertificationStatus.APPROVED];

/** Filtro do selo ativo: aprovada e dentro da validade (calendário de Brasília). */
export function activeFarmCertificationWhere(now: Date = new Date()): Prisma.FarmCertificationWhereInput {
  return { status: CertificationStatus.APPROVED, validUntil: { gte: startOfTodayInBrasilia(now) } };
}

/** Select aninhado do selo para incluir junto do vendedor (produtos, perfil). Só dados não sensíveis. */
export function sellerFarmBadgeSelect(now: Date = new Date()) {
  return {
    where: activeFarmCertificationWhere(now),
    select: { type: true, certifierName: true, validUntil: true },
    orderBy: { validUntil: "desc" as const },
  };
}

// Documentos saem sem a chave do S3: o acesso é sempre pela URL assinada.
const documentSelect = {
  id: true,
  docType: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  uploadedAt: true,
  uploadedBy: { select: { id: true, name: true } },
} satisfies Prisma.FarmCertificationDocumentSelect;

const eventSelect = {
  id: true,
  action: true,
  fromStatus: true,
  toStatus: true,
  note: true,
  createdAt: true,
  actor: { select: { id: true, name: true, role: true } },
  document: { select: { id: true, docType: true, originalName: true } },
} satisfies Prisma.FarmCertificationEventSelect;

type UploadedDocument = {
  id: string;
  docType: CertificationDocumentType;
  s3Key: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
};

type ReviewAction = "approve" | "reject" | "revoke";

const REVIEW_TRANSITION: Record<
  ReviewAction,
  { from: CertificationStatus; to: CertificationStatus; event: CertificationEventAction }
> = {
  approve: { from: CertificationStatus.PENDING, to: CertificationStatus.APPROVED, event: CertificationEventAction.APPROVED },
  reject: { from: CertificationStatus.PENDING, to: CertificationStatus.REJECTED, event: CertificationEventAction.REJECTED },
  revoke: { from: CertificationStatus.APPROVED, to: CertificationStatus.REVOKED, event: CertificationEventAction.REVOKED },
};

export class FarmCertificationService {
  private readonly prisma: PrismaClient;
  private readonly uploads: UploadS3Service;
  private readonly notifications: NotificationService;

  constructor(prisma?: PrismaClient, uploads?: UploadS3Service, notifications?: NotificationService) {
    this.prisma = prisma || new PrismaClient();
    this.uploads = uploads || new UploadS3Service(this.prisma);
    this.notifications = notifications || new NotificationService(this.prisma);
  }

  // ─── Produtor ────────────────────────────────────────────────────────────────

  /** Produtor envia a certificação de uma fazenda (já certificada) com 1+ documentos. */
  async create(requester: CertificationRequester, body: unknown, files: Express.Multer.File[] = [], now: Date = new Date()) {
    const producer = await this.requireProducer(requester.userId);
    const input = this.parseInput(body, now);
    if (files.length === 0) throw new CertificationError(400, "Envie ao menos um documento da certificação.");
    if (files.length > MAX_FILES_PER_UPLOAD) {
      throw new CertificationError(400, `Envie no máximo ${MAX_FILES_PER_UPLOAD} arquivos por vez.`);
    }
    const docTypes = parseDocumentTypes((body as Record<string, unknown> | undefined)?.documentTypes, files.length);
    await this.assertNotDuplicate(producer.id, input);

    const certificationId = randomUUID();
    const eventId = randomUUID();
    const documents = await this.uploadDocuments(certificationId, files, docTypes);

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.farmCertification.create({
          data: {
            id: certificationId,
            userId: producer.id,
            ...input,
            documents: { create: documents.map((doc) => ({ ...doc, uploadedById: producer.id })) },
          },
        });
        await tx.farmCertificationEvent.create({
          data: {
            id: eventId,
            certificationId,
            action: CertificationEventAction.SUBMITTED,
            fromStatus: null,
            toStatus: CertificationStatus.PENDING,
            actorId: producer.id,
            documentId: this.primaryDocumentId(documents),
          },
        });
      });
    } catch (err: unknown) {
      await this.discardUploads(documents);
      throw err;
    }

    await this.notifications.notifyFarmCertificationSubmitted({
      certificationId,
      farmName: input.farmName,
      producerName: producer.name,
      resubmitted: false,
      eventId,
    });

    return this.getById(requester, certificationId);
  }

  /**
   * Corrige e reenvia uma certificação PENDING ou REJECTED (substitui os dados e anexa novos
   * arquivos, se houver). Volta para PENDING e limpa a avaliação anterior (que segue no histórico).
   */
  async resubmit(
    requester: CertificationRequester,
    certificationId: string,
    body: unknown,
    files: Express.Multer.File[] = [],
    now: Date = new Date()
  ) {
    const producer = await this.requireProducer(requester.userId);
    const current = await this.prisma.farmCertification.findUnique({
      where: { id: certificationId },
      select: { id: true, userId: true, status: true, _count: { select: { documents: true } } },
    });
    if (!current || current.userId !== producer.id) throw new CertificationError(404, "Certificação não encontrada.");
    if (current.status !== CertificationStatus.PENDING && current.status !== CertificationStatus.REJECTED) {
      throw new CertificationError(409, "Só é possível alterar certificações pendentes ou recusadas.");
    }

    const input = this.parseInput(body, now);
    if (files.length > MAX_FILES_PER_UPLOAD) {
      throw new CertificationError(400, `Envie no máximo ${MAX_FILES_PER_UPLOAD} arquivos por vez.`);
    }
    if (current._count.documents + files.length > MAX_DOCUMENTS_PER_CERTIFICATION) {
      throw new CertificationError(400, `Limite de ${MAX_DOCUMENTS_PER_CERTIFICATION} documentos por certificação atingido.`);
    }
    const docTypes = parseDocumentTypes((body as Record<string, unknown> | undefined)?.documentTypes, files.length);
    await this.assertNotDuplicate(producer.id, input, certificationId);

    const eventId = randomUUID();
    const documents = await this.uploadDocuments(certificationId, files, docTypes);

    try {
      await this.prisma.$transaction(async (tx) => {
        // Compare-and-set no status: um admin pode ter avaliado no meio do caminho.
        const updated = await tx.farmCertification.updateMany({
          where: { id: certificationId, status: current.status },
          data: {
            ...input,
            status: CertificationStatus.PENDING,
            reviewedById: null,
            reviewedAt: null,
            rejectionReason: null,
            reviewNotes: null,
          },
        });
        if (updated.count === 0) {
          throw new CertificationError(409, "A certificação foi avaliada enquanto você editava. Atualize a página.");
        }
        if (documents.length > 0) {
          await tx.farmCertificationDocument.createMany({
            data: documents.map((doc) => ({ ...doc, certificationId, uploadedById: producer.id })),
          });
        }
        await tx.farmCertificationEvent.create({
          data: {
            id: eventId,
            certificationId,
            action: CertificationEventAction.RESUBMITTED,
            fromStatus: current.status,
            toStatus: CertificationStatus.PENDING,
            actorId: producer.id,
            documentId: this.primaryDocumentId(documents),
          },
        });
      });
    } catch (err: unknown) {
      await this.discardUploads(documents);
      throw err;
    }

    await this.notifications.notifyFarmCertificationSubmitted({
      certificationId,
      farmName: input.farmName,
      producerName: producer.name,
      resubmitted: true,
      eventId,
    });

    return this.getById(requester, certificationId);
  }

  /** Certificações do próprio produtor, com `badgeActive` (selo no ar hoje). */
  async listMine(userId: string, now: Date = new Date()) {
    const rows = await this.prisma.farmCertification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: { documents: { select: documentSelect, orderBy: { uploadedAt: "asc" } } },
    });
    return rows.map((row) => ({ ...row, badgeActive: this.isBadgeActive(row, now) }));
  }

  /** Detalhe com documentos e histórico. Dono ou admin; para os demais, 404. */
  async getById(requester: CertificationRequester, certificationId: string, now: Date = new Date()) {
    const isAdmin = requester.role === "admin";
    const row = await this.prisma.farmCertification.findUnique({
      where: { id: certificationId },
      include: {
        documents: { select: documentSelect, orderBy: { uploadedAt: "asc" } },
        events: { select: eventSelect, orderBy: { createdAt: "asc" } },
        reviewedBy: { select: { id: true, name: true } },
        user: { select: { id: true, name: true, email: true, phone_number: true, cpf: true, cnpj: true, ccir: true } },
      },
    });
    if (!row || (!isAdmin && row.userId !== requester.userId)) {
      throw new CertificationError(404, "Certificação não encontrada.");
    }
    // Os dados de contato do produtor só interessam ao admin que avalia.
    const { user, ...rest } = row;
    return { ...rest, ...(isAdmin ? { user } : {}), badgeActive: this.isBadgeActive(row, now) };
  }

  /** URL temporária para baixar/visualizar um documento (dono ou admin). */
  async getDocumentUrl(requester: CertificationRequester, certificationId: string, documentId: string) {
    const doc = await this.prisma.farmCertificationDocument.findFirst({
      where: { id: documentId, certificationId },
      select: { s3Key: true, originalName: true, mimeType: true, certification: { select: { userId: true } } },
    });
    if (!doc || (requester.role !== "admin" && doc.certification.userId !== requester.userId)) {
      throw new CertificationError(404, "Documento não encontrado.");
    }
    const url = await this.uploads.getSignedReadUrl(doc.s3Key, DOCUMENT_URL_TTL_SECONDS);
    return { url, expiresIn: DOCUMENT_URL_TTL_SECONDS, originalName: doc.originalName, mimeType: doc.mimeType };
  }

  /**
   * Selo público de um produtor: só certificações ativas e só dados não sensíveis
   * (nada de nome da fazenda, CNPJ, CCIR/CAR, área ou documentos).
   */
  async getBadge(userId: string, now: Date = new Date()) {
    const certifications = await this.prisma.farmCertification.findMany({
      where: { userId, ...activeFarmCertificationWhere(now) },
      orderBy: { validUntil: "desc" },
      select: { id: true, type: true, certifierName: true, certificateNumber: true, city: true, uf: true, validUntil: true },
    });
    return { userId, certified: certifications.length > 0, certifications };
  }

  // ─── Admin ───────────────────────────────────────────────────────────────────

  /** Fila de avaliação. Pendentes saem das mais antigas para as mais novas; os demais status, ao contrário. */
  async listForAdmin(query: unknown) {
    const params = parseOrThrow(listFarmCertificationsQuerySchema, query);
    const limit = params.limit ?? DEFAULT_PAGE_SIZE;
    const status = params.status ?? CertificationStatus.PENDING;
    const direction = status === CertificationStatus.PENDING ? "asc" : "desc";

    const rows = await this.prisma.farmCertification.findMany({
      where: { status, ...(params.type && { type: params.type }), ...(params.userId && { userId: params.userId }) },
      orderBy: [{ createdAt: direction }, { id: direction }],
      take: limit + 1,
      ...(params.cursor && { cursor: { id: params.cursor }, skip: 1 }),
      include: {
        user: { select: { id: true, name: true, email: true } },
        reviewedBy: { select: { id: true, name: true } },
        _count: { select: { documents: true } },
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  async approve(admin: CertificationRequester, certificationId: string, body: unknown, now: Date = new Date()) {
    const { documentId, notes } = parseOrThrow(approveSchema, body);
    return this.review("approve", admin, certificationId, { documentId, notes }, now);
  }

  async reject(admin: CertificationRequester, certificationId: string, body: unknown, now: Date = new Date()) {
    const { reason, notes } = parseOrThrow(rejectOrRevokeSchema, body);
    return this.review("reject", admin, certificationId, { reason, notes }, now);
  }

  async revoke(admin: CertificationRequester, certificationId: string, body: unknown, now: Date = new Date()) {
    const { reason, notes } = parseOrThrow(rejectOrRevokeSchema, body);
    return this.review("revoke", admin, certificationId, { reason, notes }, now);
  }

  // ─── Vencimento (job diário) ─────────────────────────────────────────────────

  /** Marca como EXPIRED as aprovadas cuja validade já passou, com histórico e aviso ao produtor. */
  async expireOverdue(now: Date = new Date()): Promise<number> {
    const overdue = await this.prisma.farmCertification.findMany({
      where: { status: CertificationStatus.APPROVED, validUntil: { lt: startOfTodayInBrasilia(now) } },
      select: { id: true, userId: true, farmName: true, validUntil: true },
    });

    let expired = 0;
    for (const cert of overdue) {
      const eventId = randomUUID();
      try {
        const applied = await this.prisma.$transaction(async (tx) => {
          const updated = await tx.farmCertification.updateMany({
            where: { id: cert.id, status: CertificationStatus.APPROVED },
            data: { status: CertificationStatus.EXPIRED },
          });
          if (updated.count === 0) return false; // revogada/expirada em paralelo
          await tx.farmCertificationEvent.create({
            data: {
              id: eventId,
              certificationId: cert.id,
              action: CertificationEventAction.EXPIRED,
              fromStatus: CertificationStatus.APPROVED,
              toStatus: CertificationStatus.EXPIRED,
              actorId: null,
              note: `Validade encerrada em ${brasiliaDateKey(cert.validUntil)}.`,
            },
          });
          return true;
        });
        if (!applied) continue;
        expired++;
        await this.notifications.notifyFarmCertification("EXPIRED", [
          { certificationId: cert.id, userId: cert.userId, farmName: cert.farmName, validUntil: cert.validUntil, dedupeId: eventId },
        ]);
      } catch (err: unknown) {
        logger.error(`[FarmCertification] falha ao expirar a certificação ${cert.id}:`, err instanceof Error ? err.message : err);
      }
    }
    return expired;
  }

  /**
   * Avisa os produtores com certificação aprovada vencendo nos próximos EXPIRING_REMINDER_DAYS dias.
   * Um aviso por certificação e validade (dedupeKey): rodar todo dia não duplica.
   */
  async sendExpiringReminders(now: Date = new Date()): Promise<number> {
    const today = startOfTodayInBrasilia(now);
    const expiring = await this.prisma.farmCertification.findMany({
      where: {
        status: CertificationStatus.APPROVED,
        validUntil: { gte: new Date(today.getTime() + DAY_MS), lt: new Date(today.getTime() + (EXPIRING_REMINDER_DAYS + 1) * DAY_MS) },
      },
      select: { id: true, userId: true, farmName: true, validUntil: true },
    });
    await this.notifications.notifyFarmCertification(
      "EXPIRING",
      expiring.map((cert) => ({
        certificationId: cert.id,
        userId: cert.userId,
        farmName: cert.farmName,
        validUntil: cert.validUntil,
        dedupeId: `${cert.id}:${brasiliaDateKey(cert.validUntil)}`,
      }))
    );
    return expiring.length;
  }

  // ─── Internos ────────────────────────────────────────────────────────────────

  private async review(
    action: ReviewAction,
    admin: CertificationRequester,
    certificationId: string,
    params: { documentId?: string; notes?: string; reason?: string },
    now: Date
  ) {
    if (admin.role !== "admin") throw new CertificationError(403, "Apenas administradores podem avaliar certificações.");
    const transition = REVIEW_TRANSITION[action];

    const cert = await this.prisma.farmCertification.findUnique({
      where: { id: certificationId },
      select: {
        id: true,
        userId: true,
        farmName: true,
        status: true,
        validUntil: true,
        documents: { select: { id: true, docType: true }, orderBy: { uploadedAt: "desc" } },
      },
    });
    if (!cert) throw new CertificationError(404, "Certificação não encontrada.");
    if (cert.status !== transition.from) {
      throw new CertificationError(409, `Ação indisponível: a certificação está ${cert.status}.`);
    }

    let documentId: string | null = null;
    if (action === "approve") {
      if (cert.validUntil < startOfTodayInBrasilia(now)) {
        throw new CertificationError(409, "O certificado já está vencido: recuse a certificação em vez de aprová-la.");
      }
      if (params.documentId) {
        if (!cert.documents.some((doc) => doc.id === params.documentId)) {
          throw new CertificationError(400, "O documento informado não pertence a esta certificação.");
        }
        documentId = params.documentId;
      } else {
        const certificate = cert.documents.find((doc) => doc.docType === CertificationDocumentType.CERTIFICATE);
        documentId = (certificate ?? cert.documents[0])?.id ?? null;
      }
    }

    const eventId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.farmCertification.updateMany({
        where: { id: certificationId, status: transition.from },
        data: {
          status: transition.to,
          reviewedById: admin.userId,
          reviewedAt: now,
          reviewNotes: params.notes ?? null,
          rejectionReason: action === "approve" ? null : params.reason ?? null,
        },
      });
      if (updated.count === 0) {
        throw new CertificationError(409, "A certificação foi alterada por outra pessoa. Atualize a página.");
      }
      await tx.farmCertificationEvent.create({
        data: {
          id: eventId,
          certificationId,
          action: transition.event,
          fromStatus: transition.from,
          toStatus: transition.to,
          actorId: admin.userId,
          documentId,
          note: [params.reason, params.notes].filter(Boolean).join(" — ") || null,
        },
      });
    });

    const outcome = action === "approve" ? "APPROVED" : action === "reject" ? "REJECTED" : "REVOKED";
    await this.notifications.notifyFarmCertification(outcome, [
      {
        certificationId,
        userId: cert.userId,
        farmName: cert.farmName,
        validUntil: cert.validUntil,
        reason: params.reason ?? null,
        dedupeId: eventId,
      },
    ]);

    return this.getById(admin, certificationId, now);
  }

  private async requireProducer(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true } });
    if (!user) throw new CertificationError(404, "Usuário não encontrado.");
    if (user.role !== "producer") throw new CertificationError(403, "Apenas produtores podem enviar certificação de fazenda.");
    return user;
  }

  private parseInput(body: unknown, now: Date): FarmCertificationInput {
    const input = parseOrThrow(farmCertificationInputSchema, body);
    const today = startOfTodayInBrasilia(now);
    if (input.issuedAt > today) throw new CertificationError(400, "A data de emissão não pode estar no futuro.");
    if (input.validUntil < today) throw new CertificationError(400, "O certificado já está vencido.");
    return input;
  }

  /** Mesmo certificado (tipo + número) já pendente ou aprovado para o produtor. */
  private async assertNotDuplicate(userId: string, input: FarmCertificationInput, ignoreId?: string) {
    const duplicate = await this.prisma.farmCertification.findFirst({
      where: {
        userId,
        type: input.type,
        certificateNumber: { equals: input.certificateNumber, mode: "insensitive" },
        status: { in: OPEN_STATUSES },
        ...(ignoreId && { id: { not: ignoreId } }),
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new CertificationError(409, "Este certificado já foi enviado e está pendente ou aprovado.");
    }
  }

  /** Sobe os arquivos para o S3; se algum falhar, remove os que subiram e aborta. */
  private async uploadDocuments(
    certificationId: string,
    files: Express.Multer.File[],
    docTypes: CertificationDocumentType[]
  ): Promise<UploadedDocument[]> {
    const prefix = `certifications/farm/${certificationId}`;
    const results = await Promise.allSettled(files.map((file) => this.uploads.upload(file, prefix)));

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
      await this.discardUploads(documents);
      throw new CertificationError(502, "Falha ao enviar os documentos. Tente novamente.");
    }
    return documents;
  }

  private async discardUploads(documents: UploadedDocument[]) {
    await Promise.allSettled(
      documents.map((doc) =>
        this.uploads.delete(doc.s3Key).catch((err: unknown) => {
          logger.error(`[FarmCertification] arquivo órfão no S3 (${doc.s3Key}):`, err instanceof Error ? err.message : err);
        })
      )
    );
  }

  private primaryDocumentId(documents: UploadedDocument[]): string | null {
    const certificate = documents.find((doc) => doc.docType === CertificationDocumentType.CERTIFICATE);
    return (certificate ?? documents[0])?.id ?? null;
  }

  private isBadgeActive(cert: { status: CertificationStatus; validUntil: Date }, now: Date): boolean {
    return cert.status === CertificationStatus.APPROVED && cert.validUntil >= startOfTodayInBrasilia(now);
  }
}
