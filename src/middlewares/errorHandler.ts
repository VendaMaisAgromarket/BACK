import { ErrorRequestHandler } from 'express';

export const INTERNAL_ERROR_MESSAGE = 'Erro interno do servidor';

type ErrorLog = Pick<Console, 'warn' | 'error'>;

/** Status HTTP declarado pelo erro (CertificationError, ProductError, body-parser…), se for válido. */
function declaredStatus(err: unknown): number | undefined {
  const status = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

function errorMessage(err: unknown): string | undefined {
  const message = err && typeof err === 'object' ? (err as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message ? message : undefined;
}

/**
 * Tratamento global de erros.
 * - 4xx (validação, permissão, não encontrado, conflito): é o fluxo esperado → uma linha de aviso, sem
 *   stack, e a mensagem do erro vai para o cliente (já é escrita para ele).
 * - Sem status ou 5xx: falha do servidor → erro completo (com stack) no log. Se o erro não declarou
 *   status (Prisma, bug, lib de terceiros), a mensagem pode expor detalhes internos: o cliente recebe só
 *   a mensagem genérica. Um 5xx declarado de propósito (ex.: 502 do upload) mantém a mensagem dele.
 * O caminho é logado sem query string (pode carregar tokens/dados pessoais).
 */
export function createErrorHandler(log: ErrorLog = console): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const status = declaredStatus(err);
    const path = req.originalUrl.split('?')[0];
    const message = errorMessage(err);

    if (status !== undefined && status < 500) {
      log.warn(`[HTTP ${status}] ${req.method} ${path} — ${message ?? 'sem mensagem'}`);
      res.status(status).json({ error: message ?? INTERNAL_ERROR_MESSAGE });
      return;
    }

    log.error(`[Global Error Handler] ${req.method} ${path}`, err);
    res.status(status ?? 500).json({ error: status !== undefined && message ? message : INTERNAL_ERROR_MESSAGE });
  };
}

export const errorHandler = createErrorHandler();
