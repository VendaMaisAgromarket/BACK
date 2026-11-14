import { z } from "zod";
import { CertificationDocumentType, FarmCertificationType } from "@prisma/client";
import { formatToCNPJ, isCNPJ } from "brazilian-values";
import { brasiliaDateFromKey } from "../../lib/brasiliaTime";
import { CertificationError } from "./certification.errors";

export const BRAZILIAN_UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
  "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
] as const;

/** Campos chegam como texto (multipart): vazio vale como "não informado". */
const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional()
  );

const calendarDate = (label: string) =>
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

/** Dados da certificação de fazenda enviados pelo produtor (criação e reenvio). */
export const farmCertificationInputSchema = z
  .object({
    farmName: z.string({ error: "Nome da fazenda é obrigatório." }).trim().min(2, "Nome da fazenda é obrigatório.").max(120),
    city: z.string({ error: "Município é obrigatório." }).trim().min(2, "Município é obrigatório.").max(80),
    uf: z
      .string({ error: "UF é obrigatória." })
      .trim()
      .toUpperCase()
      .pipe(z.enum(BRAZILIAN_UFS, { error: "UF inválida." })),
    ccir: optionalText(60),
    car: optionalText(60),
    areaHectares: z.coerce
      .number({ error: "Área total (ha) é obrigatória." })
      .positive("Área total (ha) deve ser maior que zero.")
      .max(10_000_000, "Área total (ha) inválida."),
    type: z.enum(FarmCertificationType, { error: "Tipo de certificação inválido." }),
    certifierName: z.string({ error: "Nome da certificadora é obrigatório." }).trim().min(2, "Nome da certificadora é obrigatório.").max(120),
    certifierCnpj: z
      .string({ error: "CNPJ da certificadora é obrigatório." })
      .trim()
      .refine((value) => isCNPJ(value), "CNPJ da certificadora inválido.")
      .transform((value) => formatToCNPJ(value)),
    certificateNumber: z.string({ error: "Número do certificado é obrigatório." }).trim().min(1, "Número do certificado é obrigatório.").max(80),
    issuedAt: calendarDate("Data de emissão"),
    validUntil: calendarDate("Data de validade"),
  })
  .refine((data) => Boolean(data.ccir || data.car), { message: "Informe o CCIR e/ou o CAR da fazenda.", path: ["ccir"] })
  .refine((data) => data.validUntil > data.issuedAt, { message: "A validade deve ser posterior à emissão.", path: ["validUntil"] });

export type FarmCertificationInput = z.infer<typeof farmCertificationInputSchema>;

export const listFarmCertificationsQuerySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "REVOKED"]).optional(),
  type: z.enum(FarmCertificationType).optional(),
  userId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().trim().min(1).optional(),
});

export type ListFarmCertificationsQuery = z.infer<typeof listFarmCertificationsQuerySchema>;

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
