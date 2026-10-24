import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { JWT_SECRET } from '../config/jwt.config';

interface JwtPayload {
  id: string;
  email: string;
  role?: string;
  name?: string;
  /** User.tokenVersion no momento do login. Tokens antigos, sem o campo, valem como versão 0. */
  tv?: number;
}

type TokenVersionReader = Pick<PrismaClient, 'user'>;

/**
 * Além da assinatura, confere a versão das sessões do usuário no banco: trocar a senha incrementa
 * User.tokenVersion e derruba todos os tokens emitidos antes. Usuário removido também é barrado.
 */
export function createProtectRoute(prisma: TokenVersionReader) {
  return async (req: Request, res: Response, next: NextFunction) => {
    let decoded: JwtPayload;
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized - No token provided' });
      }

      const token = authHeader.split(' ')[1];

      decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    } catch (error) {
      return res.status(401).json({ error: 'Unauthorized - Invalid token' });
    }

    if (!decoded.id || !decoded.email) {
      return res.status(401).json({ error: 'Unauthorized - Invalid token payload' });
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.id }, select: { tokenVersion: true } });
    if (!user || user.tokenVersion !== (decoded.tv ?? 0)) {
      return res.status(401).json({ error: 'Unauthorized - Session expired' });
    }

    req.user = { userId: decoded.id, email: decoded.email, role: decoded.role };

    next();
  };
}

export const protectRoute = createProtectRoute(new PrismaClient());

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden - Admin access required' });
  }

  next();
};

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        email: string;
        role?: string;
      };
    }
  }
}
