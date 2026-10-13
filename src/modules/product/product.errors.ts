// Erro de regra de negócio do módulo de produto, já com o status HTTP que o
// controller deve devolver. Evita depender de trechos da mensagem para decidir o status.
export class ProductError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404,
    message: string
  ) {
    super(message);
    this.name = "ProductError";
  }
}

export interface ProductRequester {
  userId: string;
  role?: string;
}
