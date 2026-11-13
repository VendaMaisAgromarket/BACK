import { PrismaClient } from '@prisma/client';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EmailService } from '../../email/email.service';
import { ProfileUpdateError, UserService } from '../user.service';

const USER_ID = 'user-1';
const STORED = {
  id: USER_ID,
  name: 'João',
  phone_number: '11999999999',
  email: 'joao@example.com',
  cpf: '529.982.247-25',
  cnpj: null,
  ccir: null,
  img: null,
};

describe('UserService.update — só campos editáveis do perfil chegam ao Prisma', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let service: UserService;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    const email = { sendMail: jest.fn().mockResolvedValue({ messageId: 'm', accepted: [], rejected: [] }) };
    service = new UserService(prisma as unknown as PrismaClient, email as unknown as EmailService);
    prisma.user.findUnique.mockResolvedValue(STORED as never);
    prisma.user.update.mockResolvedValue({ ...STORED, password: 'hash' } as never);
    prisma.notification.createMany.mockResolvedValue({ count: 1 });
  });

  function updateData() {
    return prisma.user.update.mock.calls[0][0].data as Record<string, unknown>;
  }

  it.each([
    ['farmCertifications', { updateMany: { where: {}, data: { status: 'APPROVED' } } }],
    ['farmCertifications', { connect: { id: 'cert-de-outro-produtor' } }],
    ['reviewedFarmCertifications', { connect: [{ id: 'cert-1' }] }],
    ['securityQuestions', { update: { answer_1: 'x' } }],
    ['name', { set: 'Via operador' }],
  ])('recusa escrita aninhada em %s com 400 e não grava nada', async (field, value) => {
    const err = await service.update(USER_ID, { name: 'João', [field]: value }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProfileUpdateError);
    expect((err as ProfileUpdateError).status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('descarta campos escalares que não são do perfil (papel, flags, ids, sessões)', async () => {
    await service.update(USER_ID, {
      name: 'João Silva',
      role: 'admin',
      valid: 'true',
      tokenVersion: '0',
      id: 'outro-id',
      asaas_customer_id: 'cus_x',
      img: 'https://bucket/certifications/farm/c1/doc.pdf',
    });

    expect(updateData()).toEqual({ name: 'João Silva' });
  });

  it('mantém os campos editáveis, permitindo limpar os anuláveis', async () => {
    await service.update(USER_ID, { phone_number: '11888888888', ccir: null, cnpj: null });
    expect(updateData()).toEqual({ phone_number: '11888888888', ccir: null, cnpj: null });
  });

  it('recusa tipo inválido em campo editável', async () => {
    await expect(service.update(USER_ID, { name: null })).rejects.toBeInstanceOf(ProfileUpdateError);
    await expect(service.update(USER_ID, { email: 42 })).rejects.toBeInstanceOf(ProfileUpdateError);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('a troca de senha continua passando pelo hash e encerrando as sessões', async () => {
    await service.update(USER_ID, { password: 'NovaSenha@123' });
    const data = updateData();
    expect(data.password).not.toBe('NovaSenha@123');
    expect(data.tokenVersion).toEqual({ increment: 1 });
  });
});
