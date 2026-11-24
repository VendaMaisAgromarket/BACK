import { z } from "zod";
import { CertificationDocumentType } from "@prisma/client";
import { formatToCNPJ, isCNPJ } from "brazilian-values";
import { brasiliaDateFromKey } from "../../lib/brasiliaTime";
import { CertificationError } from "./certification.errors";

// Validações comuns às certificações (fazenda e safra).

export const BRAZILIAN_UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
  "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
] as const;

export const CERTIFICATION_STATUSES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "REVOKED"] as const;

/** Campos chegam como texto (multipart): vazio vale como "não informado". */
export const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional()
  );

/** Texto obrigatório com mínimo/máximo e a mesma mensagem para ausente e curto demais. */
export const requiredText = (label: string, min: number, max: number) =>
  z.string({ error: label }).trim().min(min, label).max(max);

/** Data de calendário "AAAA-MM-DD" (ou ISO válido) → início do dia em Brasília. */
export const calendarDate = (label: string) =>
  z
    .string({ error: `${label} é obrigatória.` })
    .transform((value, ctx) => {
      const date = brasiliaDateFromKey(value);
      if (!date) {
        ctx.addIssue({ code: "custom", message: `${label} inválida (use AAAA-MM-DD).` });
        return z.NEVER;
      }
      return date;
    });

/** Número positivo vindo de texto (multipart), com teto para barrar valores absurdos. */
export const positiveNumber = (label: string, max: number) =>
  z.coerce.number({ error: `${label} é obrigatória.` }).positive(`${label} deve ser maior que zero.`).max(max, `${label} inválida.`);

/** Campos do certificado em si, iguais para fazenda e safra (o `type` é de cada um). */
export const certificateFields = {
  certifierName: requiredText("Nome da certificadora é obrigatório.", 2, 120),
  certifierCnpj: z
    .string({ error: "CNPJ da certificadora é obrigatório." })
    .trim()
    .refine((value) => isCNPJ(value), "CNPJ da certificadora inválido.")
    .transform((value) => formatToCNPJ(value)),
  certificateNumber: requiredText("Número do certificado é obrigatório.", 1, 80),
  issuedAt: calendarDate("Data de emissão"),
  validUntil: calendarDate("Data de validade"),
};

/** Revisão dos dados que o admin analisou (campo `revision` do detalhe). */
const revisionField = z.preprocess(
  (value) => (value === undefined || value === null || value === "" ? undefined : value),
  z.coerce
    .number({ error: "Informe a revisão analisada (revision)." })
    .int("Revisão inválida.")
    .min(0, "Revisão inválida.")
);

const reasonField = z.string({ error: "Motivo é obrigatório." }).trim().min(3, "Motivo é obrigatório.").max(500);

export const approveSchema = z.object({
  revision: revisionField,
  /** Documento que embasou a aprovação; padrão: o certificado mais recente. */
  documentId: optionalText(64),
  notes: optionalText(1000),
});

export const rejectSchema = z.object({
  revision: revisionField,
  reason: reasonField,
  notes: optionalText(1000),
});

/** Revogação parte de APPROVED, que não aceita edição: a revisão é opcional. */
export const revokeSchema = z.object({
  revision: revisionField.optional(),
  reason: reasonField,
  notes: optionalText(1000),
});

/** Converte o primeiro problema de validação num erro 400 legível. */
export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new CertificationError(400, result.error.issues[0]?.message ?? "Dados inválidos.");
  }
  return result.data;
}

/**
 * Tipo de cada arquivo enviado: `documentTypes` alinhado por posição com os arquivos (campo repetido
 * no multipart ou um único valor). Sem o campo, todos são CERTIFICATE.
 */
export function parseDocumentTypes(raw: unknown, fileCount: number): CertificationDocumentType[] {
  if (raw === undefined || raw === null || raw === "") {
    return Array.from({ length: fileCount }, () => CertificationDocumentType.CERTIFICATE);
  }
  const values = (Array.isArray(raw) ? raw : [raw]).map((value) => String(value).trim().toUpperCase());
  if (values.length !== fileCount) {
    throw new CertificationError(400, "Informe um tipo de documento para cada arquivo enviado.");
  }
  const allowed = Object.values(CertificationDocumentType) as string[];
  return values.map((value) => {
    if (!allowed.includes(value)) throw new CertificationError(400, `Tipo de documento inválido: ${value}.`);
    return value as CertificationDocumentType;
  });
}

/** Filtros do histórico (admin): ação, certificação, autor, período (datas de calendário em Brasília). */
export const historyQuerySchema = z
  .object({
    action: z.enum(["SUBMITTED", "RESUBMITTED", "DOCUMENT_ADDED", "APPROVED", "REJECTED", "REVOKED", "EXPIRED", "PAYMENT_CONFIRMED"]).optional(),
    certificationId: z.string().trim().min(1).optional(),
    actorId: z.string().trim().min(1).optional(),
    from: calendarDate("Data inicial").optional(),
    to: calendarDate("Data final").optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().trim().min(1).optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "A data inicial deve ser anterior à final.", path: ["from"] });

export type HistoryQuery = z.infer<typeof historyQuerySchema>;
