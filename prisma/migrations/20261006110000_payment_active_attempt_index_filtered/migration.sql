-- Recria o índice único parcial restringindo-o às cobranças da Asaas (billingType NOT NULL).
-- Pagamentos legados do Mercado Pago têm billingType nulo e ficam fora da invariante,
-- sem que nenhum dado histórico precise ser alterado ou cancelado.
DROP INDEX IF EXISTS "Payment_active_attempt_unique";

CREATE UNIQUE INDEX "Payment_active_attempt_unique" ON "Payment" ("saleId", "phase")
WHERE "status" IN ('pending', 'completed') AND "billingType" IS NOT NULL;
