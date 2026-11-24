-- Ações novas do histórico de certificações. Ficam numa migration separada porque o Postgres não
-- permite usar um valor de enum na mesma transação em que ele foi criado (a migration seguinte usa
-- DOCUMENT_ADDED no preenchimento do histórico já existente).
ALTER TYPE "CertificationEventAction" ADD VALUE 'DOCUMENT_ADDED';
ALTER TYPE "CertificationEventAction" ADD VALUE 'PAYMENT_CONFIRMED';
