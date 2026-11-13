import { CertificationDocumentType, CertificationStatus, PrismaClient } from '@prisma/client';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { FarmCertificationService } from '../farmCertification.service';
import { CertificationError } from '../certification.errors';
import { UploadS3Service } from '../../upload-S3/uploadS3.service';
import { NotificationService, buildNotificationLink } from '../../notification/notification.service';
import { brasiliaDateFromKey } from '../../../lib/brasiliaTime';

const NOW = new Date('2026-11-11T15:00:00Z'); // 12:00 em Brasília
const PRODUCER = { userId: 'producer-1', role: 'producer' };
const ADMIN = { userId: 'admin-1', role: 'admin' };
const CERT_ID = 'cert-1';

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    farmName: 'Fazenda Boa Vista',
    city: 'Uberlândia',
    uf: 'mg',
    ccir: '950.123.456.789-0',
    car: '',
    areaHectares: '12.5',
    type: 'ORGANIC_SISORG',
    certifierName: 'Certificadora X',
    certifierCnpj: '11222333000181',
    certificateNumber: 'ORG-2026-001',
    issuedAt: '2026-03-01',
    validUntil: '2027-03-01',
    ...overrides,
  };
}

function file(name = 'certificado.pdf', mimetype = 'application/pdf'): Express.Multer.File {
  return { originalname: name, mimetype, size: 1234, buffer: Buffer.from('x') } as Express.Multer.File;
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

describe('FarmCertificationService', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let uploads: { upload: jest.Mock; delete: jest.Mock; getSignedReadUrl: jest.Mock };
  let notifications: { notifyFarmCertificationSubmitted: jest.Mock; notifyFarmCertification: jest.Mock };
  let service: FarmCertificationService;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    prisma.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) => fn(prisma)) as never);
    prisma.user.findUnique.mockResolvedValue({ id: PRODUCER.userId, name: 'João Produtor', role: 'producer' } as never);
    prisma.farmCertification.findFirst.mockResolvedValue(null);
    prisma.farmCertification.updateMany.mockResolvedValue({ count: 1 });

    let n = 0;
    uploads = {
      upload: jest.fn(async (_f: Express.Multer.File, prefix: string) => ({ key: `${prefix}/k${++n}`, url: '', publicUrl: '' })),
      delete: jest.fn().mockResolvedValue({ deleted: true }),
      getSignedReadUrl: jest.fn().mockResolvedValue('https://signed.example/doc'),
    };
    notifications = {
      notifyFarmCertificationSubmitted: jest.fn().mockResolvedValue(undefined),
      notifyFarmCertification: jest.fn().mockResolvedValue(undefined),
    };
    service = new FarmCertificationService(
      prisma as unknown as PrismaClient,
      uploads as unknown as UploadS3Service,
      notifications as unknown as NotificationService
    );
    jest.spyOn(service, 'getById').mockResolvedValue({ id: CERT_ID } as never);
  });

  describe('create', () => {
    it('grava a certificação PENDING com documentos no prefixo dela, registra SUBMITTED e avisa os admins', async () => {
      await service.create(PRODUCER, { ...validBody(), documentTypes: ['AUDIT_REPORT', 'CERTIFICATE'] }, [file('laudo.pdf'), file()], NOW);

      const createArgs = prisma.farmCertification.create.mock.calls[0][0];
      const certId = createArgs.data.id as string;
      expect(uploads.upload).toHaveBeenCalledWith(expect.anything(), `certifications/farm/${certId}`);
      expect(createArgs.data).toMatchObject({
        userId: PRODUCER.userId,
        uf: 'MG',
        areaHectares: 12.5,
        certifierCnpj: '11.222.333/0001-81',
        issuedAt: brasiliaDateFromKey('2026-03-01'),
        validUntil: brasiliaDateFromKey('2027-03-01'),
      });
      expect(createArgs.data.car).toBeUndefined();
      const docs = (createArgs.data.documents as { create: Array<{ id: string; docType: string; uploadedById: string }> }).create;
      expect(docs.map((d) => d.docType)).toEqual(['AUDIT_REPORT', 'CERTIFICATE']);
      expect(docs.every((d) => d.uploadedById === PRODUCER.userId)).toBe(true);

      const event = prisma.farmCertificationEvent.create.mock.calls[0][0].data;
      expect(event).toMatchObject({ certificationId: certId, action: 'SUBMITTED', toStatus: 'PENDING', actorId: PRODUCER.userId });
      expect(event.documentId).toBe(docs[1].id); // o certificado, não o laudo

      expect(notifications.notifyFarmCertificationSubmitted).toHaveBeenCalledWith(
        expect.objectContaining({ certificationId: certId, producerName: 'João Produtor', resubmitted: false, eventId: event.id })
      );
    });

    it('recusa usuário que não é produtor', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'buyer-1', name: 'B', role: 'buyer' } as never);
      await expectError(service.create({ userId: 'buyer-1', role: 'buyer' }, validBody(), [file()], NOW), 403);
    });

    it.each([
      [{ ccir: '', car: '' }, /CCIR e\/ou o CAR/],
      [{ certifierCnpj: '11222333000100' }, /CNPJ/],
      [{ uf: 'XX' }, /UF inválida/],
      [{ validUntil: '2027-02-30' }, /validade inválida/],
      [{ issuedAt: '2027-04-01', validUntil: '2027-03-01' }, /posterior à emissão/],
      [{ issuedAt: '2026-11-12', validUntil: '2027-11-12' }, /futuro/],
      [{ issuedAt: '2025-01-01', validUntil: '2026-11-10' }, /vencido/],
      [{ type: 'INVENTADO' }, /Tipo de certificação/],
      [{ areaHectares: '0' }, /maior que zero/],
    ])('valida os dados (%o)', async (override, message) => {
      await expectError(service.create(PRODUCER, validBody(override), [file()], NOW), 400, message);
      expect(uploads.upload).not.toHaveBeenCalled();
    });

    it('aceita certificado que vence hoje', async () => {
      await service.create(PRODUCER, validBody({ validUntil: '2026-11-11' }), [file()], NOW);
      expect(prisma.farmCertification.create).toHaveBeenCalled();
    });

    it('exige ao menos um documento e um tipo por arquivo', async () => {
      await expectError(service.create(PRODUCER, validBody(), [], NOW), 400, /ao menos um documento/);
      await expectError(service.create(PRODUCER, { ...validBody(), documentTypes: ['CERTIFICATE'] }, [file(), file()], NOW), 400, /cada arquivo/);
    });

    it('bloqueia o mesmo certificado já pendente ou aprovado', async () => {
      prisma.farmCertification.findFirst.mockResolvedValue({ id: 'other' } as never);
      await expectError(service.create(PRODUCER, validBody(), [file()], NOW), 409);
      expect(prisma.farmCertification.findFirst.mock.calls[0][0]?.where).toMatchObject({
        userId: PRODUCER.userId,
        type: 'ORGANIC_SISORG',
        status: { in: ['PENDING', 'APPROVED'] },
      });
    });

    it('remove do S3 os arquivos enviados se a gravação no banco falhar', async () => {
      prisma.$transaction.mockRejectedValue(new Error('db down'));
      await expect(service.create(PRODUCER, validBody(), [file(), file()], NOW)).rejects.toThrow('db down');
      expect(uploads.delete).toHaveBeenCalledTimes(2);
      expect(notifications.notifyFarmCertificationSubmitted).not.toHaveBeenCalled();
    });

    it('remove os que subiram e devolve 502 se algum upload falhar', async () => {
      uploads.upload.mockResolvedValueOnce({ key: 'certifications/farm/x/ok', url: '', publicUrl: '' }).mockRejectedValueOnce(new Error('s3'));
      await expectError(service.create(PRODUCER, validBody(), [file(), file()], NOW), 502);
      expect(uploads.delete).toHaveBeenCalledWith('certifications/farm/x/ok');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('resubmit', () => {
    function current(status: CertificationStatus, userId = PRODUCER.userId, documents = 1) {
      prisma.farmCertification.findUnique.mockResolvedValue({ id: CERT_ID, userId, status, _count: { documents } } as never);
    }

    it('reenvia uma recusada: volta a PENDING, limpa a avaliação, anexa arquivos e registra RESUBMITTED', async () => {
      current(CertificationStatus.REJECTED);
      await service.resubmit(PRODUCER, CERT_ID, validBody(), [file()], NOW);

      expect(prisma.farmCertification.updateMany).toHaveBeenCalledWith({
        where: { id: CERT_ID, status: 'REJECTED' },
        data: expect.objectContaining({ status: 'PENDING', reviewedById: null, reviewedAt: null, rejectionReason: null, reviewNotes: null }),
      });
      expect(prisma.farmCertificationDocument.createMany).toHaveBeenCalled();
      expect(prisma.farmCertificationEvent.create.mock.calls[0][0].data).toMatchObject({
        action: 'RESUBMITTED',
        fromStatus: 'REJECTED',
        toStatus: 'PENDING',
      });
      expect(prisma.farmCertification.findFirst.mock.calls[0][0]?.where).toMatchObject({ id: { not: CERT_ID } });
      expect(notifications.notifyFarmCertificationSubmitted).toHaveBeenCalledWith(expect.objectContaining({ resubmitted: true }));
    });

    it('permite reenviar sem arquivos novos', async () => {
      current(CertificationStatus.PENDING);
      await service.resubmit(PRODUCER, CERT_ID, validBody(), [], NOW);
      expect(prisma.farmCertificationDocument.createMany).not.toHaveBeenCalled();
      expect(uploads.upload).not.toHaveBeenCalled();
    });

    it('não altera certificação aprovada', async () => {
      current(CertificationStatus.APPROVED);
      await expectError(service.resubmit(PRODUCER, CERT_ID, validBody(), [], NOW), 409);
    });

    it('esconde certificação de outro produtor', async () => {
      current(CertificationStatus.REJECTED, 'other-producer');
      await expectError(service.resubmit(PRODUCER, CERT_ID, validBody(), [], NOW), 404);
    });

    it('respeita o limite total de documentos', async () => {
      current(CertificationStatus.REJECTED, PRODUCER.userId, 14);
      await expectError(service.resubmit(PRODUCER, CERT_ID, validBody(), [file(), file()], NOW), 400, /Limite/);
    });

    it('devolve 409 e descarta os arquivos se um admin avaliou no meio do caminho', async () => {
      current(CertificationStatus.PENDING);
      prisma.farmCertification.updateMany.mockResolvedValue({ count: 0 });
      await expectError(service.resubmit(PRODUCER, CERT_ID, validBody(), [file()], NOW), 409);
      expect(uploads.delete).toHaveBeenCalledTimes(1);
      expect(notifications.notifyFarmCertificationSubmitted).not.toHaveBeenCalled();
    });
  });

  describe('avaliação (admin)', () => {
    function pending(overrides: Record<string, unknown> = {}) {
      prisma.farmCertification.findUnique.mockResolvedValue({
        id: CERT_ID,
        userId: PRODUCER.userId,
        farmName: 'Fazenda Boa Vista',
        status: CertificationStatus.PENDING,
        validUntil: brasiliaDateFromKey('2027-03-01'),
        documents: [
          { id: 'doc-report', docType: CertificationDocumentType.AUDIT_REPORT },
          { id: 'doc-cert', docType: CertificationDocumentType.CERTIFICATE },
        ],
        ...overrides,
      } as never);
    }

    it('aprova: CAS a partir de PENDING, registra quem aprovou e o certificado usado, e avisa o produtor', async () => {
      pending();
      await service.approve(ADMIN, CERT_ID, { notes: 'ok' }, NOW);

      expect(prisma.farmCertification.updateMany).toHaveBeenCalledWith({
        where: { id: CERT_ID, status: 'PENDING' },
        data: { status: 'APPROVED', reviewedById: ADMIN.userId, reviewedAt: NOW, reviewNotes: 'ok', rejectionReason: null },
      });
      const event = prisma.farmCertificationEvent.create.mock.calls[0][0].data;
      expect(event).toMatchObject({ action: 'APPROVED', fromStatus: 'PENDING', toStatus: 'APPROVED', actorId: ADMIN.userId, documentId: 'doc-cert', note: 'ok' });
      expect(notifications.notifyFarmCertification).toHaveBeenCalledWith('APPROVED', [
        expect.objectContaining({ certificationId: CERT_ID, userId: PRODUCER.userId, dedupeId: event.id }),
      ]);
    });

    it('aprova com o documento escolhido, desde que seja da certificação', async () => {
      pending();
      await service.approve(ADMIN, CERT_ID, { documentId: 'doc-report' }, NOW);
      expect(prisma.farmCertificationEvent.create.mock.calls[0][0].data.documentId).toBe('doc-report');

      await expectError(service.approve(ADMIN, CERT_ID, { documentId: 'doc-alheio' }, NOW), 400);
    });

    it('não aprova certificado já vencido', async () => {
      pending({ validUntil: brasiliaDateFromKey('2026-11-10') });
      await expectError(service.approve(ADMIN, CERT_ID, {}, NOW), 409, /vencido/);
      expect(prisma.farmCertification.updateMany).not.toHaveBeenCalled();
    });

    it('recusa exige motivo e grava o motivo', async () => {
      pending();
      await expectError(service.reject(ADMIN, CERT_ID, {}, NOW), 400, /Motivo/);

      await service.reject(ADMIN, CERT_ID, { reason: 'Documento ilegível' }, NOW);
      expect(prisma.farmCertification.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'REJECTED', rejectionReason: 'Documento ilegível' });
      expect(prisma.farmCertificationEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'REJECTED', documentId: null, note: 'Documento ilegível' });
      expect(notifications.notifyFarmCertification).toHaveBeenCalledWith('REJECTED', [expect.objectContaining({ reason: 'Documento ilegível' })]);
    });

    it('revoga só a partir de APPROVED', async () => {
      pending();
      await expectError(service.revoke(ADMIN, CERT_ID, { reason: 'Fraude' }, NOW), 409);

      pending({ status: CertificationStatus.APPROVED });
      await service.revoke(ADMIN, CERT_ID, { reason: 'Fraude' }, NOW);
      expect(prisma.farmCertification.updateMany.mock.calls[0][0].where).toEqual({ id: CERT_ID, status: 'APPROVED' });
      expect(notifications.notifyFarmCertification).toHaveBeenCalledWith('REVOKED', expect.any(Array));
    });

    it('devolve 409 sem notificar quando outro admin avaliou antes', async () => {
      pending();
      prisma.farmCertification.updateMany.mockResolvedValue({ count: 0 });
      await expectError(service.approve(ADMIN, CERT_ID, {}, NOW), 409);
      expect(prisma.farmCertificationEvent.create).not.toHaveBeenCalled();
      expect(notifications.notifyFarmCertification).not.toHaveBeenCalled();
    });

    it('só admin avalia', async () => {
      await expectError(service.approve(PRODUCER, CERT_ID, {}, NOW), 403);
    });
  });

  describe('leitura', () => {
    beforeEach(() => (service.getById as jest.Mock).mockRestore());

    function row(userId = PRODUCER.userId) {
      prisma.farmCertification.findUnique.mockResolvedValue({
        id: CERT_ID,
        userId,
        status: CertificationStatus.APPROVED,
        validUntil: brasiliaDateFromKey('2026-11-11'),
        user: { id: userId, name: 'João', cpf: '123' },
      } as never);
    }

    it('dono vê sem os dados pessoais; admin vê com eles; outros recebem 404', async () => {
      row();
      const own = await service.getById(PRODUCER, CERT_ID, NOW);
      expect(own).not.toHaveProperty('user');
      expect(own.badgeActive).toBe(true);

      const asAdmin = await service.getById(ADMIN, CERT_ID, NOW);
      expect(asAdmin).toHaveProperty('user');

      await expectError(service.getById({ userId: 'intruso', role: 'buyer' }, CERT_ID, NOW), 404);
    });

    it('selo apaga no dia seguinte ao vencimento', async () => {
      row();
      const tomorrow = new Date('2026-11-12T03:00:00Z'); // 00:00 de 12/11 em Brasília
      expect((await service.getById(PRODUCER, CERT_ID, tomorrow)).badgeActive).toBe(false);
    });

    it('URL assinada do documento só para dono ou admin', async () => {
      prisma.farmCertificationDocument.findFirst.mockResolvedValue({
        s3Key: 'certifications/farm/cert-1/a.pdf',
        originalName: 'a.pdf',
        mimeType: 'application/pdf',
        certification: { userId: PRODUCER.userId },
      } as never);

      const result = await service.getDocumentUrl(PRODUCER, CERT_ID, 'doc-1');
      expect(uploads.getSignedReadUrl).toHaveBeenCalledWith('certifications/farm/cert-1/a.pdf', 600);
      expect(result).toMatchObject({ url: 'https://signed.example/doc', expiresIn: 600 });

      await expectError(service.getDocumentUrl({ userId: 'intruso', role: 'buyer' }, CERT_ID, 'doc-1'), 404);
      await service.getDocumentUrl(ADMIN, CERT_ID, 'doc-1');
    });

    it('selo público filtra aprovadas dentro da validade e não expõe dados sensíveis', async () => {
      prisma.farmCertification.findMany.mockResolvedValue([{ id: CERT_ID }] as never);
      const badge = await service.getBadge(PRODUCER.userId, NOW);

      const args = prisma.farmCertification.findMany.mock.calls[0][0]!;
      expect(args.where).toEqual({ userId: PRODUCER.userId, status: 'APPROVED', validUntil: { gte: brasiliaDateFromKey('2026-11-11') } });
      for (const field of ['farmName', 'certifierCnpj', 'ccir', 'car', 'areaHectares', 'documents']) {
        expect(args.select).not.toHaveProperty(field);
      }
      expect(badge.certified).toBe(true);
    });
  });

  describe('vencimento', () => {
    it('marca EXPIRED as aprovadas vencidas, com histórico do sistema, e avisa o produtor', async () => {
      const validUntil = brasiliaDateFromKey('2026-11-10')!;
      prisma.farmCertification.findMany.mockResolvedValue([
        { id: 'c1', userId: 'u1', farmName: 'F1', validUntil },
        { id: 'c2', userId: 'u2', farmName: 'F2', validUntil },
      ] as never);
      prisma.farmCertification.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

      expect(await service.expireOverdue(NOW)).toBe(1);
      expect(prisma.farmCertification.findMany.mock.calls[0][0]!.where).toEqual({
        status: 'APPROVED',
        validUntil: { lt: brasiliaDateFromKey('2026-11-11') },
      });
      expect(prisma.farmCertificationEvent.create).toHaveBeenCalledTimes(1);
      expect(prisma.farmCertificationEvent.create.mock.calls[0][0].data).toMatchObject({ action: 'EXPIRED', actorId: null, toStatus: 'EXPIRED' });
      expect(notifications.notifyFarmCertification).toHaveBeenCalledTimes(1);
      expect(notifications.notifyFarmCertification).toHaveBeenCalledWith('EXPIRED', [expect.objectContaining({ certificationId: 'c1' })]);
    });

    it('avisa vencimento próximo com dedupe por certificação e validade', async () => {
      const validUntil = brasiliaDateFromKey('2026-12-01')!;
      prisma.farmCertification.findMany.mockResolvedValue([{ id: 'c1', userId: 'u1', farmName: 'F1', validUntil }] as never);

      await service.sendExpiringReminders(NOW);
      expect(prisma.farmCertification.findMany.mock.calls[0][0]!.where).toEqual({
        status: 'APPROVED',
        validUntil: { gte: brasiliaDateFromKey('2026-11-12'), lt: brasiliaDateFromKey('2026-12-12') },
      });
      expect(notifications.notifyFarmCertification).toHaveBeenCalledWith('EXPIRING', [
        expect.objectContaining({ certificationId: 'c1', dedupeId: 'c1:2026-12-01' }),
      ]);
    });
  });
});

describe('buildNotificationLink (certificação)', () => {
  it('leva o admin para a avaliação e o produtor para as certificações dele', () => {
    const base = { saleId: null, productId: null };
    expect(buildNotificationLink({ ...base, data: { role: 'admin', certificationId: 'c1' } }, 'https://app/')).toEqual({
      label: 'Avaliar a certificação',
      url: 'https://app/admin/certifications/farm/c1',
    });
    expect(buildNotificationLink({ ...base, data: { role: 'producer', certificationId: 'c1' } }, 'https://app')?.url).toBe(
      'https://app/market/certifications/farm'
    );
  });
});

describe('brasiliaDateFromKey', () => {
  it('converte para o início do dia em Brasília e rejeita datas inexistentes', () => {
    expect(brasiliaDateFromKey('2026-11-11')?.toISOString()).toBe('2026-11-11T03:00:00.000Z');
    expect(brasiliaDateFromKey('2026-11-11T00:00:00.000Z')?.toISOString()).toBe('2026-11-11T03:00:00.000Z');
    expect(brasiliaDateFromKey('2026-02-30')).toBeNull();
    expect(brasiliaDateFromKey('11/11/2026')).toBeNull();
  });
});
