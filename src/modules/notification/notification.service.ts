import { NotificationType, Prisma, PrismaClient } from "@prisma/client";
import { BRASILIA_TIME_ZONE, brasiliaDateKey, startOfTodayInBrasilia } from "../../lib/brasiliaTime";
import { logger } from "../../lib/logger";

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface NotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  saleId?: string;
  productId?: string;
  /** Dados para o front montar o link/ação: sempre inclui `role` (buyer|seller) e `orderNumber` quando há venda. */
  data?: Prisma.InputJsonObject;
  /** Chave única: a mesma transição processada mais de uma vez não duplica a notificação. */
  dedupeKey?: string;
}

interface SaleNotificationContext {
  saleId: string;
  orderNumber: number;
  buyerId: string;
  buyerName: string;
  sellerIds: string[];
}

export interface ListNotificationsParams {
  unreadOnly?: boolean;
  limit?: number;
  cursor?: string;
}

/** Quantos dias antes da colheita do anúncio o vendedor é lembrado. */
export const HARVEST_REMINDER_DAYS = 5;

const DAY_MS = 86_400_000;
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;

/** Status que o vendedor também é avisado (cancelamento não: é ele quem cancela). */
const SELLER_NOTIFIED_STATUSES = ["Entregue", "Concluído", "Concluída"];

