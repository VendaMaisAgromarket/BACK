import { CertificationDocumentType, CertificationEventAction, CertificationStatus, PrismaClient } from '@prisma/client';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import {
  approvalSummary,
  certificateSnapshot,
  documentAddedEvents,
  SYSTEM_ACTOR,
  toHistoryEvent,
} from '../certification.shared';
import { FarmCertificationService } from '../farmCertification.service';
import { HarvestCertificationService } from '../harvestCertification.service';
import { CertificationError } from '../certification.errors';
import { UploadS3Service } from '../../upload-S3/uploadS3.service';
import { NotificationService } from '../../notification/notification.service';
import { brasiliaDateFromKey } from '../../../lib/brasiliaTime';

const NOW = new Date('2026-11-24T15:00:00Z');
const date = (key: string) => brasiliaDateFromKey(key)!;
const OWNER = { userId: 'producer-1', role: 'producer' };
const ADMIN = { userId: 'admin-1', role: 'admin' };

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    action: CertificationEventAction.SUBMITTED,
    fromStatus: null,
    toStatus: CertificationStatus.PENDING,
    actorId: 'u1',
    actorName: 'João',
    actorRole: 'producer',
    revision: 0,
    note: null,
    details: null,
    createdAt: NOW,
    document: null,
    ...overrides,
  } as Parameters<typeof toHistoryEvent>[0];
}

describe('helpers do histórico', () => {
  it('documentAddedEvents: um evento por arquivo, em ordem, com retrato do autor, revisão e dados do arquivo', () => {
    const docs = [
      { id: 'd1', docType: CertificationDocumentType.CERTIFICATE, s3Key: 'k1', originalName: 'cert.pdf', mimeType: 'application/pdf', sizeBytes: 10 },
      { id: 'd2', docType: CertificationDocumentType.AUDIT_REPORT, s3Key: 'k2', originalName: 'laudo.pdf', mimeType: 'application/pdf', sizeBytes: 20 },
    ];
    const events = documentAddedEvents('c1', docs, { id: 'u1', name: 'João', role: 'buyer' }, 3, NOW);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      certificationId: 'c1',
      action: 'DOCUMENT_ADDED',
      fromStatus: 'PENDING',
      toStatus: 'PENDING',
      actorId: 'u1',
      actorName: 'João',
      actorRole: 'buyer',
      revision: 3,
      documentId: 'd1',
      details: { originalName: 'cert.pdf', docType: 'CERTIFICATE', mimeType: 'application/pdf', sizeBytes: 10 },
    });
    // Ordem estável depois do evento de envio (que fica em NOW).
    expect(events[0].createdAt.getTime()).toBe(NOW.getTime() + 1);
    expect(events[1].createdAt.getTime()).toBe(NOW.getTime() + 2);
    expect(events[1]).not.toHaveProperty('s3Key');
  });

  it('certificateSnapshot: "quem certificou" no momento', () => {
    expect(
      certificateSnapshot({
        certifierName: 'Cert X',
        certifierCnpj: '11.222.333/0001-81',
        certificateNumber: 'N1',
        issuedAt: date('2026-01-10'),
        validUntil: date('2027-01-10'),
      })
    ).toEqual({
      certifierName: 'Cert X',
      certifierCnpj: '11.222.333/0001-81',
      certificateNumber: 'N1',
      issuedAt: '2026-01-10T03:00:00.000Z',
      validUntil: '2027-01-10T03:00:00.000Z',
    });
  });

  it('toHistoryEvent: autor vem do retrato; sistema = actor null', () => {
    expect(toHistoryEvent(event())).toMatchObject({ performedBy: 'producer', actor: { id: 'u1', name: 'João', role: 'producer' } });
    const system = toHistoryEvent(event({ actorId: null, actorName: 'Sistema', actorRole: 'system', action: 'EXPIRED' }));
    expect(system).toMatchObject({ performedBy: 'system', actor: null });
    expect(system).not.toHaveProperty('actorName');
  });

  describe('approvalSummary', () => {
    const current = { certifierName: 'Atual', certifierCnpj: '00.000.000/0001-00', certificateNumber: 'ATUAL', validUntil: date('2028-01-01') };

    it('usa a aprovação mais recente: quando, quem deu o aval, documento, revisão e quem certificou (retrato)', () => {
      const summary = approvalSummary(
        [
          event({ id: 'a1', action: 'APPROVED', actorId: 'adm-old', actorName: 'Ana', revision: 0, createdAt: date('2026-02-01'), details: { certifierName: 'Velha' } }),
          event({ id: 'r1', action: 'REVOKED', actorId: 'adm', actorName: 'Bia' }),
          event({
            id: 'a2',
            action: 'APPROVED',
            actorId: 'adm',
            actorName: 'Bia',
            actorRole: 'admin',
            revision: 2,
            createdAt: date('2026-03-01'),
            note: 'ok',
            document: { id: 'd9', docType: 'CERTIFICATE', originalName: 'c.pdf' },
            details: { certifierName: 'Cert X', certifierCnpj: '11.222.333/0001-81', certificateNumber: 'N1', validUntil: '2027-01-10T03:00:00.000Z' },
          }),
        ],
        current
      );
      expect(summary).toEqual({
        approvedAt: date('2026-03-01'),
        approvedBy: { id: 'adm', name: 'Bia' },
        revision: 2,
        document: { id: 'd9', docType: 'CERTIFICATE', originalName: 'c.pdf' },
        note: 'ok',
        certifiedBy: { certifierName: 'Cert X', certifierCnpj: '11.222.333/0001-81', certificateNumber: 'N1', validUntil: '2027-01-10T03:00:00.000Z' },
      });
    });

    it('evento antigo sem retrato: usa os dados atuais da certificação', () => {
      const summary = approvalSummary([event({ action: 'APPROVED', details: null, revision: null })], current);
      expect(summary?.certifiedBy).toEqual({
        certifierName: 'Atual',
        certifierCnpj: '00.000.000/0001-00',
        certificateNumber: 'ATUAL',
        validUntil: current.validUntil.toISOString(),
      });
    });

    it('nunca aprovada: null', () => {
      expect(approvalSummary([event(), event({ action: 'REJECTED' })], current)).toBeNull();
    });
  });
});

