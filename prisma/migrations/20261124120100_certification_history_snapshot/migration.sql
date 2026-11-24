-- Retrato de cada evento do histórico (quem fez, revisão, dados do certificado/arquivo no momento).
ALTER TABLE "FarmCertificationEvent" ADD COLUMN     "actor_name" TEXT,
ADD COLUMN     "actor_role" TEXT,
ADD COLUMN     "details" JSONB,
ADD COLUMN     "revision" INTEGER;

ALTER TABLE "HarvestCertificationEvent" ADD COLUMN     "actor_name" TEXT,
ADD COLUMN     "actor_role" TEXT,
ADD COLUMN     "details" JSONB,
ADD COLUMN     "revision" INTEGER;

-- ── Preenchimento do histórico que já existe (só adiciona informação; nada é apagado) ──────────

-- Quem fez: nome e papel atuais do usuário (melhor dado disponível para eventos antigos).
UPDATE "FarmCertificationEvent" e SET "actor_name" = u."name", "actor_role" = u."role"
FROM "User" u WHERE e."actor_id" = u."id";
UPDATE "HarvestCertificationEvent" e SET "actor_name" = u."name", "actor_role" = u."role"
FROM "User" u WHERE e."actor_id" = u."id";

-- Ações do sistema (job de vencimento).
UPDATE "FarmCertificationEvent" SET "actor_name" = 'Sistema', "actor_role" = 'system' WHERE "actor_id" IS NULL;
UPDATE "HarvestCertificationEvent" SET "actor_name" = 'Sistema', "actor_role" = 'system' WHERE "actor_id" IS NULL;

-- Um DOCUMENT_ADDED para cada arquivo já anexado. Documentos só são anexados com a certificação em
-- PENDING, no envio ou reenvio: cada um fica logo depois (1 ms, 2 ms…) do SUBMITTED/RESUBMITTED mais
-- próximo do seu upload. (O horário de upload é gravado alguns ms antes do evento de envio; usá-lo
-- direto colocaria o documento antes do envio no histórico.)
INSERT INTO "FarmCertificationEvent"
  ("id", "certification_id", "action", "from_status", "to_status", "actor_id", "actor_name", "actor_role",
   "document_id", "details", "created_at")
SELECT gen_random_uuid()::text, d."certification_id", 'DOCUMENT_ADDED', 'PENDING', 'PENDING', d."uploaded_by_id",
       u."name", u."role", d."id",
       jsonb_build_object('originalName', d."original_name", 'docType', d."doc_type", 'mimeType', d."mime_type", 'sizeBytes', d."size_bytes"),
       COALESCE(s."created_at", d."uploaded_at")
         + ROW_NUMBER() OVER (PARTITION BY d."certification_id", s."id" ORDER BY d."uploaded_at", d."id") * interval '1 millisecond'
FROM "FarmCertificationDocument" d
LEFT JOIN "User" u ON u."id" = d."uploaded_by_id"
LEFT JOIN LATERAL (
  SELECT e."id", e."created_at"
  FROM "FarmCertificationEvent" e
  WHERE e."certification_id" = d."certification_id" AND e."action" IN ('SUBMITTED', 'RESUBMITTED')
  ORDER BY abs(extract(epoch FROM e."created_at" - d."uploaded_at"))
  LIMIT 1
) s ON true;

INSERT INTO "HarvestCertificationEvent"
  ("id", "certification_id", "action", "from_status", "to_status", "actor_id", "actor_name", "actor_role",
   "document_id", "details", "created_at")
SELECT gen_random_uuid()::text, d."certification_id", 'DOCUMENT_ADDED', 'PENDING', 'PENDING', d."uploaded_by_id",
       u."name", u."role", d."id",
       jsonb_build_object('originalName', d."original_name", 'docType', d."doc_type", 'mimeType', d."mime_type", 'sizeBytes', d."size_bytes"),
       COALESCE(s."created_at", d."uploaded_at")
         + ROW_NUMBER() OVER (PARTITION BY d."certification_id", s."id" ORDER BY d."uploaded_at", d."id") * interval '1 millisecond'
FROM "HarvestCertificationDocument" d
LEFT JOIN "User" u ON u."id" = d."uploaded_by_id"
LEFT JOIN LATERAL (
  SELECT e."id", e."created_at"
  FROM "HarvestCertificationEvent" e
  WHERE e."certification_id" = d."certification_id" AND e."action" IN ('SUBMITTED', 'RESUBMITTED')
  ORDER BY abs(extract(epoch FROM e."created_at" - d."uploaded_at"))
  LIMIT 1
) s ON true;
