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
const P2025 = Object.assign(new Error('Record to update not found'), { code: 'P2025' });

function saleAt(status: string, statusVersion: number) {
  return {
    id: SALE_ID,
    status,
    statusVersion,
    originalPlannedHarvestDate: null,
    originalPlannedPickupDate: null,
    originalPlannedDeliveryDate: null,
  };
}

let prisma: DeepMockProxy<PrismaClient>;
let service: SaleService;

beforeEach(() => {
  mockNotifySellerDecision.mockReset();
  mockNotifyStatusChanged.mockReset();
  prisma = mockDeep<PrismaClient>();
  prisma.$transaction.mockImplementation(((cb: (tx: unknown) => unknown) => cb(prisma)) as never);
  service = new SaleService(prisma as unknown as PrismaClient);
});

describe('SaleService.setSellerDecision', () => {
  it('CAS na versão lida, grava versão + 1 e usa essa versão como identidade da notificação', async () => {
    prisma.saleData.findUnique.mockResolvedValue(saleAt('Pedido realizado!', 4) as never);
    prisma.saleData.updateMany.mockResolvedValue({ count: 1 });

    await service.setSellerDecision(SALE_ID, { approved: true });

    const { where, data } = prisma.saleData.updateMany.mock.calls[0][0]!;
    expect(where).toEqual({ id: SALE_ID, statusVersion: 4 });
    expect(data).toMatchObject({ sellerApproved: true, status: 'Aprovado pelo vendedor', statusVersion: 5 });
    expect(mockNotifySellerDecision).toHaveBeenCalledWith(SALE_ID, true, 'Aprovado pelo vendedor', 5);
  });

  it('ABA: leu A (v4), o status foi A→B→A (v6) — a decisão obsoleta NÃO casa e recebe conflito', async () => {
    // A leitura vê 'Pedido realizado!' v4; no banco o status voltou a 'Pedido realizado!', mas em v6.
    // Um CAS só no valor do status casaria; o CAS na versão rejeita.
    prisma.saleData.findUnique.mockResolvedValue(saleAt('Pedido realizado!', 4) as never);
    prisma.saleData.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.setSellerDecision(SALE_ID, { approved: true })).rejects.toThrow('SELLER_DECISION_CONFLICT');
    expect(prisma.saleData.updateMany.mock.calls[0][0]!.where).toEqual({ id: SALE_ID, statusVersion: 4 });
    expect(mockNotifySellerDecision).not.toHaveBeenCalled();
  });

  it('reenviar a mesma decisão (ex.: só datas) não é transição: não incrementa versão, não reseta statusChangedAt nem notifica', async () => {
    prisma.saleData.findUnique.mockResolvedValue(saleAt('Aprovado pelo vendedor', 5) as never);
    prisma.saleData.updateMany.mockResolvedValue({ count: 1 });

    await service.setSellerDecision(SALE_ID, { approved: true, plannedHarvestDate: new Date('2026-11-01T12:00:00Z') });

    const { data } = prisma.saleData.updateMany.mock.calls[0][0]!;
    expect(data).not.toHaveProperty('statusChangedAt');
    expect(data).not.toHaveProperty('statusVersion');
    expect(mockNotifySellerDecision).not.toHaveBeenCalled();
  });

  it('aceitar → recusar → aceitar: cada mudança real notifica, com versões distintas', async () => {
    prisma.saleData.updateMany.mockResolvedValue({ count: 1 });
    prisma.saleData.findUnique
      .mockResolvedValueOnce(saleAt('Pedido realizado!', 1) as never)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(saleAt('Aprovado pelo vendedor', 2) as never)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(saleAt('Recusado pelo vendedor', 3) as never);

    await service.setSellerDecision(SALE_ID, { approved: true });
    await service.setSellerDecision(SALE_ID, { approved: false });
    await service.setSellerDecision(SALE_ID, { approved: true });

    expect(mockNotifySellerDecision.mock.calls.map(([, approved, , version]) => [approved, version])).toEqual([
      [true, 2],
      [false, 3],
      [true, 4],
    ]);
  });
});

