import { randomUUID } from "crypto";
import {
  CertificationDocumentType,
  CertificationEventAction,
  CertificationStatus,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { BRASILIA_TIME_ZONE, brasiliaDateKey, startOfTodayInBrasilia } from "../../lib/brasiliaTime";
import { logger } from "../../lib/logger";
import { NotificationService } from "../notification/notification.service";
import { UploadS3Service } from "../upload-S3/uploadS3.service";
import { CertificationError, CertificationRequester } from "./certification.errors";
import { historyQuerySchema } from "./certification.schema";
import { approveSchema, parseDocumentTypes, parseOrThrow, rejectSchema, revokeSchema } from "./certification.schema";
import {
  activeCertificationFilter,
  actorFields,
  approvalSummary,
  certificateSnapshot,
  documentAddedEvents,
  historyEventSelect,
  SYSTEM_ACTOR,
  toHistoryEvent,
  userActor,
  canOwnCertification,
  discardCertificationUploads,
  DOCUMENT_URL_TTL_SECONDS,
  DUPLICATE_MESSAGE,
  EXPIRING_REMINDER_DAYS,
  isBadgeActive,
  isUniqueViolation,
  MAX_DOCUMENTS_PER_CERTIFICATION,
  MAX_FILES_PER_UPLOAD,
  OPEN_STATUSES,
  primaryDocumentId,
  uploadCertificationDocuments,
} from "./certification.shared";
import {
  HarvestCertificationInput,
  harvestCertificationInputSchema,
  listHarvestCertificationsQuerySchema,
} from "./harvestCertification.schema";

const DAY_MS = 86_400_000;
const DEFAULT_PAGE_SIZE = 20;

/** Status em que a certificação pode ser vinculada a anúncios (o selo só aparece quando APPROVED). */
const LINKABLE_STATUSES: CertificationStatus[] = [CertificationStatus.PENDING, CertificationStatus.APPROVED];

/** Dados gravados a partir do formulário: `variety` ausente vira null explícito (o reenvio substitui tudo). */
function certificationData(input: HarvestCertificationInput) {
  return { ...input, variety: input.variety ?? null };
}

/** Identificação legível da safra para mensagens: "2026/27 de Tomate Italiano (lote T3)". */
export function harvestLabel(cert: { harvestSeason: string; crop: string; variety: string | null; plotIdentifier: string }): string {
  const crop = cert.variety ? `${cert.crop} ${cert.variety}` : cert.crop;
  return `${cert.harvestSeason} de ${crop} (lote ${cert.plotIdentifier})`;
}

/** Comparação de cultura sem acento, caixa ou espaços extras. */
function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A cultura da certificação confere com o anúncio quando aparece no nome, na variedade ou na categoria
 * (ou o inverso: "Tomate" × anúncio "Tomate Italiano", ou certificação "Tomate Italiano" × anúncio "Tomate").
 */
export function cropMatchesProduct(crop: string, product: { name: string; variety: string; category: string }): boolean {
  const target = normalizeText(crop);
  if (!target) return false;
  return [product.name, product.variety, product.category]
    .map((value) => normalizeText(value ?? ""))
    .filter(Boolean)
    .some((field) => field.includes(target) || target.includes(field));
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("pt-BR", { timeZone: BRASILIA_TIME_ZONE });
}

/** Filtro do selo ativo da safra. */
export function activeHarvestCertificationWhere(now: Date = new Date()): Prisma.HarvestCertificationWhereInput {
  return activeCertificationFilter(now);
}

/** Select da certificação vinculada a um anúncio (para o selo). Só dados não sensíveis + status/validade. */
export const productHarvestBadgeSelect = {
  select: {
    id: true,
    type: true,
    certifierName: true,
    certificateNumber: true,
    harvestSeason: true,
    crop: true,
    variety: true,
    validUntil: true,
    status: true,
  },
} as const;

type LinkedHarvestCertification = Prisma.HarvestCertificationGetPayload<typeof productHarvestBadgeSelect>;

/**
 * Selo de safra de um anúncio: a certificação vinculada, só se estiver ativa (aprovada e válida hoje);
 * senão null. O `status` não sai (é detalhe interno de avaliação).
 */
export function toHarvestBadge(cert: LinkedHarvestCertification | null | undefined, now: Date = new Date()) {
  if (!cert || !isBadgeActive(cert, now)) return null;
  const { status: _status, ...badge } = cert;
  return badge;
}

/** Aplica o selo de safra num anúncio lido com `harvestCertification: productHarvestBadgeSelect`. */
export function withHarvestBadge<T extends { harvestCertification?: LinkedHarvestCertification | null }>(product: T, now: Date = new Date()) {
  return { ...product, harvestCertification: toHarvestBadge(product.harvestCertification, now) };
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
} satisfies Prisma.HarvestCertificationDocumentSelect;

const linkedProductSelect = {
  id: true,
  name: true,
  variety: true,
  harvestAt: true,
  status: true,
} satisfies Prisma.ProductSelect;

type ReviewAction = "approve" | "reject" | "revoke";

const REVIEW_TRANSITION: Record<
  ReviewAction,
  { from: CertificationStatus; to: CertificationStatus; event: CertificationEventAction }
> = {
  approve: { from: CertificationStatus.PENDING, to: CertificationStatus.APPROVED, event: CertificationEventAction.APPROVED },
  reject: { from: CertificationStatus.PENDING, to: CertificationStatus.REJECTED, event: CertificationEventAction.REJECTED },
  revoke: { from: CertificationStatus.APPROVED, to: CertificationStatus.REVOKED, event: CertificationEventAction.REVOKED },
};

export class HarvestCertificationService {
  private readonly prisma: PrismaClient;
  private readonly uploads: UploadS3Service;
  private readonly notifications: NotificationService;

  constructor(prisma?: PrismaClient, uploads?: UploadS3Service, notifications?: NotificationService) {
    this.prisma = prisma || new PrismaClient();
    this.uploads = uploads || new UploadS3Service(this.prisma);
    this.notifications = notifications || new NotificationService(this.prisma);
  }

  // ─── Dono da certificação (produtor ou comprador que anuncia) ──────────────────

  /** O usuário envia a certificação de uma safra (lote/talhão) com 1+ laudos/documentos. */
  async create(requester: CertificationRequester, body: unknown, files: Express.Multer.File[] = [], now: Date = new Date()) {
    const owner = await this.requireCertificationOwner(requester.userId);
    const input = this.parseInput(body, now);
    if (files.length === 0) throw new CertificationError(400, "Envie ao menos um documento da certificação.");
    if (files.length > MAX_FILES_PER_UPLOAD) {
      throw new CertificationError(400, `Envie no máximo ${MAX_FILES_PER_UPLOAD} arquivos por vez.`);
    }
    const docTypes = parseDocumentTypes((body as Record<string, unknown> | undefined)?.documentTypes, files.length);
    await this.assertNotDuplicate(owner.id, input);

    const certificationId = randomUUID();
    const eventId = randomUUID();
    const documents = await uploadCertificationDocuments(this.uploads, `certifications/harvest/${certificationId}`, files, docTypes);

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.harvestCertification.create({
          data: {
            id: certificationId,
            userId: owner.id,
            ...certificationData(input),
            documents: { create: documents.map((doc) => ({ ...doc, uploadedById: owner.id })) },
          },
        });
        await tx.harvestCertificationEvent.create({
          data: {
            id: eventId,
            certificationId,
            action: CertificationEventAction.SUBMITTED,
            fromStatus: null,
            toStatus: CertificationStatus.PENDING,
            ...actorFields(userActor(owner)),
            revision: 0,
            documentId: primaryDocumentId(documents),
            details: certificateSnapshot(input),
            createdAt: now,
          },
        });
        await tx.harvestCertificationEvent.createMany({
          data: documentAddedEvents(certificationId, documents, userActor(owner), 0, now),
        });
      });
    } catch (err: unknown) {
      await discardCertificationUploads(this.uploads, documents);
      if (isUniqueViolation(err)) throw new CertificationError(409, DUPLICATE_MESSAGE);
      throw err;
    }

    await this.notifications.notifyHarvestCertificationSubmitted({
      certificationId,
      label: harvestLabel({ ...input, variety: input.variety ?? null }),
      ownerName: owner.name,
      resubmitted: false,
      eventId,
    });

    return this.getById(requester, certificationId, now);
  }

  /**
   * Corrige e reenvia uma certificação PENDING ou REJECTED (substitui os dados e anexa novos arquivos).
   * Volta para PENDING, limpa a avaliação anterior e incrementa `revision`. Os anúncios vinculados
   * continuam vinculados (o selo só volta quando for aprovada).
   */
  async resubmit(
    requester: CertificationRequester,
    certificationId: string,
    body: unknown,
    files: Express.Multer.File[] = [],
    now: Date = new Date()
  ) {
    const owner = await this.requireCertificationOwner(requester.userId);
    const current = await this.prisma.harvestCertification.findUnique({
      where: { id: certificationId },
      select: { id: true, userId: true, status: true, revision: true, _count: { select: { documents: true } } },
    });
    if (!current || current.userId !== owner.id) throw new CertificationError(404, "Certificação não encontrada.");
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
    await this.assertNotDuplicate(owner.id, input, certificationId);

    const eventId = randomUUID();
    const documents = await uploadCertificationDocuments(this.uploads, `certifications/harvest/${certificationId}`, files, docTypes);

    try {
      await this.prisma.$transaction(async (tx) => {
        // Compare-and-set em status + revisão (mesma regra da fazenda).
        const updated = await tx.harvestCertification.updateMany({
          where: { id: certificationId, status: current.status, revision: current.revision },
          data: {
            ...certificationData(input),
            revision: { increment: 1 },
            status: CertificationStatus.PENDING,
            reviewedById: null,
            reviewedAt: null,
            rejectionReason: null,
            reviewNotes: null,
          },
        });
        if (updated.count === 0) {
          throw new CertificationError(409, "A certificação foi alterada enquanto você editava. Atualize a página.");
        }
        if (documents.length > 0) {
          await tx.harvestCertificationDocument.createMany({
            data: documents.map((doc) => ({ ...doc, certificationId, uploadedById: owner.id })),
          });
          const total = await tx.harvestCertificationDocument.count({ where: { certificationId } });
          if (total > MAX_DOCUMENTS_PER_CERTIFICATION) {
            throw new CertificationError(400, `Limite de ${MAX_DOCUMENTS_PER_CERTIFICATION} documentos por certificação atingido.`);
          }
        }
        await tx.harvestCertificationEvent.create({
          data: {
            id: eventId,
            certificationId,
            action: CertificationEventAction.RESUBMITTED,
            fromStatus: current.status,
            toStatus: CertificationStatus.PENDING,
            ...actorFields(userActor(owner)),
            revision: current.revision + 1,
            documentId: primaryDocumentId(documents),
            details: certificateSnapshot(input),
            createdAt: now,
          },
        });
        if (documents.length > 0) {
          await tx.harvestCertificationEvent.createMany({
            data: documentAddedEvents(certificationId, documents, userActor(owner), current.revision + 1, now),
          });
        }
      });
    } catch (err: unknown) {
      await discardCertificationUploads(this.uploads, documents);
      if (isUniqueViolation(err)) throw new CertificationError(409, DUPLICATE_MESSAGE);
      throw err;
    }

    await this.notifications.notifyHarvestCertificationSubmitted({
      certificationId,
      label: harvestLabel({ ...input, variety: input.variety ?? null }),
      ownerName: owner.name,
      resubmitted: true,
      eventId,
    });

    return this.getById(requester, certificationId, now);
  }

  /** Certificações de safra do próprio usuário, com `badgeActive` e os anúncios vinculados. */
  async listMine(userId: string, now: Date = new Date()) {
    const rows = await this.prisma.harvestCertification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: {
        documents: { select: documentSelect, orderBy: { uploadedAt: "asc" } },
        products: { select: linkedProductSelect, orderBy: { harvestAt: "asc" } },
      },
    });
    return rows.map((row) => ({ ...row, badgeActive: isBadgeActive(row, now) }));
  }

  /** Detalhe com documentos, histórico e anúncios vinculados. Dono ou admin; para os demais, 404. */
  async getById(requester: CertificationRequester, certificationId: string, now: Date = new Date()) {
    const isAdmin = requester.role === "admin";
    const row = await this.prisma.harvestCertification.findUnique({
      where: { id: certificationId },
      include: {
        documents: { select: documentSelect, orderBy: { uploadedAt: "asc" } },
        events: { select: historyEventSelect, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
        products: { select: linkedProductSelect, orderBy: { harvestAt: "asc" } },
        reviewedBy: { select: { id: true, name: true } },
        user: { select: { id: true, name: true, email: true, phone_number: true, cpf: true, cnpj: true, ccir: true } },
      },
    });
    if (!row || (!isAdmin && row.userId !== requester.userId)) {
      throw new CertificationError(404, "Certificação não encontrada.");
    }
    const { user, events, ...rest } = row;
    return {
      ...rest,
      ...(isAdmin ? { user } : {}),
      events: events.map(toHistoryEvent),
      approval: approvalSummary(events, row),
      badgeActive: isBadgeActive(row, now),
    };
  }

  /** URL temporária para baixar/visualizar um documento (dono ou admin). */
  async getDocumentUrl(requester: CertificationRequester, certificationId: string, documentId: string) {
    const doc = await this.prisma.harvestCertificationDocument.findFirst({
      where: { id: documentId, certificationId },
      select: { s3Key: true, originalName: true, mimeType: true, certification: { select: { userId: true } } },
    });
    if (!doc || (requester.role !== "admin" && doc.certification.userId !== requester.userId)) {
      throw new CertificationError(404, "Documento não encontrado.");
    }
    const url = await this.uploads.getSignedReadUrl(doc.s3Key, DOCUMENT_URL_TTL_SECONDS);
    return { url, expiresIn: DOCUMENT_URL_TTL_SECONDS, originalName: doc.originalName, mimeType: doc.mimeType };
  }

  /** Selo público de safra de um anúncio: a certificação vinculada, só se ativa e só com dados não sensíveis. */
  async getProductBadge(productId: string, now: Date = new Date()) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, harvestCertification: productHarvestBadgeSelect },
    });
    if (!product) throw new CertificationError(404, "Anúncio não encontrado.");
    const certification = toHarvestBadge(product.harvestCertification, now);
    return { productId, certified: certification !== null, certification };
  }

  // ─── Vínculo com anúncios ──────────────────────────────────────────────────────

  /**
   * Vincula a certificação a um anúncio do mesmo dono. A certificação precisa estar pendente ou
   * aprovada e valer hoje; a cultura precisa conferir com o anúncio; a colheita do anúncio precisa
   * cair entre o plantio e a validade da certificação. Um anúncio tem no máximo uma certificação de
   * safra: vincular outra substitui a anterior.
   */
  async linkProduct(requester: CertificationRequester, certificationId: string, productId: string, now: Date = new Date()) {
    const owner = await this.requireCertificationOwner(requester.userId);
    const cert = await this.prisma.harvestCertification.findUnique({
      where: { id: certificationId },
      select: { id: true, userId: true, status: true, crop: true, plantingDate: true, validUntil: true },
    });
    if (!cert || cert.userId !== owner.id) throw new CertificationError(404, "Certificação não encontrada.");
    if (!LINKABLE_STATUSES.includes(cert.status)) {
      throw new CertificationError(409, "Só é possível vincular certificações pendentes ou aprovadas.");
    }
    if (cert.validUntil < startOfTodayInBrasilia(now)) {
      throw new CertificationError(409, "A certificação está vencida e não pode ser vinculada.");
    }

    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, sellerId: true, name: true, variety: true, category: true, harvestAt: true },
    });
    if (!product || product.sellerId !== owner.id) throw new CertificationError(404, "Anúncio não encontrado.");
    if (!cropMatchesProduct(cert.crop, product)) {
      throw new CertificationError(400, `A cultura da certificação (${cert.crop}) não corresponde ao anúncio (${product.name}).`);
    }
    const productHarvestDay = startOfTodayInBrasilia(product.harvestAt);
    if (productHarvestDay < cert.plantingDate || productHarvestDay > cert.validUntil) {
      throw new CertificationError(
        400,
        `A colheita do anúncio (${formatDate(product.harvestAt)}) fica fora do período da certificação (plantio em ${formatDate(cert.plantingDate)}, validade até ${formatDate(cert.validUntil)}).`
      );
    }

    return this.prisma.product.update({
      where: { id: productId },
      data: { harvestCertificationId: certificationId },
      select: { ...linkedProductSelect, harvestCertificationId: true },
    });
  }

  /** Desvincula a certificação de um anúncio do dono. 404 se o anúncio não estiver vinculado a ela. */
  async unlinkProduct(requester: CertificationRequester, certificationId: string, productId: string) {
    const owner = await this.requireCertificationOwner(requester.userId);
    const result = await this.prisma.product.updateMany({
      where: { id: productId, sellerId: owner.id, harvestCertificationId: certificationId },
      data: { harvestCertificationId: null },
    });
    if (result.count === 0) throw new CertificationError(404, "Anúncio não vinculado a esta certificação.");
  }

  // ─── Admin ───────────────────────────────────────────────────────────────────

  /** Fila de avaliação. Pendentes saem das mais antigas para as mais novas; os demais status, ao contrário. */
  async listForAdmin(query: unknown) {
    const params = parseOrThrow(listHarvestCertificationsQuerySchema, query);
    const limit = params.limit ?? DEFAULT_PAGE_SIZE;
    const status = params.status ?? CertificationStatus.PENDING;
    const direction = status === CertificationStatus.PENDING ? "asc" : "desc";

    const rows = await this.prisma.harvestCertification.findMany({
      where: { status, ...(params.type && { type: params.type }), ...(params.userId && { userId: params.userId }) },
      orderBy: [{ createdAt: direction }, { id: direction }],
      take: limit + 1,
      ...(params.cursor && { cursor: { id: params.cursor }, skip: 1 }),
      include: {
        user: { select: { id: true, name: true, email: true } },
        reviewedBy: { select: { id: true, name: true } },
        _count: { select: { documents: true, products: true } },
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  /**
   * Histórico (admin): eventos de todas as certificações de safra, dos mais recentes para os mais
   * antigos. Cada item traz quem fez, qual documento, a revisão, o retrato dos dados e um resumo da
   * certificação (dono, certificadora). Filtros: ação, certificação, autor e período (dias de Brasília).
   */
  async listHistory(query: unknown) {
    const params = parseOrThrow(historyQuerySchema, query);
    const limit = params.limit ?? 50;
    const where: Prisma.HarvestCertificationEventWhereInput = {
      ...(params.action && { action: params.action }),
      ...(params.certificationId && { certificationId: params.certificationId }),
      ...(params.actorId && { actorId: params.actorId }),
      ...((params.from || params.to) && {
        createdAt: {
          ...(params.from && { gte: params.from }),
          ...(params.to && { lt: new Date(params.to.getTime() + DAY_MS) }),
        },
      }),
    };

    const rows = await this.prisma.harvestCertificationEvent.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(params.cursor && { cursor: { id: params.cursor }, skip: 1 }),
      select: {
        ...historyEventSelect,
        certification: { select: { id: true, type: true, status: true, harvestSeason: true, crop: true, variety: true, plotIdentifier: true, certifierName: true, certifierCnpj: true, certificateNumber: true, user: { select: { id: true, name: true } } } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map(({ certification, ...event }) => ({ ...toHistoryEvent(event), certification })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  async approve(admin: CertificationRequester, certificationId: string, body: unknown, now: Date = new Date()) {
    const { revision, documentId, notes } = parseOrThrow(approveSchema, body);
    return this.review("approve", admin, certificationId, { revision, documentId, notes }, now);
  }

  async reject(admin: CertificationRequester, certificationId: string, body: unknown, now: Date = new Date()) {
    const { revision, reason, notes } = parseOrThrow(rejectSchema, body);
    return this.review("reject", admin, certificationId, { revision, reason, notes }, now);
  }

  async revoke(admin: CertificationRequester, certificationId: string, body: unknown, now: Date = new Date()) {
    const { revision, reason, notes } = parseOrThrow(revokeSchema, body);
    return this.review("revoke", admin, certificationId, { revision, reason, notes }, now);
  }

  // ─── Vencimento (job diário) ─────────────────────────────────────────────────

  /** Marca como EXPIRED as aprovadas cuja validade já passou, com histórico e aviso ao dono. */
  async expireOverdue(now: Date = new Date()): Promise<number> {
    const overdue = await this.prisma.harvestCertification.findMany({
      where: { status: CertificationStatus.APPROVED, validUntil: { lt: startOfTodayInBrasilia(now) } },
      select: { id: true, userId: true, harvestSeason: true, crop: true, variety: true, plotIdentifier: true, validUntil: true, revision: true },
    });

    let expired = 0;
    for (const cert of overdue) {
      const eventId = randomUUID();
      try {
        const applied = await this.prisma.$transaction(async (tx) => {
          const updated = await tx.harvestCertification.updateMany({
            where: { id: cert.id, status: CertificationStatus.APPROVED },
            data: { status: CertificationStatus.EXPIRED },
          });
          if (updated.count === 0) return false;
          await tx.harvestCertificationEvent.create({
            data: {
              id: eventId,
              certificationId: cert.id,
              action: CertificationEventAction.EXPIRED,
              fromStatus: CertificationStatus.APPROVED,
              toStatus: CertificationStatus.EXPIRED,
              ...actorFields(SYSTEM_ACTOR),
              revision: cert.revision,
              createdAt: now,
              note: `Validade encerrada em ${brasiliaDateKey(cert.validUntil)}.`,
            },
          });
          return true;
        });
        if (!applied) continue;
        expired++;
        await this.notifications.notifyHarvestCertification("EXPIRED", [
          { certificationId: cert.id, userId: cert.userId, label: harvestLabel(cert), validUntil: cert.validUntil, dedupeId: eventId },
        ]);
      } catch (err: unknown) {
        logger.error(`[HarvestCertification] falha ao expirar a certificação ${cert.id}:`, err instanceof Error ? err.message : err);
      }
    }
    return expired;
  }

  /** Avisa os donos de certificação de safra aprovada vencendo nos próximos EXPIRING_REMINDER_DAYS dias. */
  async sendExpiringReminders(now: Date = new Date()): Promise<number> {
    const today = startOfTodayInBrasilia(now);
    const expiring = await this.prisma.harvestCertification.findMany({
      where: {
        status: CertificationStatus.APPROVED,
        validUntil: { gte: new Date(today.getTime() + DAY_MS), lt: new Date(today.getTime() + (EXPIRING_REMINDER_DAYS + 1) * DAY_MS) },
      },
      select: { id: true, userId: true, harvestSeason: true, crop: true, variety: true, plotIdentifier: true, validUntil: true, revision: true },
    });
    await this.notifications.notifyHarvestCertification(
      "EXPIRING",
      expiring.map((cert) => ({
        certificationId: cert.id,
        userId: cert.userId,
        label: harvestLabel(cert),
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
    params: { revision?: number; documentId?: string; notes?: string; reason?: string },
    now: Date
  ) {
    if (admin.role !== "admin") throw new CertificationError(403, "Apenas administradores podem avaliar certificações.");
    const transition = REVIEW_TRANSITION[action];

    const cert = await this.prisma.harvestCertification.findUnique({
      where: { id: certificationId },
      select: {
        id: true,
        userId: true,
        harvestSeason: true,
        crop: true,
        variety: true,
        plotIdentifier: true,
        status: true,
        revision: true,
        validUntil: true,
        certifierName: true,
        certifierCnpj: true,
        certificateNumber: true,
        issuedAt: true,
        documents: { select: { id: true, docType: true }, orderBy: { uploadedAt: "desc" } },
      },
    });
    if (!cert) throw new CertificationError(404, "Certificação não encontrada.");
    if (cert.status !== transition.from) {
      throw new CertificationError(409, `Ação indisponível: a certificação está ${cert.status}.`);
    }
    // O admin avalia os dados que viu: se o dono reenviou depois disso, a decisão está obsoleta.
    const revision = params.revision ?? cert.revision;
    if (revision !== cert.revision) {
      throw new CertificationError(409, "O usuário alterou a certificação depois que você a abriu. Recarregue e avalie de novo.");
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

    // "Quem deu o aval": retrato do admin no evento.
    const reviewer = await this.prisma.user.findUnique({ where: { id: admin.userId }, select: { name: true } });
    const reviewerActor = { id: admin.userId, name: reviewer?.name ?? null, role: "admin" };

    const eventId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.harvestCertification.updateMany({
        where: { id: certificationId, status: transition.from, revision },
        data: {
          status: transition.to,
          reviewedById: admin.userId,
          reviewedAt: now,
          reviewNotes: params.notes ?? null,
          rejectionReason: action === "approve" ? null : params.reason ?? null,
        },
      });
      if (updated.count === 0) {
        throw new CertificationError(409, "A certificação foi alterada por outra pessoa. Recarregue e avalie de novo.");
      }
      await tx.harvestCertificationEvent.create({
        data: {
          id: eventId,
          certificationId,
          action: transition.event,
          fromStatus: transition.from,
          toStatus: transition.to,
          ...actorFields(reviewerActor),
          revision,
          documentId,
          details: certificateSnapshot(cert),
          createdAt: now,
          note: [params.reason, params.notes].filter(Boolean).join(" — ") || null,
        },
      });
    });

    const outcome = action === "approve" ? "APPROVED" : action === "reject" ? "REJECTED" : "REVOKED";
    await this.notifications.notifyHarvestCertification(outcome, [
      {
        certificationId,
        userId: cert.userId,
        label: harvestLabel(cert),
        validUntil: cert.validUntil,
        reason: params.reason ?? null,
        dedupeId: eventId,
      },
    ]);

    return this.getById(admin, certificationId, now);
  }

  /** Papel lido do banco (não do token): qualquer usuário autenticado que não seja admin. */
  private async requireCertificationOwner(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true } });
    if (!user) throw new CertificationError(404, "Usuário não encontrado.");
    if (!canOwnCertification(user.role)) {
      throw new CertificationError(
        403,
        user.role === "admin" ? "Administradores não podem enviar certificações." : "Seu perfil não pode enviar certificações."
      );
    }
    return user;
  }

  private parseInput(body: unknown, now: Date): HarvestCertificationInput {
    const input = parseOrThrow(harvestCertificationInputSchema, body);
    const today = startOfTodayInBrasilia(now);
    if (input.issuedAt > today) throw new CertificationError(400, "A data de emissão não pode estar no futuro.");
    if (input.validUntil < today) throw new CertificationError(400, "O certificado já está vencido.");
    return input;
  }

  /** Mesmo certificado (tipo + número) já pendente ou aprovado para o usuário (checagem prévia; a garantia é o índice). */
  private async assertNotDuplicate(userId: string, input: HarvestCertificationInput, ignoreId?: string) {
    const duplicate = await this.prisma.harvestCertification.findFirst({
      where: {
        userId,
        type: input.type,
        certificateNumber: { equals: input.certificateNumber, mode: "insensitive" },
        status: { in: OPEN_STATUSES },
        ...(ignoreId && { id: { not: ignoreId } }),
      },
      select: { id: true },
    });
    if (duplicate) throw new CertificationError(409, DUPLICATE_MESSAGE);
  }
}
