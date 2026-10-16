import { PrismaClient } from '@prisma/client';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';

const mockNotifySellerDecision = jest.fn();
jest.mock('../../notification/notification.service', () => ({
  NotificationService: jest.fn().mockImplementation(() => ({
    notifySellerDecision: mockNotifySellerDecision,
  })),
}));

import { SaleService } from '../sales.service';

const SALE_ID = 'sale-1';

function saleWithStatus(status: string) {
  return {
    id: SALE_ID,
    status,
    originalPlannedHarvestDate: null,
    originalPlannedPickupDate: null,
    originalPlannedDeliveryDate: null,
  };
}

describe('SaleService.setSellerDecision', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let service: SaleService;

  beforeEach(() => {
    mockNotifySellerDecision.mockReset();
    prisma = mockDeep<PrismaClient>();
    service = new SaleService(prisma as unknown as PrismaClient);
  });

  it('efetiva a transição com compare-and-set no status lido e notifica com o statusChangedAt gravado', async () => {
    prisma.saleData.findUnique.mockResolvedValue(saleWithStatus('Pedido realizado!') as never);
    prisma.saleData.updateMany.mockResolvedValue({ count: 1 });

    await service.setSellerDecision(SALE_ID, { approved: true });

    const { where, data } = prisma.saleData.updateMany.mock.calls[0][0]!;
    expect(where).toEqual({ id: SALE_ID, status: 'Pedido realizado!' });
    expect(data).toMatchObject({ sellerApproved: true, status: 'Aprovado pelo vendedor' });
    // A mesma instância gravada é a identidade da transição na notificação.
    expect(mockNotifySellerDecision).toHaveBeenCalledWith(SALE_ID, true, 'Aprovado pelo vendedor', data!.statusChangedAt);
  });

  it('decisão simultânea que perdeu a corrida (status já mudou) falha com conflito e NÃO notifica', async () => {
    prisma.saleData.findUnique.mockResolvedValue(saleWithStatus('Pedido realizado!') as never);
    prisma.saleData.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.setSellerDecision(SALE_ID, { approved: true })).rejects.toThrow('SELLER_DECISION_CONFLICT');
    expect(mockNotifySellerDecision).not.toHaveBeenCalled();
  });

  it('reenviar a mesma decisão (ex.: só datas) não é transição: não reseta statusChangedAt nem notifica', async () => {
    prisma.saleData.findUnique.mockResolvedValue(saleWithStatus('Aprovado pelo vendedor') as never);
    prisma.saleData.updateMany.mockResolvedValue({ count: 1 });

    await service.setSellerDecision(SALE_ID, { approved: true, plannedHarvestDate: new Date('2026-11-01T12:00:00Z') });

    const { data } = prisma.saleData.updateMany.mock.calls[0][0]!;
    expect(data).not.toHaveProperty('statusChangedAt');
    expect(mockNotifySellerDecision).not.toHaveBeenCalled();
  });

  it('aceitar → recusar → aceitar: cada mudança real de decisão notifica', async () => {
    prisma.saleData.updateMany.mockResolvedValue({ count: 1 });
    prisma.saleData.findUnique
      .mockResolvedValueOnce(saleWithStatus('Pedido realizado!') as never)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(saleWithStatus('Aprovado pelo vendedor') as never)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(saleWithStatus('Recusado pelo vendedor') as never);

    await service.setSellerDecision(SALE_ID, { approved: true });
    await service.setSellerDecision(SALE_ID, { approved: false });
    await service.setSellerDecision(SALE_ID, { approved: true });

    expect(mockNotifySellerDecision.mock.calls.map(([, approved]) => approved)).toEqual([true, false, true]);
  });
});