describe('SaleService.update (admin)', () => {
  it('mudança de status: CAS na versão lida (não no valor do status) e notifica com a versão gravada', async () => {
    prisma.saleData.findUnique.mockResolvedValue({ status: 'Em trânsito', statusVersion: 9 } as never);
    prisma.saleData.update.mockResolvedValue({ id: SALE_ID, status: 'Entregue', statusVersion: 10 } as never);

    await service.update(SALE_ID, { status: 'Entregue' } as never);

    const { where, data } = prisma.saleData.update.mock.calls[0][0]!;
    expect(where).toEqual({ id: SALE_ID, statusVersion: 9 });
    expect(data).toMatchObject({ status: 'Entregue', statusVersion: 10 });
    expect(mockNotifyStatusChanged).toHaveBeenCalledWith(SALE_ID, 'Entregue', 10);
  });

  it('versão mudou desde a leitura (inclusive A→B→A): SALE_STATUS_CONFLICT, sem notificar', async () => {
    prisma.saleData.findUnique.mockResolvedValue({ status: 'Em trânsito', statusVersion: 9 } as never);
    prisma.saleData.update.mockRejectedValue(P2025);

    await expect(service.update(SALE_ID, { status: 'Entregue' } as never)).rejects.toThrow('SALE_STATUS_CONFLICT');
    expect(mockNotifyStatusChanged).not.toHaveBeenCalled();
  });

  it('update sem mudança de status não usa CAS nem mexe na versão', async () => {
    prisma.saleData.update.mockResolvedValue({ id: SALE_ID } as never);

    await service.update(SALE_ID, { technicalSpec: 'calibre 12' } as never);

    const { where, data } = prisma.saleData.update.mock.calls[0][0]!;
    expect(where).toEqual({ id: SALE_ID });
    expect(data).not.toHaveProperty('statusVersion');
  });
});

describe('SaleService.authorizeHarvest', () => {
  const eligible = { id: SALE_ID, downPaymentCompleted: true, sellerApproved: true };

  it('CAS na versão lida e notifica com a versão gravada', async () => {
    prisma.saleData.findUnique.mockResolvedValue({ ...eligible, status: 'Entrada confirmada', statusVersion: 6 } as never);
    prisma.saleData.update.mockResolvedValue({ id: SALE_ID } as never);

    await service.authorizeHarvest(SALE_ID);

    const { where, data } = prisma.saleData.update.mock.calls[0][0]!;
    expect(where).toEqual({ id: SALE_ID, statusVersion: 6 });
    expect(data).toMatchObject({ status: 'Colheita autorizada', statusVersion: 7 });
    expect(mockNotifyStatusChanged).toHaveBeenCalledWith(SALE_ID, 'Colheita autorizada', 7);
  });

  it('já autorizada: idempotente — não atualiza nem notifica de novo', async () => {
    prisma.saleData.findUnique.mockResolvedValue({ ...eligible, status: 'Colheita autorizada', statusVersion: 7 } as never);

    await service.authorizeHarvest(SALE_ID);

    expect(prisma.saleData.update).not.toHaveBeenCalled();
    expect(mockNotifyStatusChanged).not.toHaveBeenCalled();
  });

  it('versão mudou desde a leitura das pré-condições: SALE_STATUS_CONFLICT, sem notificar', async () => {
    prisma.saleData.findUnique.mockResolvedValue({ ...eligible, status: 'Entrada confirmada', statusVersion: 6 } as never);
    prisma.saleData.update.mockRejectedValue(P2025);

    await expect(service.authorizeHarvest(SALE_ID)).rejects.toThrow('SALE_STATUS_CONFLICT');
    expect(mockNotifyStatusChanged).not.toHaveBeenCalled();
  });
});

