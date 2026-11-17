// Erro de regra de negócio do módulo de certificação, já com o status HTTP. O handler global de
// erro (src/app.ts) usa `err.status`, então as rotas com `wrap(...)` só precisam propagar.
export class CertificationError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 502,
    message: string
  ) {
    super(message);
    this.name = "CertificationError";
  }
}

export interface CertificationRequester {
  userId: string;
  role?: string;
}
