import { CertificationDocumentType, CertificationStatus, Prisma, PrismaClient } from '@prisma/client';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import {
  cropMatchesProduct,
  harvestLabel,
  HarvestCertificationService,
  toHarvestBadge,
} from '../harvestCertification.service';
import { harvestSeasonYears } from '../harvestCertification.schema';
import { CertificationError } from '../certification.errors';
import { UploadS3Service } from '../../upload-S3/uploadS3.service';
import { buildNotificationLink, NotificationService } from '../../notification/notification.service';
import { brasiliaDateFromKey } from '../../../lib/brasiliaTime';

const NOW = new Date('2026-11-17T15:00:00Z'); // 12:00 em Brasília
const OWNER = { userId: 'producer-1', role: 'producer' };
const ADMIN = { userId: 'admin-1', role: 'admin' };
const CERT_ID = 'hcert-1';
const PRODUCT_ID = 'product-1';
const date = (key: string) => brasiliaDateFromKey(key)!;

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    harvestSeason: '2026/27',
    crop: 'Tomate',
    variety: 'Italiano',
    plotIdentifier: 'Talhão 3',
    plantedAreaHectares: '4.5',
    estimatedProduction: '120',
    productionUnit: 'ton',
    plantingDate: '2026-08-01',
    harvestDate: '2026-12-10',
    type: 'RESIDUE_ANALYSIS',
    certifierName: 'Laboratório Exemplo',
    certifierCnpj: '11222333000181',
    certificateNumber: 'RES-2026-77',
    issuedAt: '2026-10-01',
    validUntil: '2027-03-31',
    ...overrides,
  };
}

function file(name = 'laudo.pdf', mimetype = 'application/pdf'): Express.Multer.File {
  return { originalname: name, mimetype, size: 2048, buffer: Buffer.from('x') } as Express.Multer.File;
}

