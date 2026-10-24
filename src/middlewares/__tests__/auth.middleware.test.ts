process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { createProtectRoute } from '../auth.middleware';

const SECRET = process.env.JWT_SECRET as string;

function makeReq(token?: string): Request {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} } as unknown as Request;
}

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('protectRoute', () => {
  let findUnique: jest.Mock;
  let protectRoute: ReturnType<typeof createProtectRoute>;

  beforeEach(() => {
    findUnique = jest.fn();
    protectRoute = createProtectRoute({ user: { findUnique } } as never);
  });

  it('aceita token cuja versão bate com a do usuário', async () => {
    findUnique.mockResolvedValue({ tokenVersion: 2 });
    const req = makeReq(jwt.sign({ id: 'u-1', email: 'a@b.com', role: 'buyer', tv: 2 }, SECRET));
    const res = makeRes();
    const next = jest.fn();

    await protectRoute(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({ userId: 'u-1', email: 'a@b.com', role: 'buyer' });
  });

  it('recusa token emitido antes de uma troca de senha', async () => {
    findUnique.mockResolvedValue({ tokenVersion: 3 });
    const res = makeRes();
    const next = jest.fn();

    await protectRoute(makeReq(jwt.sign({ id: 'u-1', email: 'a@b.com', tv: 2 }, SECRET)), res as unknown as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('token antigo sem `tv` vale como versão 0 (continua válido até a primeira troca de senha)', async () => {
    findUnique.mockResolvedValue({ tokenVersion: 0 });
    const next = jest.fn();

    await protectRoute(makeReq(jwt.sign({ id: 'u-1', email: 'a@b.com' }, SECRET)), makeRes() as unknown as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('recusa token de usuário removido', async () => {
    findUnique.mockResolvedValue(null);
    const res = makeRes();

    await protectRoute(makeReq(jwt.sign({ id: 'u-1', email: 'a@b.com', tv: 0 }, SECRET)), res as unknown as Response, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('recusa assinatura inválida sem consultar o banco', async () => {
    const res = makeRes();

    await protectRoute(makeReq(jwt.sign({ id: 'u-1', email: 'a@b.com' }, 'outro-segredo')), res as unknown as Response, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
