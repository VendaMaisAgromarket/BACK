import { NotificationType, PrismaClient } from '@prisma/client';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { NotificationService } from '../notification.service';

const SALE_ID = 'sale-1';

function saleContext(sellerIds: string[] = ['seller-1']) {
  return {
    id: SALE_ID,
    orderNumber: 42,
    buyerId: 'buyer-1',
    buyer: { name: 'Comprador Teste' },
    boughtProducts: sellerIds.map((sellerId) => ({ product: { sellerId } })),
  };
}

function createdInputs(prisma: DeepMockProxy<PrismaClient>) {
  return prisma.notification.createMany.mock.calls.flatMap(([args]) => args?.data as Array<Record<string, unknown>>);
}

describe('NotificationService', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let service: NotificationService;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    prisma.notification.createMany.mockImplementation((async (args: { data: unknown[] }) => ({ count: args.data.length })) as never);
    service = new NotificationService(prisma as unknown as PrismaClient);
  });

  describe('notifyNewOrder', () => {
    it('avisa cada vendedor distinto da venda uma única vez, com dedupeKey por vendedor', async () => {
      prisma.saleData.findUnique.mockResolvedValue(saleContext(['seller-1', 'seller-1', 'seller-2']) as never);

      await service.notifyNewOrder(SALE_ID);

      expect(prisma.notification.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
      const inputs = createdInputs(prisma);
      expect(inputs).toHaveLength(2);
      expect(inputs.map((n) => n.userId)).toEqual(['seller-1', 'seller-2']);
      expect(inputs[0]).toMatchObject({
        type: NotificationType.NEW_ORDER,
        saleId: SALE_ID,
        data: { role: 'seller', orderNumber: 42 },
        dedupeKey: `NEW_ORDER:${SALE_ID}:seller-1`,
      });
    });

    it('não derruba a operação de negócio quando a gravação da notificação falha', async () => {
      prisma.saleData.findUnique.mockResolvedValue(saleContext() as never);
      prisma.notification.createMany.mockRejectedValue(new Error('db down'));

      await expect(service.notifyNewOrder(SALE_ID)).resolves.toBeUndefined();
    });
  });

  describe('notifySellerDecision', () => {
    const T1 = new Date('2026-10-16T12:00:00.000Z');
    const T2 = new Date('2026-10-16T13:00:00.000Z');
    const T3 = new Date('2026-10-16T14:00:00.000Z');

    it.each([
      [true, NotificationType.ORDER_ACCEPTED],
      [false, NotificationType.ORDER_REJECTED],
    ])('approved=%s notifica o comprador com %s, chaveado pela transição', async (approved, type) => {
      prisma.saleData.findUnique.mockResolvedValue(saleContext() as never);

      await service.notifySellerDecision(SALE_ID, approved, 'status', T1);

      expect(createdInputs(prisma)).toEqual([
        expect.objectContaining({
          userId: 'buyer-1',
          type,
          data: { role: 'buyer', orderNumber: 42, status: 'status' },
          dedupeKey: `${type}:${SALE_ID}:${T1.toISOString()}`,
        }),
      ]);
    });

    it('reprocessar a MESMA transição gera a mesma dedupeKey (o banco descarta a duplicata)', async () => {
      prisma.saleData.findUnique.mockResolvedValue(saleContext() as never);

      await service.notifySellerDecision(SALE_ID, true, 'Aprovado pelo vendedor', T1);
      await service.notifySellerDecision(SALE_ID, true, 'Aprovado pelo vendedor', T1);

      const keys = createdInputs(prisma).map((n) => n.dedupeKey);
      expect(new Set(keys).size).toBe(1);
      expect(prisma.notification.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    });

    it('aceitar → recusar → aceitar entrega as três notificações (chaves distintas por transição)', async () => {
      prisma.saleData.findUnique.mockResolvedValue(saleContext() as never);

      await service.notifySellerDecision(SALE_ID, true, 'Aprovado pelo vendedor', T1);
      await service.notifySellerDecision(SALE_ID, false, 'Recusado pelo vendedor', T2);
      await service.notifySellerDecision(SALE_ID, true, 'Aprovado pelo vendedor', T3);

      expect(createdInputs(prisma).map((n) => n.dedupeKey)).toEqual([
        `ORDER_ACCEPTED:${SALE_ID}:${T1.toISOString()}`,
        `ORDER_REJECTED:${SALE_ID}:${T2.toISOString()}`,
        `ORDER_ACCEPTED:${SALE_ID}:${T3.toISOString()}`,
      ]);
    });
  });

  describe('notifyStatusChanged', () => {
    it.each(['Entregue', 'Concluído'])('status %s avisa o comprador e também o vendedor', async (status) => {
      prisma.saleData.findUnique.mockResolvedValue(saleContext(['seller-1', 'seller-2']) as never);

      await service.notifyStatusChanged(SALE_ID, status);

      expect(createdInputs(prisma)).toEqual([
        expect.objectContaining({ userId: 'buyer-1', data: { role: 'buyer', orderNumber: 42, status } }),
        expect.objectContaining({ userId: 'seller-1', data: { role: 'seller', orderNumber: 42, status } }),
        expect.objectContaining({ userId: 'seller-2', data: { role: 'seller', orderNumber: 42, status } }),
      ]);
    });

    it.each(['Cancelado', 'Colheita autorizada'])('status %s avisa só o comprador', async (status) => {
      prisma.saleData.findUnique.mockResolvedValue(saleContext() as never);

      await service.notifyStatusChanged(SALE_ID, status);

      expect(createdInputs(prisma).map((n) => n.userId)).toEqual(['buyer-1']);
    });
  });

  describe('notifyPaymentCompleted', () => {
    it('entrada (30%): avisa o vendedor e informa o novo status ao comprador, com dedupeKey por pagamento', async () => {
      prisma.saleData.findUnique.mockResolvedValue(saleContext() as never);

      await service.notifyPaymentCompleted(prisma as never, {
        paymentId: 'pay-1', saleId: SALE_ID, phase: 'down_payment', amount: 300, status: 'Entrada confirmada',
      });

      const inputs = createdInputs(prisma);
      expect(inputs).toEqual([
        expect.objectContaining({
          userId: 'seller-1',
          type: NotificationType.DOWN_PAYMENT_RECEIVED,
          dedupeKey: 'DOWN_PAYMENT_RECEIVED:pay-1:seller-1',
        }),
        expect.objectContaining({
          userId: 'buyer-1',
          type: NotificationType.ORDER_STATUS_CHANGED,
          dedupeKey: 'ORDER_STATUS_CHANGED:payment:pay-1',
          data: { role: 'buyer', orderNumber: 42, status: 'Entrada confirmada' },
        }),
      ]);
      expect(inputs[0].message).toContain('entrada (30%)');
    });

    it.each([
      ['final_payment', 'parcela final (70%)'],
      ['full', 'valor integral'],
    ])('fase %s gera FINAL_PAYMENT_RECEIVED para o vendedor', async (phase, text) => {
      prisma.saleData.findUnique.mockResolvedValue(saleContext() as never);

      await service.notifyPaymentCompleted(prisma as never, {
        paymentId: 'pay-2', saleId: SALE_ID, phase, amount: 700, status: 'Concluído',
      });

      const [seller] = createdInputs(prisma);
      expect(seller).toMatchObject({ type: NotificationType.FINAL_PAYMENT_RECEIVED, dedupeKey: 'FINAL_PAYMENT_RECEIVED:pay-2:seller-1' });
      expect(seller.message).toContain(text);
      // A conclusão vai na própria mensagem do pagamento, sem notificação de status duplicada ao vendedor.
      expect(seller.message).toContain('O pedido agora está: Concluído.');
      expect(createdInputs(prisma).filter((n) => n.userId === 'seller-1')).toHaveLength(1);
    });

    it('propaga a falha (roda dentro da transação do pagamento, que precisa ser reprocessada)', async () => {
      prisma.saleData.findUnique.mockResolvedValue(saleContext() as never);
      prisma.notification.createMany.mockRejectedValue(new Error('db down'));

      await expect(service.notifyPaymentCompleted(prisma as never, {
        paymentId: 'pay-1', saleId: SALE_ID, phase: 'down_payment', amount: 300, status: 'Entrada confirmada',
      })).rejects.toThrow('db down');
    });
  });

  describe('sendProductHarvestReminders', () => {
    // 14/10/2026 10:00 em Brasília (13:00 UTC)
    const NOW = new Date('2026-10-14T13:00:00Z');

    it('consulta anúncios ativos com estoque e colheita entre 1 e 5 dias no calendário de Brasília', async () => {
      prisma.product.findMany.mockResolvedValue([]);

      await service.sendProductHarvestReminders(NOW);

      expect(prisma.product.findMany.mock.calls[0][0]?.where).toEqual({
        status: true,
        stock: { gt: 0 },
        harvestAt: {
          gte: new Date('2026-10-15T03:00:00Z'), // 15/10 00:00 Brasília
          lt: new Date('2026-10-20T03:00:00Z'), // 20/10 00:00 Brasília (exclusivo)
        },
      });
    });

    it('calcula os dias restantes pelo fuso de Brasília e deduplica por produto + data de colheita', async () => {
      prisma.product.findMany.mockResolvedValue([
        {
          id: 'product-1',
          sellerId: 'seller-1',
          name: 'Tomate',
          variety: 'Italiano',
          // 19/10 22:30 em Brasília — no UTC já é dia 20, mas a colheita é dia 19 (faltam 5 dias)
          harvestAt: new Date('2026-10-20T01:30:00Z'),
        },
      ] as never);

      const count = await service.sendProductHarvestReminders(NOW);

      expect(count).toBe(1);
      const [input] = createdInputs(prisma);
      expect(input).toMatchObject({
        userId: 'seller-1',
        type: NotificationType.PRODUCT_HARVEST_REMINDER,
        productId: 'product-1',
        dedupeKey: 'PRODUCT_HARVEST_REMINDER:product-1:2026-10-19',
        data: expect.objectContaining({ role: 'seller', productId: 'product-1', daysLeft: 5 }),
      });
      expect(input.saleId).toBeUndefined();
      expect(input.message).toContain('Faltam 5 dias para a colheita de Tomate (Italiano), prevista para 19/10/2026.');
    });
  });

  describe('leitura', () => {
    it('markAsRead retorna false para notificação de outro usuário, sem atualizar nada', async () => {
      prisma.notification.findFirst.mockResolvedValue(null);

      await expect(service.markAsRead('user-1', 'n-1')).resolves.toBe(false);
      expect(prisma.notification.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'n-1', userId: 'user-1' } }));
      expect(prisma.notification.update).not.toHaveBeenCalled();
    });

    it('list devolve nextCursor quando há mais itens que o limite', async () => {
      prisma.notification.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }] as never);
      prisma.notification.count.mockResolvedValue(7);

      const result = await service.list('user-1', { limit: 2 });

      expect(prisma.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
      expect(result).toEqual({ items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'b', unreadCount: 7 });
    });
  });
});