async function expectError(promise: Promise<unknown>, status: number, message?: RegExp) {
  const err = await promise.then(
    () => { throw new Error('esperava erro'); },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(CertificationError);
  expect((err as CertificationError).status).toBe(status);
  if (message) expect((err as CertificationError).message).toMatch(message);
}

describe('HarvestCertificationService', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let uploads: { upload: jest.Mock; deleteModuleOwnedUpload: jest.Mock; getSignedReadUrl: jest.Mock };
  let notifications: { notifyHarvestCertificationSubmitted: jest.Mock; notifyHarvestCertification: jest.Mock };
  let service: HarvestCertificationService;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    prisma.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) => fn(prisma)) as never);
    prisma.user.findUnique.mockResolvedValue({ id: OWNER.userId, name: 'João Produtor', role: 'producer' } as never);
    prisma.harvestCertification.findFirst.mockResolvedValue(null);
    prisma.harvestCertification.updateMany.mockResolvedValue({ count: 1 });

    let n = 0;
    uploads = {
      upload: jest.fn(async (_f: Express.Multer.File, prefix: string) => ({ key: `${prefix}/k${++n}`, url: '', publicUrl: '' })),
      deleteModuleOwnedUpload: jest.fn().mockResolvedValue({ deleted: true }),
      getSignedReadUrl: jest.fn().mockResolvedValue('https://signed.example/doc'),
    };
    notifications = {
      notifyHarvestCertificationSubmitted: jest.fn().mockResolvedValue(undefined),
      notifyHarvestCertification: jest.fn().mockResolvedValue(undefined),
    };
    service = new HarvestCertificationService(
      prisma as unknown as PrismaClient,
      uploads as unknown as UploadS3Service,
      notifications as unknown as NotificationService
    );
    jest.spyOn(service, 'getById').mockResolvedValue({ id: CERT_ID } as never);
  });

  describe('create', () => {
    it('grava PENDING com os dados da safra normalizados, laudos no prefixo de safra, SUBMITTED e aviso aos admins', async () => {
      await service.create(OWNER, { ...validBody(), documentTypes: ['AUDIT_REPORT', 'CERTIFICATE'] }, [file('relatorio.pdf'), file()], NOW);

      const data = prisma.harvestCertification.create.mock.calls[0][0].data;
      const certId = data.id as string;
      expect(uploads.upload).toHaveBeenCalledWith(expect.anything(), `certifications/harvest/${certId}`);
      expect(data).toMatchObject({
        userId: OWNER.userId,
        harvestSeason: '2026/27',
        crop: 'Tomate',
        variety: 'Italiano',
        plotIdentifier: 'Talhão 3',
        plantedAreaHectares: 4.5,
        estimatedProduction: 120,
        productionUnit: 'TON',
        plantingDate: date('2026-08-01'),
        harvestDate: date('2026-12-10'),
        type: 'RESIDUE_ANALYSIS',
        certifierCnpj: '11.222.333/0001-81',
      });
      const docs = (data.documents as { create: Array<{ id: string; docType: string }> }).create;
      const event = prisma.harvestCertificationEvent.create.mock.calls[0][0].data;
      expect(event).toMatchObject({ certificationId: certId, action: 'SUBMITTED', toStatus: 'PENDING', actorId: OWNER.userId });
      expect(event.documentId).toBe(docs[1].id);
      expect(notifications.notifyHarvestCertificationSubmitted).toHaveBeenCalledWith(
        expect.objectContaining({
          certificationId: certId,
          label: '2026/27 de Tomate Italiano (lote Talhão 3)',
          ownerName: 'João Produtor',
          resubmitted: false,
          eventId: event.id,
        })
      );
    });

    it('variedade vazia vira null', async () => {
      await service.create(OWNER, validBody({ variety: '' }), [file()], NOW);
      expect(prisma.harvestCertification.create.mock.calls[0][0].data.variety).toBeNull();
    });

    it('aceita ano agrícola de um ano só', async () => {
      await service.create(OWNER, validBody({ harvestSeason: '2026' }), [file()], NOW);
      expect(prisma.harvestCertification.create).toHaveBeenCalled();
    });

    it.each([
      [{ harvestSeason: '2026/28' }, /Safra inválida/],
      [{ harvestSeason: '26/27' }, /Safra inválida/],
      [{ harvestSeason: '' }, /Safra inválida/],
      [{ crop: 'T' }, /Cultura é obrigatória/],
      [{ plotIdentifier: '' }, /Talhão\/lote é obrigatório/],
      [{ plantedAreaHectares: '0' }, /Área plantada \(ha\) deve ser maior que zero/],
      [{ estimatedProduction: '-1' }, /Produção estimada deve ser maior que zero/],
      [{ productionUnit: 'sacas' }, /Unidade da produção inválida/],
      [{ plantingDate: '2026-12-11' }, /colheita não pode ser anterior à de plantio/],
      [{ harvestDate: '2028-01-10' }, /não pertence à safra/],
      [{ type: 'BIODINAMICO' }, /Tipo de certificação inválido/],
      [{ certifierCnpj: '11222333000100' }, /CNPJ/],
      [{ issuedAt: '2026-11-18', validUntil: '2027-11-18' }, /futuro/],
      [{ issuedAt: '2026-01-01', validUntil: '2026-11-16' }, /vencido/],
    ])('valida os dados (%o)', async (override, message) => {
      await expectError(service.create(OWNER, validBody(override), [file()], NOW), 400, message);
      expect(uploads.upload).not.toHaveBeenCalled();
    });

    it('comprador que anuncia também envia; admin recebe 403', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'buyer-1', name: 'Maria', role: 'buyer' } as never);
      await service.create({ userId: 'buyer-1', role: 'buyer' }, validBody(), [file()], NOW);
      expect(prisma.harvestCertification.create.mock.calls[0][0].data.userId).toBe('buyer-1');

      prisma.user.findUnique.mockResolvedValue({ id: ADMIN.userId, name: 'Admin', role: 'admin' } as never);
      await expectError(service.create(ADMIN, validBody(), [file()], NOW), 403, /Administradores não podem enviar/);
    });

    it('duplicidade: checagem prévia e índice único (P2002) viram 409; arquivos descartados', async () => {
      prisma.harvestCertification.findFirst.mockResolvedValueOnce({ id: 'x' } as never);
      await expectError(service.create(OWNER, validBody(), [file()], NOW), 409, /já foi enviado/);
      expect(uploads.upload).not.toHaveBeenCalled();

      prisma.$transaction.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })
      );
      await expectError(service.create(OWNER, validBody(), [file()], NOW), 409, /já foi enviado/);
      expect(uploads.deleteModuleOwnedUpload).toHaveBeenCalledTimes(1);
      expect(notifications.notifyHarvestCertificationSubmitted).not.toHaveBeenCalled();
    });
  });

  describe('resubmit', () => {
    function current(status: CertificationStatus, userId = OWNER.userId) {
      prisma.harvestCertification.findUnique.mockResolvedValue({ id: CERT_ID, userId, status, revision: 1, _count: { documents: 1 } } as never);
      prisma.harvestCertificationDocument.count.mockResolvedValue(2);
    }

    it('recusada volta a PENDING com CAS em status + revisão, revisão incrementada e variedade apagada', async () => {
      current(CertificationStatus.REJECTED);
      await service.resubmit(OWNER, CERT_ID, validBody({ variety: '' }), [file()], NOW);
      expect(prisma.harvestCertification.updateMany).toHaveBeenCalledWith({
        where: { id: CERT_ID, status: 'REJECTED', revision: 1 },
        data: expect.objectContaining({ status: 'PENDING', revision: { increment: 1 }, variety: null, rejectionReason: null }),
      });
      expect(prisma.harvestCertificationEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'RESUBMITTED', fromStatus: 'REJECTED' });
      expect(notifications.notifyHarvestCertificationSubmitted).toHaveBeenCalledWith(expect.objectContaining({ resubmitted: true }));
    });

    it('aprovada não edita (409); de outro dono é 404; alteração concorrente é 409', async () => {
      current(CertificationStatus.APPROVED);
      await expectError(service.resubmit(OWNER, CERT_ID, validBody(), [], NOW), 409);
      current(CertificationStatus.REJECTED, 'outro');
      await expectError(service.resubmit(OWNER, CERT_ID, validBody(), [], NOW), 404);
      current(CertificationStatus.PENDING);
      prisma.harvestCertification.updateMany.mockResolvedValue({ count: 0 });
      await expectError(service.resubmit(OWNER, CERT_ID, validBody(), [file()], NOW), 409);
      expect(uploads.deleteModuleOwnedUpload).toHaveBeenCalledTimes(1);
    });
  });

  describe('avaliação (admin)', () => {
    function pending(overrides: Record<string, unknown> = {}) {
      prisma.harvestCertification.findUnique.mockResolvedValue({
        id: CERT_ID,
        userId: OWNER.userId,
        harvestSeason: '2026/27',
        crop: 'Tomate',
        variety: null,
        plotIdentifier: 'L1',
        status: CertificationStatus.PENDING,
        revision: 2,
        validUntil: date('2027-03-31'),
        documents: [{ id: 'doc-cert', docType: CertificationDocumentType.CERTIFICATE }],
        ...overrides,
      } as never);
    }

    it('aprova com CAS, registra admin e certificado, e avisa o dono com o rótulo da safra', async () => {
      pending();
      await service.approve(ADMIN, CERT_ID, { revision: 2 }, NOW);
      expect(prisma.harvestCertification.updateMany.mock.calls[0][0].where).toEqual({ id: CERT_ID, status: 'PENDING', revision: 2 });
      const event = prisma.harvestCertificationEvent.create.mock.calls[0][0].data;
      expect(event).toMatchObject({ action: 'APPROVED', actorId: ADMIN.userId, documentId: 'doc-cert' });
      expect(notifications.notifyHarvestCertification).toHaveBeenCalledWith('APPROVED', [
        expect.objectContaining({ userId: OWNER.userId, label: '2026/27 de Tomate (lote L1)', dedupeId: event.id }),
      ]);
    });

    it('exige revisão (400 com a mensagem exata) e recusa revisão obsoleta (409)', async () => {
      pending();
      await expectError(service.approve(ADMIN, CERT_ID, {}, NOW), 400, /^Informe a revisão analisada \(revision\)\.$/);
      await expectError(service.reject(ADMIN, CERT_ID, { reason: 'Ilegível' }, NOW), 400, /^Informe a revisão analisada \(revision\)\.$/);
      await expectError(service.approve(ADMIN, CERT_ID, { revision: 1 }, NOW), 409, /alterou/);
      expect(prisma.harvestCertification.updateMany).not.toHaveBeenCalled();
    });

    it('recusa com motivo; revoga só aprovada; não aprova vencida; só admin', async () => {
      pending();
      await service.reject(ADMIN, CERT_ID, { revision: 2, reason: 'Laudo ilegível' }, NOW);
      expect(notifications.notifyHarvestCertification).toHaveBeenCalledWith('REJECTED', [expect.objectContaining({ reason: 'Laudo ilegível' })]);

      pending();
      await expectError(service.revoke(ADMIN, CERT_ID, { reason: 'Fraude' }, NOW), 409);
      pending({ status: CertificationStatus.APPROVED });
      await service.revoke(ADMIN, CERT_ID, { reason: 'Fraude' }, NOW);

      pending({ validUntil: date('2026-11-16') });
      await expectError(service.approve(ADMIN, CERT_ID, { revision: 2 }, NOW), 409, /vencido/);

      await expectError(service.approve(OWNER, CERT_ID, { revision: 2 }, NOW), 403);
    });
  });

  describe('vínculo com anúncios', () => {
    function cert(overrides: Record<string, unknown> = {}) {
      prisma.harvestCertification.findUnique.mockResolvedValue({
        id: CERT_ID,
        userId: OWNER.userId,
        status: CertificationStatus.APPROVED,
        crop: 'Tomate',
        plantingDate: date('2026-08-01'),
        validUntil: date('2027-03-31'),
        ...overrides,
      } as never);
    }
    function product(overrides: Record<string, unknown> = {}) {
      prisma.product.findUnique.mockResolvedValue({
        id: PRODUCT_ID,
        sellerId: OWNER.userId,
        name: 'Tomate Italiano',
        variety: 'Italiano',
        category: 'Hortaliças',
        harvestAt: new Date('2026-12-10T15:00:00Z'),
        ...overrides,
      } as never);
    }

    it('vincula anúncio do mesmo dono, com cultura e colheita dentro do período', async () => {
      cert();
      product();
      await service.linkProduct(OWNER, CERT_ID, PRODUCT_ID, NOW);
      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: PRODUCT_ID }, data: { harvestCertificationId: CERT_ID } })
      );
    });

    it('certificação pendente também vincula (o selo só aparece quando aprovada)', async () => {
      cert({ status: CertificationStatus.PENDING });
      product();
      await service.linkProduct(OWNER, CERT_ID, PRODUCT_ID, NOW);
      expect(prisma.product.update).toHaveBeenCalled();
    });

    it.each([CertificationStatus.REJECTED, CertificationStatus.REVOKED, CertificationStatus.EXPIRED])('%s não vincula (409)', async (status) => {
      cert({ status });
      product();
      await expectError(service.linkProduct(OWNER, CERT_ID, PRODUCT_ID, NOW), 409, /pendentes ou aprovadas/);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('certificação vencida não vincula (409)', async () => {
      cert({ validUntil: date('2026-11-16') });
      product();
      await expectError(service.linkProduct(OWNER, CERT_ID, PRODUCT_ID, NOW), 409, /vencida/);
    });

    it('certificação ou anúncio de outro usuário: 404', async () => {
      cert({ userId: 'outro' });
      product();
      await expectError(service.linkProduct(OWNER, CERT_ID, PRODUCT_ID, NOW), 404, /Certificação/);
      cert();
      product({ sellerId: 'outro' });
      await expectError(service.linkProduct(OWNER, CERT_ID, PRODUCT_ID, NOW), 404, /Anúncio/);
    });

    it('cultura diferente: 400', async () => {
      cert();
      product({ name: 'Alface Crespa', variety: 'Crespa', category: 'Folhosas' });
      await expectError(service.linkProduct(OWNER, CERT_ID, PRODUCT_ID, NOW), 400, /cultura da certificação \(Tomate\) não corresponde/);
    });

    it.each([
      ['antes do plantio', new Date('2026-07-31T15:00:00Z')],
      ['depois da validade', new Date('2027-04-01T15:00:00Z')],
    ])('colheita do anúncio %s: 400', async (_label, harvestAt) => {
      cert();
      product({ harvestAt });
      await expectError(service.linkProduct(OWNER, CERT_ID, PRODUCT_ID, NOW), 400, /fora do período da certificação/);
    });

    it('colheita no último dia de validade ainda vale', async () => {
      cert();
      product({ harvestAt: new Date('2027-03-31T23:00:00-03:00') });
      await service.linkProduct(OWNER, CERT_ID, PRODUCT_ID, NOW);
      expect(prisma.product.update).toHaveBeenCalled();
    });

    it('desvincula só anúncio do dono vinculado a esta certificação', async () => {
      prisma.product.updateMany.mockResolvedValue({ count: 1 });
      await service.unlinkProduct(OWNER, CERT_ID, PRODUCT_ID);
      expect(prisma.product.updateMany).toHaveBeenCalledWith({
        where: { id: PRODUCT_ID, sellerId: OWNER.userId, harvestCertificationId: CERT_ID },
        data: { harvestCertificationId: null },
      });

      prisma.product.updateMany.mockResolvedValue({ count: 0 });
      await expectError(service.unlinkProduct(OWNER, CERT_ID, PRODUCT_ID), 404);
    });

    it('admin não vincula', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: ADMIN.userId, name: 'Admin', role: 'admin' } as never);
      await expectError(service.linkProduct(ADMIN, CERT_ID, PRODUCT_ID, NOW), 403);
    });
  });

  describe('selo do anúncio', () => {
    const linked = {
      id: CERT_ID,
      type: 'ORGANIC',
      certifierName: 'Cert X',
      certificateNumber: 'N1',
      harvestSeason: '2026/27',
      crop: 'Tomate',
      variety: null,
      validUntil: date('2026-11-17'),
      status: CertificationStatus.APPROVED,
    } as const;

    it('ativo: devolve a certificação sem o status interno', () => {
      const badge = toHarvestBadge(linked as never, NOW);
      expect(badge).toMatchObject({ id: CERT_ID, crop: 'Tomate' });
      expect(badge).not.toHaveProperty('status');
    });

    it('pendente, revogada ou vencida: null', () => {
      expect(toHarvestBadge({ ...linked, status: CertificationStatus.PENDING } as never, NOW)).toBeNull();
      expect(toHarvestBadge({ ...linked, status: CertificationStatus.REVOKED } as never, NOW)).toBeNull();
      expect(toHarvestBadge(linked as never, new Date('2026-11-18T03:00:00Z'))).toBeNull();
      expect(toHarvestBadge(null, NOW)).toBeNull();
    });

    it('endpoint público: anúncio inexistente é 404; sem certificação ativa, certified=false', async () => {
      prisma.product.findUnique.mockResolvedValueOnce(null);
      await expectError(service.getProductBadge('nao-existe', NOW), 404);

      prisma.product.findUnique.mockResolvedValueOnce({ id: PRODUCT_ID, harvestCertification: null } as never);
      await expect(service.getProductBadge(PRODUCT_ID, NOW)).resolves.toEqual({ productId: PRODUCT_ID, certified: false, certification: null });

      prisma.product.findUnique.mockResolvedValueOnce({ id: PRODUCT_ID, harvestCertification: linked } as never);
      const result = await service.getProductBadge(PRODUCT_ID, NOW);
      expect(result.certified).toBe(true);
      const select = prisma.product.findUnique.mock.calls[2][0].select as { harvestCertification: { select: Record<string, boolean> } };
      for (const field of ['plotIdentifier', 'plantedAreaHectares', 'estimatedProduction', 'certifierCnpj', 'documents', 'userId']) {
        expect(select.harvestCertification.select).not.toHaveProperty(field);
      }
    });
  });

  describe('leitura', () => {
    beforeEach(() => (service.getById as jest.Mock).mockRestore());

    it('dono vê sem dados pessoais, admin vê com, outros 404; traz anúncios vinculados', async () => {
      prisma.harvestCertification.findUnique.mockResolvedValue({
        id: CERT_ID,
        userId: OWNER.userId,
        status: CertificationStatus.APPROVED,
        validUntil: date('2027-03-31'),
        products: [{ id: PRODUCT_ID }],
        user: { id: OWNER.userId, cpf: '1' },
      } as never);
      const own = await service.getById(OWNER, CERT_ID, NOW);
      expect(own).not.toHaveProperty('user');
      expect(own.products).toEqual([{ id: PRODUCT_ID }]);
      expect(own.badgeActive).toBe(true);
      expect(await service.getById(ADMIN, CERT_ID, NOW)).toHaveProperty('user');
      await expectError(service.getById({ userId: 'x', role: 'buyer' }, CERT_ID, NOW), 404);
    });
  });

  describe('vencimento', () => {
    it('marca EXPIRED com histórico do sistema e avisa; aviso prévio com dedupe por validade', async () => {
      prisma.harvestCertification.findMany.mockResolvedValueOnce([
        { id: 'h1', userId: 'u1', harvestSeason: '2026', crop: 'Milho', variety: null, plotIdentifier: 'A', validUntil: date('2026-11-16') },
      ] as never);
      expect(await service.expireOverdue(NOW)).toBe(1);
      expect(prisma.harvestCertificationEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'EXPIRED', actorId: null });
      expect(notifications.notifyHarvestCertification).toHaveBeenCalledWith('EXPIRED', [
        expect.objectContaining({ certificationId: 'h1', label: '2026 de Milho (lote A)' }),
      ]);

      prisma.harvestCertification.findMany.mockResolvedValueOnce([
        { id: 'h2', userId: 'u2', harvestSeason: '2026', crop: 'Milho', variety: null, plotIdentifier: 'B', validUntil: date('2026-12-01') },
      ] as never);
      await service.sendExpiringReminders(NOW);
      expect(notifications.notifyHarvestCertification).toHaveBeenLastCalledWith('EXPIRING', [
        expect.objectContaining({ certificationId: 'h2', dedupeId: 'h2:2026-12-01' }),
      ]);
    });
  });
});

