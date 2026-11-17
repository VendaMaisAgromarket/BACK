import { NotificationType, PrismaClient } from '@prisma/client';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EmailService } from '../../email/email.service';
import { UserService } from '../user.service';

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

describe('UserService.update — notificação de alteração de perfil', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let email: { sendMail: jest.Mock };
  let service: UserService;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    email = { sendMail: jest.fn().mockResolvedValue({ messageId: 'm', accepted: [], rejected: [] }) };
    service = new UserService(prisma as unknown as PrismaClient, email as unknown as EmailService);
    prisma.user.findUnique.mockResolvedValue(STORED as never);
    prisma.notification.createMany.mockResolvedValue({ count: 1 });
  });

  function mockUpdatedUser(overrides: Record<string, unknown> = {}) {
    prisma.user.update.mockResolvedValue({ ...STORED, password: 'hash', ...overrides } as never);
  }

  function notifiedFields(): string[] | undefined {
    const call = prisma.notification.createMany.mock.calls[0]?.[0];
    const [input] = (call?.data ?? []) as unknown as Array<{ type: NotificationType; data: { fields: string[] } }>;
    return input?.type === NotificationType.PROFILE_UPDATED ? input.data.fields : undefined;
  }

  it('notifica só os campos que mudaram de valor', async () => {
    mockUpdatedUser({ name: 'João Silva', phone_number: '11888888888' });

    // O formulário reenvia tudo: e-mail e CPF iguais, CCIR em branco (null no banco).
    await service.update(USER_ID, {
      name: 'João Silva',
      phone_number: '11888888888',
      email: STORED.email,
      cpf: STORED.cpf,
      ccir: '',
    } as never);

    expect(notifiedFields()).toEqual(['nome', 'telefone']);
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  it('não grava notificação quando nada mudou', async () => {
    mockUpdatedUser();

    await service.update(USER_ID, { name: STORED.name, email: STORED.email } as never);

    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  it('troca de senha entra como "senha"', async () => {
    mockUpdatedUser();

    await service.update(USER_ID, { password: 'NovaSenha@123' } as never);

    expect(notifiedFields()).toEqual(['senha']);
  });

  it('troca de e-mail notifica o perfil e avisa o e-mail ANTERIOR, sem revelar o novo', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(STORED as never).mockResolvedValueOnce(null);
    mockUpdatedUser({ email: 'novo@example.com' });

    await service.update(USER_ID, { email: 'novo@example.com' } as never);

    expect(notifiedFields()).toEqual(['e-mail']);
    expect(email.sendMail).toHaveBeenCalledTimes(1);
    const { to, text } = email.sendMail.mock.calls[0][0];
    expect(to).toBe(STORED.email);
    expect(text).not.toContain('novo@example.com');
  });
});
