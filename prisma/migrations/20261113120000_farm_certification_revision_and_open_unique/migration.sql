-- Revisão dos dados da certificação: token de compare-and-set do reenvio e da avaliação.
ALTER TABLE "FarmCertification" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- O mesmo certificado (produtor + tipo + número, sem diferenciar maiúsculas/minúsculas) não pode estar
-- aberto (PENDING ou APPROVED) duas vezes. Índice parcial e por expressão: não representável no schema
-- do Prisma (ver nota em FarmCertification). Garante a regra também sob envios simultâneos.
CREATE UNIQUE INDEX "FarmCertification_open_certificate_unique"
  ON "FarmCertification" ("user_id", "type", lower("certificate_number"))
  WHERE "status" IN ('PENDING', 'APPROVED');
