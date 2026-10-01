-- Impede duas cobranças ativas (pending/completed) para a mesma venda+fase+meio de
-- pagamento: fecha, no banco, a corrida que a checagem de idempotência da aplicação
-- (findExistingAttempt) por si só não consegue evitar entre duas requisições concorrentes.
CREATE UNIQUE INDEX "Payment_active_attempt_unique" ON "Payment" ("saleId", "phase", "billingType")
WHERE "status" IN ('pending', 'completed');
