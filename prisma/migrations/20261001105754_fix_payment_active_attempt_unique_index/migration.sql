-- A invariante correta é "uma tentativa ativa por venda+fase", independente do meio de
-- pagamento usado — o índice anterior incluía billingType na chave, permitindo que duas
-- requisições para endpoints diferentes (ex.: /pix e /boleto) para a mesma venda/fase
-- reservassem simultaneamente, gerando duas cobranças a pagar para a mesma parcela.
DROP INDEX "Payment_active_attempt_unique";

CREATE UNIQUE INDEX "Payment_active_attempt_unique" ON "Payment" ("saleId", "phase")
WHERE "status" IN ('pending', 'completed');
