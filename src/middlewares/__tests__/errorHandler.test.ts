import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { createErrorHandler, INTERNAL_ERROR_MESSAGE } from '../errorHandler';
import { CertificationError } from '../../modules/certification/certification.errors';

function run(err: unknown, opts: { headersSent?: boolean } = {}) {
  const log = { warn: jest.fn(), error: jest.fn() };
  const res = {
    headersSent: opts.headersSent ?? false,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response & { status: jest.Mock; json: jest.Mock };
  const req = { method: 'PATCH', originalUrl: '/certifications/farm/admin/c1/approve?token=segredo' } as Request;
  const next = jest.fn();
  createErrorHandler(log)(err, req, res, next);
  return { log, res, next };
}

describe('errorHandler', () => {
  it('4xx: uma linha de aviso, sem stack e sem query string, e a mensagem vai para o cliente', () => {
    const { log, res } = run(new CertificationError(400, 'Informe a revisão analisada (revision).'));

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      '[HTTP 400] PATCH /certifications/farm/admin/c1/approve — Informe a revisão analisada (revision).'
    );
    const [line] = log.warn.mock.calls[0];
    expect(line).not.toMatch(/\n\s+at /); // sem stack
    expect(line).not.toContain('segredo');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Informe a revisão analisada (revision).' });
  });

  it.each([403, 404, 409])('%i também é aviso de uma linha', (status) => {
    const { log, res } = run(new CertificationError(status as 403 | 404 | 409, 'x'));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(status);
  });

  it('erro inesperado (sem status): log completo com stack, 500 e mensagem genérica', () => {
    const err = new Error('Cannot read properties of undefined');
    const { log, res } = run(err);

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('[Global Error Handler] PATCH /certifications/farm/admin/c1/approve', err);
    expect((log.error.mock.calls[0][1] as Error).stack).toBeDefined();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: INTERNAL_ERROR_MESSAGE });
  });

  it('não expõe mensagem do Prisma ao cliente', () => {
    const err = new Prisma.PrismaClientKnownRequestError('Invalid `prisma.user.update()` invocation: column x', {
      code: 'P2022',
      clientVersion: 'test',
    });
    const { log, res } = run(err);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ error: INTERNAL_ERROR_MESSAGE });
  });

  it('5xx declarado de propósito mantém status e mensagem, mas loga como erro', () => {
    const { log, res } = run(new CertificationError(502, 'Falha ao enviar os documentos. Tente novamente.'));
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: 'Falha ao enviar os documentos. Tente novamente.' });
  });

  it('status inválido é tratado como 500', () => {
    const { res } = run(Object.assign(new Error('x'), { status: 200 }));
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('erro de JSON malformado (body-parser, status 400) vira aviso', () => {
    const { log, res } = run(Object.assign(new SyntaxError('Unexpected token } in JSON'), { status: 400, type: 'entity.parse.failed' }));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('resposta já enviada: delega ao Express', () => {
    const err = new Error('x');
    const { next, res } = run(err, { headersSent: true });
    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
  });
});
