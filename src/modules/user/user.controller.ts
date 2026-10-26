import { Request, Response, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { INVALID_RESET_TOKEN_MESSAGE, UserService, WEAK_PASSWORD_MESSAGE } from './user.service';
import { logger } from '../../lib/logger';

const prisma = new PrismaClient();
const service = new UserService(prisma);

/**
 * Mensagens de erro de validação/regra de negócio lançadas por UserService.create()
 * e UserService.createAdmin() — qualquer outra exceção (ex.: banco indisponível) é
 * uma falha interna e deve virar 500, não 400.
 */
const KNOWN_USER_VALIDATION_ERRORS = new Set([
  'Campos obrigatórios faltando.',
  'Perfil inválido.',
  'CPF ou CNPJ é obrigatório.',
  'CPF inválido.',
  'CPF já cadastrado.',
  'CNPJ inválido.',
  'CNPJ já cadastrado.',
  'Email já cadastrado.',
  'A senha deve conter pelo menos 8 caracteres, incluindo uma letra maiúscula, uma letra minúscula, um número e um caractere especial.',
]);

function isKnownUserValidationError(message: string | undefined): boolean {
  return !!message && KNOWN_USER_VALIDATION_ERRORS.has(message);
}

export class UserController {
  public async createHandler(req: Request, res: Response): Promise<void> {
    try {
      await service.create(req.body);
      res.status(201).json({ message: 'Usuário cadastrado com sucesso!' });
    } catch (error: any) {
      if (isKnownUserValidationError(error.message)) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error(error);
      res.status(500).json({ error: 'Erro ao cadastrar usuário.' });
    }
  }

  public createAdminHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const admin = await service.createAdmin(req.body);
      res.status(201).json({ message: 'Usuário admin criado com sucesso!', user: admin });
    } catch (error: any) {
      if (isKnownUserValidationError(error.message)) {
        res.status(400).json({ error: error.message });
        return;
      }
      console.error(error);
      res.status(500).json({ error: 'Erro ao criar usuário admin.' });
    }
  };

  public getAllHandler: RequestHandler = async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await service.getAll();
      res.status(200).json(result);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  };

  public getByIdHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(id)) {
        res.status(400).json({ error: 'ID deve ser um UUID válido' });
        return;
      }

      if (req.user?.role !== 'admin' && req.user?.userId !== id) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const result = await service.getById(id);
      if (!result) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      res.status(200).json(result);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: 'Failed to fetch user' });
    }
  };

  public updateHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(id)) {
        res.status(400).json({ error: 'ID deve ser um UUID válido' });
        return;
      }

      if (req.user?.role !== 'admin' && req.user?.userId !== id) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const file = req.file;
      const result = await service.update(id, req.body, file);
      res.status(200).json(result);
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: 'Failed to update user' });
    }
  };

  public deleteHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(id)) {
        res.status(400).json({ error: 'ID deve ser um UUID válido' });
        return;
      }

      if (req.user?.role !== 'admin' && req.user?.userId !== id) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      await service.delete(id);
      res.status(204).send();
    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  };

  public sendResetPasswordHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    const email: unknown = req.body?.email;
    if (typeof email !== 'string' || !email.trim()) {
      res.status(400).json({ error: 'Informe o e-mail.' });
      return;
    }

    try {
      await service.sendResetPassword(email);
      // Mesma resposta exista ou não a conta, para não permitir descobrir e-mails cadastrados.
      res.status(200).json({ message: 'Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.' });
    } catch (error: unknown) {
      logger.error('[UserController] erro ao solicitar redefinição de senha:', error instanceof Error ? error.message : error);
      res.status(500).json({ error: 'Erro ao solicitar redefinição de senha.' });
    }
  };

  public changePasswordHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    const token: unknown = req.body?.token;
    const newPassword: unknown = req.body?.newPassword;
    if (typeof token !== 'string' || typeof newPassword !== 'string' || !token || !newPassword) {
      res.status(400).json({ error: 'Campos obrigatórios faltando.' });
      return;
    }

    try {
      await service.changePassword(token, newPassword);
      res.status(200).json({ message: 'Senha alterada com sucesso.' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : undefined;
      if (message === INVALID_RESET_TOKEN_MESSAGE || message === WEAK_PASSWORD_MESSAGE) {
        res.status(400).json({ error: message });
        return;
      }
      logger.error('[UserController] erro ao alterar senha:', message ?? error);
      res.status(500).json({ error: 'Erro ao alterar senha.' });
    }
  };
}