describe('o que cada ação grava no histórico', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let uploads: { upload: jest.Mock; deleteModuleOwnedUpload: jest.Mock; getSignedReadUrl: jest.Mock };
  let notifications: Record<string, jest.Mock>;
  let farm: FarmCertificationService;
  let harvest: HarvestCertificationService;

  const farmBody = {
    farmName: 'Fazenda Boa Vista',
    city: 'Uberlândia',
    uf: 'MG',
    ccir: '950.123.456.789-0',
    areaHectares: '12.5',
    type: 'ORGANIC_SISORG',
    certifierName: 'Certificadora X',
    certifierCnpj: '11222333000181',
    certificateNumber: 'ORG-1',
    issuedAt: '2026-01-10',
    validUntil: '2027-12-31',
  };
  const file = (name: string) => ({ originalname: name, mimetype: 'application/pdf', size: 100, buffer: Buffer.from('x') }) as Express.Multer.File;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    prisma.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) => fn(prisma)) as never);
    prisma.user.findUnique.mockResolvedValue({ id: OWNER.userId, name: 'João Produtor', role: 'producer' } as never);
    prisma.farmCertification.findFirst.mockResolvedValue(null);
    prisma.farmCertification.updateMany.mockResolvedValue({ count: 1 });
    prisma.harvestCertification.findFirst.mockResolvedValue(null);
    let n = 0;
    uploads = {
      upload: jest.fn(async (_f: unknown, prefix: string) => ({ key: `${prefix}/k${++n}`, url: '', publicUrl: '' })),
      deleteModuleOwnedUpload: jest.fn(),
      getSignedReadUrl: jest.fn(),
    };
    notifications = {
      notifyFarmCertificationSubmitted: jest.fn(),
      notifyFarmCertification: jest.fn(),
      notifyHarvestCertificationSubmitted: jest.fn(),
      notifyHarvestCertification: jest.fn(),
    };
    farm = new FarmCertificationService(prisma as unknown as PrismaClient, uploads as unknown as UploadS3Service, notifications as unknown as NotificationService);
    harvest = new HarvestCertificationService(prisma as unknown as PrismaClient, uploads as unknown as UploadS3Service, notifications as unknown as NotificationService);
    jest.spyOn(farm, 'getById').mockResolvedValue({} as never);
    jest.spyOn(harvest, 'getById').mockResolvedValue({} as never);
  });

  it('envio: SUBMITTED com autor, revisão 0 e "quem certificou"; um DOCUMENT_ADDED por arquivo', async () => {
    await farm.create(OWNER, farmBody, [file('cert.pdf'), file('laudo.pdf')], NOW);

    expect(prisma.farmCertificationEvent.create.mock.calls[0][0].data).toMatchObject({
      action: 'SUBMITTED',
      actorId: OWNER.userId,
      actorName: 'João Produtor',
      actorRole: 'producer',
      revision: 0,
      createdAt: NOW,
      details: { certifierName: 'Certificadora X', certifierCnpj: '11.222.333/0001-81', certificateNumber: 'ORG-1' },
    });
    const added = prisma.farmCertificationEvent.createMany.mock.calls[0][0]!.data as Array<Record<string, unknown>>;
    expect(added.map((e) => e.action)).toEqual(['DOCUMENT_ADDED', 'DOCUMENT_ADDED']);
    expect(added.map((e) => (e.details as { originalName: string }).originalName)).toEqual(['cert.pdf', 'laudo.pdf']);
  });

  it('reenvio: RESUBMITTED com a revisão nova; DOCUMENT_ADDED só se houver arquivo novo', async () => {
    prisma.farmCertification.findUnique.mockResolvedValue({ id: 'c1', userId: OWNER.userId, status: 'REJECTED', revision: 4, _count: { documents: 1 } } as never);
    prisma.farmCertificationDocument.count.mockResolvedValue(2);

    await farm.resubmit(OWNER, 'c1', farmBody, [], NOW);
    expect(prisma.farmCertificationEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'RESUBMITTED', revision: 5, actorName: 'João Produtor' });
    expect(prisma.farmCertificationEvent.createMany).not.toHaveBeenCalled();

    await farm.resubmit(OWNER, 'c1', farmBody, [file('novo.pdf')], NOW);
    const added = prisma.farmCertificationEvent.createMany.mock.calls[0][0]!.data as Array<Record<string, unknown>>;
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ action: 'DOCUMENT_ADDED', revision: 5 });
  });

  it('aprovação: "quem deu o aval" (nome do admin), revisão aprovada, documento e "quem certificou"', async () => {
    prisma.farmCertification.findUnique.mockResolvedValue({
      id: 'c1',
      userId: OWNER.userId,
      farmName: 'F',
      status: 'PENDING',
      revision: 2,
      validUntil: date('2027-12-31'),
      certifierName: 'Certificadora X',
      certifierCnpj: '11.222.333/0001-81',
      certificateNumber: 'ORG-1',
      issuedAt: date('2026-01-10'),
      documents: [{ id: 'd1', docType: 'CERTIFICATE' }],
    } as never);
    prisma.user.findUnique.mockResolvedValue({ name: 'Bia Admin' } as never);

    await farm.approve(ADMIN, 'c1', { revision: 2 }, NOW);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: ADMIN.userId }, select: { name: true } });
    expect(prisma.farmCertificationEvent.create.mock.calls[0][0].data).toMatchObject({
      action: 'APPROVED',
      actorId: ADMIN.userId,
      actorName: 'Bia Admin',
      actorRole: 'admin',
      revision: 2,
      documentId: 'd1',
      createdAt: NOW,
      details: { certifierName: 'Certificadora X', certificateNumber: 'ORG-1', validUntil: '2027-12-31T03:00:00.000Z' },
    });
  });

  it('vencimento: autor "Sistema" e a revisão vigente', async () => {
    prisma.farmCertification.findMany.mockResolvedValue([{ id: 'c1', userId: 'u1', farmName: 'F', validUntil: date('2026-11-20'), revision: 3 }] as never);
    await farm.expireOverdue(NOW);
    expect(prisma.farmCertificationEvent.create.mock.calls[0][0].data).toMatchObject({
      action: 'EXPIRED',
      ...{ actorId: SYSTEM_ACTOR.id, actorName: 'Sistema', actorRole: 'system' },
      revision: 3,
    });
  });

  it('safra: envio também grava DOCUMENT_ADDED por arquivo', async () => {
    await harvest.create(
      OWNER,
      {
        harvestSeason: '2026/27',
        crop: 'Tomate',
        plotIdentifier: 'T3',
        plantedAreaHectares: '4',
        estimatedProduction: '100',
        productionUnit: 'TON',
        plantingDate: '2026-08-01',
        harvestDate: '2026-12-10',
        type: 'ORGANIC',
        certifierName: 'Cert X',
        certifierCnpj: '11222333000181',
        certificateNumber: 'H1',
        issuedAt: '2026-10-01',
        validUntil: '2027-03-31',
      },
      [file('laudo.pdf')],
      NOW
    );
    expect(prisma.harvestCertificationEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'SUBMITTED', revision: 0, actorRole: 'producer' });
    expect((prisma.harvestCertificationEvent.createMany.mock.calls[0][0]!.data as unknown[]).length).toBe(1);
  });

  describe('detalhe', () => {
    beforeEach(() => (farm.getById as jest.Mock).mockRestore());

    it('traz eventos no formato do histórico e o resumo da aprovação', async () => {
      prisma.farmCertification.findUnique.mockResolvedValue({
        id: 'c1',
        userId: OWNER.userId,
        status: 'APPROVED',
        validUntil: date('2027-12-31'),
        certifierName: 'Cert',
        certifierCnpj: 'X',
        certificateNumber: 'N',
        user: {},
        events: [
          event({ id: 'e1' }),
          event({ id: 'e2', action: 'APPROVED', actorId: 'adm', actorName: 'Bia', actorRole: 'admin', revision: 0 }),
        ],
      } as never);
      const detail = await farm.getById(OWNER, 'c1', NOW);
      expect(detail.events[1]).toMatchObject({ action: 'APPROVED', performedBy: 'admin', actor: { id: 'adm', name: 'Bia' } });
      expect(detail.approval).toMatchObject({ approvedBy: { id: 'adm', name: 'Bia' }, revision: 0 });
      expect(prisma.farmCertification.findUnique.mock.calls[0][0].include).toMatchObject({
        events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      });
    });
  });

  describe('histórico do admin (listHistory)', () => {
    it('filtra por ação, certificação, autor e período (dia final inclusive) e pagina', async () => {
      prisma.farmCertificationEvent.findMany.mockResolvedValue([
        { ...event({ id: 'e3' }), certification: { id: 'c1', farmName: 'F', user: { id: 'u1', name: 'João' } } },
        { ...event({ id: 'e2' }), certification: { id: 'c1', farmName: 'F', user: { id: 'u1', name: 'João' } } },
      ] as never);

      const result = await farm.listHistory({
        action: 'APPROVED',
        certificationId: 'c1',
        actorId: 'adm',
        from: '2026-11-01',
        to: '2026-11-24',
        limit: '1',
        cursor: 'e9',
      });

      const args = prisma.farmCertificationEvent.findMany.mock.calls[0][0]!;
      expect(args.where).toEqual({
        action: 'APPROVED',
        certificationId: 'c1',
        actorId: 'adm',
        createdAt: { gte: date('2026-11-01'), lt: date('2026-11-25') },
      });
      expect(args).toMatchObject({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 2, cursor: { id: 'e9' }, skip: 1 });
      expect(result.nextCursor).toBe('e3');
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ id: 'e3', performedBy: 'producer', certification: { farmName: 'F' } });
      expect(result.items[0]).not.toHaveProperty('actorName');
    });

    it('safra traz o resumo da safra em cada evento', async () => {
      prisma.harvestCertificationEvent.findMany.mockResolvedValue([] as never);
      await harvest.listHistory({});
      const select = prisma.harvestCertificationEvent.findMany.mock.calls[0][0]!.select as { certification: { select: Record<string, unknown> } };
      expect(select.certification.select).toMatchObject({ crop: true, harvestSeason: true, plotIdentifier: true, certifierName: true });
    });

    it.each([
      [{ action: 'INVENTADA' }],
      [{ from: '2026-11-10', to: '2026-11-01' }],
      [{ from: '2026-13-01' }],
      [{ limit: '500' }],
    ])('filtro inválido é 400 (%o)', async (query) => {
      const err = await farm.listHistory(query).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CertificationError);
      expect((err as CertificationError).status).toBe(400);
    });
  });
});
