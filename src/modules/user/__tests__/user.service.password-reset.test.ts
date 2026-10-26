import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { EmailService } from '../../email/email.service';
import {
  INVALID_RESET_TOKEN_MESSAGE,
  PASSWORD_RESET_TTL_MINUTES,
  UserService,
  WEAK_PASSWORD_MESSAGE,
} from '../user.service';

const NOW = new Date('2026-10-23T12:00:00Z');
const USER = { id: 'user-1', name: 'João', email: 'joao@example.com' };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('UserService — esqueci minha senha', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let email: { sendMail: jest.Mock };
  let service: UserService;
  const originalFrontendUrl = process.env.URL_FRONTEND;

  beforeEach(() => {
    process.env.URL_FRONTEND = 'https://app.vendamaisagro.com.br/';
    prisma = mockDeep<PrismaClient>();
    email = { sendMail: jest.fn().mockResolvedValue({ messageId: 'm', accepted: [], rejected: [] }) };
    service = new UserService(prisma as unknown as PrismaClient, email as unknown as EmailService);
    prisma.$transaction.mockImplementation((async (arg: unknown) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg as Promise<unknown>[])) as never);
  });

  afterAll(() => {
    process.env.URL_FRONTEND = originalFrontendUrl;
  });

  describe('sendResetPassword', () => {
    it('grava só o hash do token e envia o link com o token em claro', async () => {
      prisma.user.findFirst.mockResolvedValue(USER as never);
      prisma.passwordResetToken.findFirst.mockResolvedValue(null);

      await service.sendResetPassword('  Joao@Example.com ', NOW);

      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: { equals: 'Joao@Example.com', mode: 'insensitive' } } })
      );
      const { data } = prisma.passwordResetToken.create.mock.calls[0][0];
      expect(data.expiresAt).toEqual(new Date(NOW.getTime() + PASSWORD_RESET_TTL_MINUTES * 60_000));

      const { to, text } = email.sendMail.mock.calls[0][0];
      expect(to).toBe(USER.email);
      const token = /reset-password\?token=([\w-]+)/.exec(text)?.[1];
      expect(text).toContain('https://app.vendamaisagro.com.br/reset-password?token=');
      expect(token).toBeDefined();
      expect(data.tokenHash).toBe(sha256(token as string));
      expect(data.tokenHash).not.toBe(token);
    });

    it('invalida links anteriores ainda não usados', async () => {
      prisma.user.findFirst.mockResolvedValue(USER as never);
      prisma.passwordResetToken.findFirst.mockResolvedValue(null);

      await service.sendResetPassword(USER.email, NOW);

      expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: { userId: USER.id, usedAt: null },
        data: { usedAt: NOW },
      });
    });

    it('não faz nada (sem erro) quando o e-mail não está cadastrado', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.sendResetPassword('ninguem@example.com', NOW)).resolves.toBeUndefined();

      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
      expect(email.sendMail).not.toHaveBeenCalled();
    });

    it('não reenvia se já houve um pedido no último minuto', async () => {
      prisma.user.findFirst.mockResolvedValue(USER as never);
      prisma.passwordResetToken.findFirst.mockResolvedValue({ id: 't-1' } as never);

      await service.sendResetPassword(USER.email, NOW);

      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
      expect(email.sendMail).not.toHaveBeenCalled();
    });

    it('falha do envio do e-mail não vira erro para quem pediu', async () => {
      prisma.user.findFirst.mockResolvedValue(USER as never);
      prisma.passwordResetToken.findFirst.mockResolvedValue(null);
      email.sendMail.mockRejectedValue(new Error('SMTP fora do ar'));

      await expect(service.sendResetPassword(USER.email, NOW)).resolves.toBeUndefined();
    });
  });

  describe('changePassword', () => {
    const TOKEN = 'token-em-claro';
    const validToken = {
      id: 't-1',
      userId: USER.id,
      usedAt: null,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    };

    it('troca a senha, consome o token e avisa o usuário por e-mail', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(validToken as never);
      prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.update.mockResolvedValue({ name: USER.name, email: USER.email } as never);

      await service.changePassword(TOKEN, 'NovaSenha@123', NOW);

      expect(prisma.passwordResetToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: sha256(TOKEN) } })
      );
      expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: { id: 't-1', usedAt: null, expiresAt: { gt: NOW } },
        data: { usedAt: NOW },
      });
      const { data } = prisma.user.update.mock.calls[0][0];
      expect(data.password).not.toBe('NovaSenha@123');
      expect(data.tokenVersion).toEqual({ increment: 1 });
      expect(email.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: USER.email }));
    });

    it.each([
      ['inexistente', null],
      ['já usado', { ...validToken, usedAt: new Date(NOW.getTime() - 1000) }],
      ['expirado', { ...validToken, expiresAt: NOW }],
    ])('rejeita token %s', async (_label, row) => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(row as never);

      await expect(service.changePassword(TOKEN, 'NovaSenha@123', NOW)).rejects.toThrow(INVALID_RESET_TOKEN_MESSAGE);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejeita quando outra requisição consumiu o token antes (corrida)', async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(validToken as never);
      prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.changePassword(TOKEN, 'NovaSenha@123', NOW)).rejects.toThrow(INVALID_RESET_TOKEN_MESSAGE);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejeita senha fraca sem consultar o token', async () => {
      await expect(service.changePassword(TOKEN, 'fraca', NOW)).rejects.toThrow(WEAK_PASSWORD_MESSAGE);
      expect(prisma.passwordResetToken.findUnique).not.toHaveBeenCalled();
    });
  });
});