function formatBRL(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatBrasiliaDate(date: Date): string {
  return date.toLocaleDateString("pt-BR", { timeZone: BRASILIA_TIME_ZONE });
}

export class NotificationService {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || new PrismaClient();
  }

  // ─── Persistência ────────────────────────────────────────────────────────────

  /**
   * Grava as notificações. Aceita um `tx` para participar de uma transação já aberta (pagamentos).
   * Duplicatas pela `dedupeKey` são ignoradas silenciosamente (ON CONFLICT DO NOTHING).
   */
  async createMany(inputs: NotificationInput[], client: DbClient = this.prisma): Promise<number> {
    if (inputs.length === 0) return 0;
    const result = await client.notification.createMany({ data: inputs, skipDuplicates: true });
    return result.count;
  }

  /**
   * Executa a geração de notificações como efeito colateral "best-effort": uma falha aqui é logada
   * e nunca derruba a operação de negócio que já foi concluída (decisão do vendedor, pesagem etc.).
   */
  private async safely(label: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err: unknown) {
      logger.error(`[Notifications] falha ao gerar notificação (${label}):`, err instanceof Error ? err.message : err);
    }
  }

  private async getSaleContext(saleId: string, client: DbClient = this.prisma): Promise<SaleNotificationContext | null> {
    const sale = await client.saleData.findUnique({
      where: { id: saleId },
      select: {
        id: true,
        orderNumber: true,
        buyerId: true,
        buyer: { select: { name: true } },
        boughtProducts: { select: { product: { select: { sellerId: true } } } },
      },
    });
    if (!sale) return null;

    return {
      saleId: sale.id,
      orderNumber: sale.orderNumber,
      buyerId: sale.buyerId,
      buyerName: sale.buyer.name,
      sellerIds: [...new Set(sale.boughtProducts.map((bp) => bp.product.sellerId))],
    };
  }

  // ─── Eventos de venda (best-effort, após a operação) ─────────────────────────

  /** Vendedor(es): chegou um pedido novo. */
  async notifyNewOrder(saleId: string): Promise<void> {
    await this.safely("NEW_ORDER", async () => {
      const ctx = await this.getSaleContext(saleId);
      if (!ctx) return;
      await this.createMany(
        ctx.sellerIds.map((sellerId) => ({
          userId: sellerId,
          type: NotificationType.NEW_ORDER,
          title: "Novo pedido recebido",
          message: `Você recebeu o pedido #${ctx.orderNumber} de ${ctx.buyerName}. Acesse para aceitar ou recusar.`,
          saleId,
          data: { role: "seller", orderNumber: ctx.orderNumber },
          dedupeKey: `NEW_ORDER:${saleId}:${sellerId}`,
        }))
      );
    });
  }

  /**
   * Comprador: vendedor aceitou ou recusou o pedido. A checagem de status em setSellerDecision é
   * feita antes do update, então decisões simultâneas/repetidas podem chegar aqui mais de uma vez —
   * a dedupeKey estável por venda + decisão garante uma única notificação de cada tipo.
   */
  async notifySellerDecision(saleId: string, approved: boolean, status: string): Promise<void> {
    const type = approved ? NotificationType.ORDER_ACCEPTED : NotificationType.ORDER_REJECTED;
    await this.safely(type, async () => {
      const ctx = await this.getSaleContext(saleId);
      if (!ctx) return;
      await this.createMany([
        {
          userId: ctx.buyerId,
          type,
          title: approved ? "Pedido aceito pelo vendedor" : "Pedido recusado pelo vendedor",
          message: approved
            ? `O vendedor aceitou o seu pedido #${ctx.orderNumber}.`
            : `O vendedor recusou o seu pedido #${ctx.orderNumber}.`,
          saleId,
          data: { role: "buyer", orderNumber: ctx.orderNumber, status },
          dedupeKey: `${type}:${saleId}`,
        },
      ]);
    });
  }

  /** Comprador: qualquer outra mudança de status do pedido. Vendedor(es): só entrega e conclusão. */
  async notifyStatusChanged(saleId: string, status: string): Promise<void> {
    await this.safely("ORDER_STATUS_CHANGED", async () => {
      const ctx = await this.getSaleContext(saleId);
      if (!ctx) return;
      const sellerNotifications: NotificationInput[] = SELLER_NOTIFIED_STATUSES.includes(status)
        ? ctx.sellerIds.map((sellerId) => ({
            userId: sellerId,
            type: NotificationType.ORDER_STATUS_CHANGED,
            title: "Status do pedido atualizado",
            message: `O pedido #${ctx.orderNumber} agora está: ${status}.`,
            saleId,
            data: { role: "seller", orderNumber: ctx.orderNumber, status },
          }))
        : [];
      await this.createMany([this.buildStatusChanged(ctx, status), ...sellerNotifications]);
    });
  }

  /** Comprador: vendedor registrou a pesagem (o status passa a "Aguardando pagamento final"). */
  async notifyWeightRegistered(
    saleId: string,
    params: { weightKg: number; adjustedContractTotal: number | null; status: string }
  ): Promise<void> {
    await this.safely("WEIGHT_REGISTERED", async () => {
      const ctx = await this.getSaleContext(saleId);
      if (!ctx) return;
      const totalText = params.adjustedContractTotal !== null
        ? ` Novo valor do contrato: ${formatBRL(params.adjustedContractTotal)}.`
        : "";
      await this.createMany([
        {
          userId: ctx.buyerId,
          type: NotificationType.WEIGHT_REGISTERED,
          title: "Pesagem registrada",
          message: `O vendedor registrou a pesagem do pedido #${ctx.orderNumber}: ${params.weightKg.toLocaleString("pt-BR")} kg.${totalText} O próximo passo é o pagamento final.`,
          saleId,
          data: {
            role: "buyer",
            orderNumber: ctx.orderNumber,
            status: params.status,
            weightKg: params.weightKg,
            adjustedContractTotal: params.adjustedContractTotal,
          },
          dedupeKey: `WEIGHT_REGISTERED:${saleId}`,
        },
      ]);
    });
  }

  // ─── Eventos de pagamento (dentro da transação do pagamento) ─────────────────

  /**
   * Vendedor(es): entrada (30%) ou parcela final (70%)/pagamento integral confirmados.
   * Quando o pagamento conclui o pedido, a própria mensagem ao vendedor avisa a conclusão (em vez
   * de uma segunda notificação de status no mesmo instante).
   * Comprador: o status do pedido mudou. Roda dentro da transação de applyPaymentCompletion —
   * se falhar, o pagamento não é gravado e o webhook/poller tenta de novo. As `dedupeKey` por
   * pagamento evitam duplicatas quando a mesma confirmação chega pelo webhook e pelo poller.
   */
  async notifyPaymentCompleted(
    tx: Prisma.TransactionClient,
    params: { paymentId: string; saleId: string; phase: string; amount: number; status: string }
  ): Promise<void> {
    const ctx = await this.getSaleContext(params.saleId, tx);
    if (!ctx) return;

    const isDownPayment = params.phase === "down_payment";
    const isFull = params.phase === "full";
    const title = isDownPayment
      ? "Entrada do pedido paga"
      : isFull ? "Pagamento integral recebido" : "Pagamento final recebido";
    const what = isDownPayment
      ? "a entrada (30%)"
      : isFull ? "o valor integral" : "a parcela final (70%)";
    const type = isDownPayment ? NotificationType.DOWN_PAYMENT_RECEIVED : NotificationType.FINAL_PAYMENT_RECEIVED;

    const sellerNotifications: NotificationInput[] = ctx.sellerIds.map((sellerId) => ({
      userId: sellerId,
      type,
      title,
      message: `O comprador pagou ${what} do pedido #${ctx.orderNumber}: ${formatBRL(params.amount)}.${
        SELLER_NOTIFIED_STATUSES.includes(params.status) ? ` O pedido agora está: ${params.status}.` : ""
      }`,
      saleId: params.saleId,
      data: { role: "seller", orderNumber: ctx.orderNumber, phase: params.phase, amount: params.amount, status: params.status },
      dedupeKey: `${type}:${params.paymentId}:${sellerId}`,
    }));

    await this.createMany(
      [
        ...sellerNotifications,
        { ...this.buildStatusChanged(ctx, params.status), dedupeKey: `ORDER_STATUS_CHANGED:payment:${params.paymentId}` },
      ],
      tx
    );
  }

  private buildStatusChanged(ctx: SaleNotificationContext, status: string): NotificationInput {
    return {
      userId: ctx.buyerId,
      type: NotificationType.ORDER_STATUS_CHANGED,
      title: "Status do pedido atualizado",
      message: `O seu pedido #${ctx.orderNumber} agora está: ${status}.`,
      saleId: ctx.saleId,
      data: { role: "buyer", orderNumber: ctx.orderNumber, status },
    };
  }

  // ─── Lembrete de colheita do anúncio (cron) ──────────────────────────────────

  /**
   * Lembra o vendedor dos anúncios ativos cuja data de colheita cai nos próximos
   * HARVEST_REMINDER_DAYS dias (calendário de Brasília): passada essa data, o anúncio é desativado pelo
   * deactivateExpiredProductsJob, então é a hora de ele decidir (prorrogar a colheita, ajustar
   * preço/estoque ou deixar encerrar). Em operação normal o lembrete sai exatamente a 5 dias; a
   * janela 1..5 cobre dias em que o job não rodou e anúncios criados já com colheita próxima.
   * A `dedupeKey` inclui a data da colheita: se o vendedor prorrogar, a nova data gera novo lembrete.
   * Obs.: o lembrete da colheita planejada de uma VENDA (plannedHarvestDate) está em stand-by.
   */
  async sendProductHarvestReminders(now: Date = new Date()): Promise<number> {
    const today = startOfTodayInBrasilia(now);
    const products = await this.prisma.product.findMany({
      where: {
        status: true,
        stock: { gt: 0 },
        harvestAt: {
          gte: new Date(today.getTime() + DAY_MS),
          lt: new Date(today.getTime() + (HARVEST_REMINDER_DAYS + 1) * DAY_MS),
        },
      },
      select: { id: true, sellerId: true, name: true, variety: true, harvestAt: true },
    });

    const inputs: NotificationInput[] = products.map((product) => {
      const daysLeft = Math.round((startOfTodayInBrasilia(product.harvestAt).getTime() - today.getTime()) / DAY_MS);
      const label = product.variety ? `${product.name} (${product.variety})` : product.name;
      return {
        userId: product.sellerId,
        type: NotificationType.PRODUCT_HARVEST_REMINDER,
        title: "Colheita do anúncio se aproximando",
        message: `Faltam ${daysLeft} dia${daysLeft === 1 ? "" : "s"} para a colheita de ${label}, prevista para ${formatBrasiliaDate(product.harvestAt)}. Após essa data o anúncio será desativado: se quiser mantê-lo à venda, atualize a data de colheita.`,
        productId: product.id,
        data: { role: "seller", productId: product.id, harvestAt: product.harvestAt.toISOString(), daysLeft },
        dedupeKey: `PRODUCT_HARVEST_REMINDER:${product.id}:${brasiliaDateKey(product.harvestAt)}`,
      };
    });

    return this.createMany(inputs);
  }

  // ─── Consulta e leitura (endpoints) ──────────────────────────────────────────

  async list(userId: string, params: ListNotificationsParams = {}) {
    const limit = Math.min(Math.max(params.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const where: Prisma.NotificationWhereInput = { userId, ...(params.unreadOnly && { readAt: null }) };

    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(params.cursor && { cursor: { id: params.cursor }, skip: 1 }),
        select: {
          id: true,
          type: true,
          title: true,
          message: true,
          saleId: true,
          productId: true,
          data: true,
          readAt: true,
          createdAt: true,
        },
      }),
      this.unreadCount(userId),
    ]);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null, unreadCount };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, readAt: null } });
  }

  /** Marca como lida uma notificação do próprio usuário. Retorna false se não existir/não for dele. */
  async markAsRead(userId: string, notificationId: string): Promise<boolean> {
    const existing = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
      select: { id: true, readAt: true },
    });
    if (!existing) return false;
    if (!existing.readAt) {
      await this.prisma.notification.update({ where: { id: notificationId }, data: { readAt: new Date() } });
    }
    return true;
  }

  async markAllAsRead(userId: string): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }
}