describe('transições com guard na escrita (incremento atômico de versão)', () => {
  /** Simula o UPDATE condicional + leitura da versão gravada dentro da mesma transação. */
  function guardedWrite(count: number, writtenVersion = 12) {
    prisma.saleData.updateMany.mockResolvedValueOnce({ count });
    if (count === 1) prisma.saleData.findUnique.mockResolvedValueOnce({ statusVersion: writtenVersion } as never);
  }

  describe('processTacitAcceptance', () => {
    const planned = new Date('2026-01-05T12:00:00Z'); // segunda; +1 dia útil já venceu
    const sale = { id: SALE_ID, status: 'Em trânsito', plannedDeliveryDate: planned, actualDeliveryDate: null };

    it('aplica com guard "sem entrega", incrementa a versão e notifica com a versão gravada', async () => {
      prisma.saleData.findUnique.mockResolvedValueOnce(sale as never);
      guardedWrite(1, 12);

      const result = await service.processTacitAcceptance(SALE_ID);

      const { where, data } = prisma.saleData.updateMany.mock.calls[0][0]!;
      expect(where).toEqual({ id: SALE_ID, actualDeliveryDate: null });
      expect(data).toMatchObject({ status: 'Concluído', statusVersion: { increment: 1 } });
      expect(result).toMatchObject({ applied: true });
      expect(mockNotifyStatusChanged).toHaveBeenCalledWith(SALE_ID, 'Concluído', 12);
    });

    it('execução concorrente que perdeu a corrida: não aplica nem notifica', async () => {
      prisma.saleData.findUnique.mockResolvedValueOnce(sale as never);
      guardedWrite(0);

      await expect(service.processTacitAcceptance(SALE_ID)).resolves.toEqual({ applied: false, reason: 'Entrega já registrada' });
      expect(mockNotifyStatusChanged).not.toHaveBeenCalled();
    });
  });

  describe('uploadOperationDocument (canhoto)', () => {
    it('só o canhoto que efetiva a entrega notifica, com a versão que ele gravou', async () => {
      const sale = { id: SALE_ID, plannedDeliveryDate: null, actualDeliveryDate: null };
      prisma.operationDocument.create.mockResolvedValue({ id: 'doc-1' } as never);
      const params = { saleId: SALE_ID, uploadedById: 'seller-1', docType: 'canhoto_nf', fileUrl: 'https://x/canhoto.pdf' };

      prisma.saleData.findUnique.mockResolvedValueOnce(sale as never);
      guardedWrite(1, 15);
      await service.uploadOperationDocument(params);

      prisma.saleData.findUnique.mockResolvedValueOnce(sale as never);
      guardedWrite(0);
      await service.uploadOperationDocument(params);

      expect(prisma.saleData.updateMany.mock.calls[0][0]!.where).toEqual({ id: SALE_ID, actualDeliveryDate: null });
      expect(mockNotifyStatusChanged).toHaveBeenCalledTimes(1);
      expect(mockNotifyStatusChanged).toHaveBeenCalledWith(SALE_ID, 'Entregue', 15);
    });
  });

  describe('applyPenalty', () => {
    const sale = { id: SALE_ID, status: 'Aguardando pagamento final', paymentCompleted: false, penaltyApplied: false };

    it('guard na escrita inclui paymentCompleted=false; notifica com a versão gravada', async () => {
      prisma.saleData.findUnique.mockResolvedValueOnce(sale as never);
      guardedWrite(1, 20);
      prisma.saleData.findUnique.mockResolvedValueOnce({ id: SALE_ID } as never);

      await service.applyPenalty(SALE_ID, { reason: 'inadimplência' });

      expect(prisma.saleData.updateMany.mock.calls[0][0]!.where).toEqual({ id: SALE_ID, penaltyApplied: false, paymentCompleted: false });
      expect(mockNotifyStatusChanged).toHaveBeenCalledWith(SALE_ID, 'Cancelado', 20);
    });

    it('pagamento final confirmado entre a leitura e a escrita: PENALTY_BLOCKED, sem cancelar nem notificar', async () => {
      prisma.saleData.findUnique.mockResolvedValueOnce(sale as never);
      guardedWrite(0);
      prisma.saleData.findUnique.mockResolvedValueOnce({ paymentCompleted: true } as never);

      await expect(service.applyPenalty(SALE_ID, { reason: 'inadimplência' })).rejects.toThrow('PENALTY_BLOCKED:');
      expect(mockNotifyStatusChanged).not.toHaveBeenCalled();
    });

    it('multa simultânea que perdeu a corrida: PENALTY_ALREADY_APPLIED, sem notificar', async () => {
      prisma.saleData.findUnique.mockResolvedValueOnce(sale as never);
      guardedWrite(0);
      prisma.saleData.findUnique.mockResolvedValueOnce({ paymentCompleted: false } as never);

      await expect(service.applyPenalty(SALE_ID, { reason: 'inadimplência' })).rejects.toThrow('PENALTY_ALREADY_APPLIED');
      expect(mockNotifyStatusChanged).not.toHaveBeenCalled();
    });
  });
});