describe('regras auxiliares da safra', () => {
  it('harvestSeasonYears', () => {
    expect(harvestSeasonYears('2026/27')).toEqual([2026, 2027]);
    expect(harvestSeasonYears('2099/00')).toEqual([2099, 2100]);
    expect(harvestSeasonYears('2026')).toEqual([2026]);
    expect(harvestSeasonYears('2026/28')).toBeNull();
    expect(harvestSeasonYears('2026-27')).toBeNull();
  });

  it('cropMatchesProduct ignora acento e caixa e aceita nome, variedade ou categoria', () => {
    const p = { name: 'Tomate Italiano', variety: 'Italiano', category: 'Hortaliças' };
    expect(cropMatchesProduct('tomate', p)).toBe(true);
    expect(cropMatchesProduct('Tomate Italiano', { ...p, name: 'Tomate' })).toBe(true);
    expect(cropMatchesProduct('Maçã', { name: 'Maca Fuji', variety: 'Fuji', category: 'Frutas' })).toBe(true);
    expect(cropMatchesProduct('Alface', p)).toBe(false);
  });

  it('harvestLabel', () => {
    expect(harvestLabel({ harvestSeason: '2026/27', crop: 'Tomate', variety: 'Italiano', plotIdentifier: 'T3' })).toBe('2026/27 de Tomate Italiano (lote T3)');
  });

  it('link da notificação leva às telas de safra', () => {
    const base = { saleId: null, productId: null };
    expect(buildNotificationLink({ ...base, data: { role: 'admin', scope: 'harvest', certificationId: 'h1' } }, 'https://app')?.url).toBe(
      'https://app/admin/certifications/harvest/h1'
    );
    expect(buildNotificationLink({ ...base, data: { role: 'producer', scope: 'harvest', certificationId: 'h1' } }, 'https://app')?.url).toBe(
      'https://app/market/certifications/harvest'
    );
    // Notificações antigas de fazenda (sem scope) continuam indo para fazenda.
    expect(buildNotificationLink({ ...base, data: { role: 'admin', certificationId: 'f1' } }, 'https://app')?.url).toBe(
      'https://app/admin/certifications/farm/f1'
    );
  });
});
