import { PrismaClient } from '@prisma/client';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';

const mockNotifySellerDecision = jest.fn();
const mockNotifyStatusChanged = jest.fn();
jest.mock('../../notification/notification.service', () => ({
  NotificationService: jest.fn().mockImplementation(() => ({
    notifySellerDecision: mockNotifySellerDecision,
    notifyStatusChanged: mockNotifyStatusChanged,
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

describe('SaleService — transições de status idempotentes (compare-and-set + identidade da transição)', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let service: SaleService;
  const P2025 = Object.assign(new Error('Record to update not found'), { code: 'P2025' });

  beforeEach(() => {
    mockNotifyStatusChanged.mockReset();
    prisma = mockDeep<PrismaClient>();
    prisma.$transaction.mockImplementation(((cb: (tx: unknown) => unknown) => cb(prisma)) as never);
    service = new SaleService(prisma as unknown as PrismaClient);
  });

  describe('processTacitAcceptance', () => {
    const planned = new Date('2026-01-05T12:00:00Z'); // segunda; +1 dia útil já venceu

    it('aplica o aceite com CAS em actualDeliveryDate e notifica com o statusChangedAt gravado (prazo tácito)', async () => {
      prisma.saleData.findUnique.mockResolvedValue({ id: SALE_ID, status: 'Em trânsito', plannedDeliveryDate: planned, actualDeliveryDate: null } as never);
      prisma.saleData.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.processTacitAcceptance(SALE_ID);

      const { where, data } = prisma.saleData.updateMany.mock.calls[0][0]!;
      expect(where).toEqual({ id: SALE_ID, actualDeliveryDate: null });
      expect(result).toMatchObject({ applied: true });
      expect(mockNotifyStatusChanged).toHaveBeenCalledWith(SALE_ID, 'Concluído', data!.statusChangedAt);
    });

    it('execução concorrente que perdeu a corrida (entrega já gravada): não aplica nem notifica', async () => {
      prisma.saleData.findUnique.mockResolvedValue({ id: SALE_ID, status: 'Em trânsito', plannedDeliveryDate: planned, actualDeliveryDate: null } as never);
      prisma.saleData.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.processTacitAcceptance(SALE_ID);

      expect(result).toEqual({ applied: false, reason: 'Entrega já registrada' });
      expect(mockNotifyStatusChanged).not.toHaveBeenCalled();
    });
  });

  describe('uploadOperationDocument (canhoto)', () => {
    it('só o canhoto que efetiva a entrega (CAS) notifica, com o mesmo instante gravado', async () => {
      prisma.saleData.findUnique.mockResolvedValue({ id: SALE_ID, plannedDeliveryDate: null, actualDeliveryDate: null } as never);
      prisma.operationDocument.create.mockResolvedValue({ id: 'doc-1' } as never);
      prisma.saleData.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

      const params = { saleId: SALE_ID, uploadedById: 'seller-1', docType: 'canhoto_nf', fileUrl: 'https://x/canhoto.pdf' };
      await service.uploadOperationDocument(params);
      await service.uploadOperationDocument(params);

      expect(prisma.saleData.updateMany.mock.calls[0][0]!.where).toEqual({ id: SALE_ID, actualDeliveryDate: null });
      const deliveredAt = prisma.saleData.updateMany.mock.calls[0][0]!.data!.statusChangedAt;
      expect(mockNotifyStatusChanged).toHaveBeenCalledTimes(1);
      expect(mockNotifyStatusChanged).toHaveBeenCalledWith(SALE_ID, 'Entregue', deliveredAt);
    });
  });

  describe('authorizeHarvest', () => {
    const eligible = { id: SALE_ID, downPaymentCompleted: true, sellerApproved: true };

    it('CAS no status lido e notifica com o statusChangedAt gravado', async () => {
      prisma.saleData.findUnique.mockResolvedValue({ ...eligible, status: 'Entrada confirmada' } as never);
      prisma.saleData.update.mockResolvedValue({ id: SALE_ID } as never);

      await service.authorizeHarvest(SALE_ID);

      const { where, data } = prisma.saleData.update.mock.calls[0][0]!;
      expect(where).toEqual({ id: SALE_ID, status: 'Entrada confirmada' });
      expect(mockNotifyStatusChanged).toHaveBeenCalledWith(SALE_ID, 'Colheita autorizada', data.statusChangedAt);
    });

    it('já autorizada: idempotente — não atualiza nem notifica de novo', async () => {
      prisma.saleData.findUnique.mockResolvedValue({ ...eligible, status: 'Colheita autorizada' } as never);

      await service.authorizeHarvest(SALE_ID);

      expect(prisma.saleData.update).not.toHaveBeenCalled();
      expect(mockNotifyStatusChanged).not.toHaveBeenCalled();
    });

    it('autorização simultânea que perdeu a corrida: SALE_STATUS_CONFLICT, sem notificar', async () => {
      prisma.saleData.findUnique.mockResolvedValue({ ...eligible, status: 'Entrada confirmada' } as never);
      prisma.saleData.update.mockRejectedValue(P2025);

      await expect(service.authorizeHarvest(SALE_ID)).rejects.toThrow('SALE_STATUS_CONFLICT');
      expect(mockNotifyStatusChanged).not.toHaveBeenCalled();
    });
  });

  describe('applyPenalty', () => {
    it('multa simultânea que perdeu a corrida (CAS em penaltyApplied): PENALTY_ALREADY_APPLIED, sem notificar', async () => {
      prisma.saleData.findUnique.mockResolvedValue({ id: SALE_ID, status: 'Aguardando pagamento final', paymentCompleted: false, penaltyApplied: false } as never);
      prisma.saleData.update.mockRejectedValue(P2025);

      await expect(service.applyPenalty(SALE_ID, { reason: 'inadimplência' })).rejects.toThrow('PENALTY_ALREADY_APPLIED');
      expect(prisma.saleData.update.mock.calls[0][0]!.where).toEqual({ id: SALE_ID, penaltyApplied: false });
      expect(mockNotifyStatusChanged).not.toHaveBeenCalled();
    });
  });

  describe('update (admin)', () => {
    it('mudança de status usa CAS no status atual e notifica com o statusChangedAt gravado', async () => {
      prisma.saleData.findUnique.mockResolvedValue({ status: 'Em trânsito' } as never);
      prisma.saleData.update.mockResolvedValue({ id: SALE_ID, status: 'Entregue' } as never);

      await service.update(SALE_ID, { status: 'Entregue' } as never);

      const { where, data } = prisma.saleData.update.mock.calls[0][0]!;
      expect(where).toEqual({ id: SALE_ID, status: 'Em trânsito' });
      expect(mockNotifyStatusChanged).toHaveBeenCalledWith(SALE_ID, 'Entregue', data.statusChangedAt);
    });

    it('conflito de status concorrente vira SALE_STATUS_CONFLICT', async () => {
      prisma.saleData.findUnique.mockResolvedValue({ status: 'Em trânsito' } as never);
      prisma.saleData.update.mockRejectedValue(P2025);

      await expect(service.update(SALE_ID, { status: 'Entregue' } as never)).rejects.toThrow('SALE_STATUS_CONFLICT');
      expect(mockNotifyStatusChanged).not.toHaveBeenCalled();
    });
  });
});
