import { z } from "zod";
import { FarmCertificationType } from "@prisma/client";
import {
  BRAZILIAN_UFS,
  CERTIFICATION_STATUSES,
  certificateFields,
  optionalText,
  positiveNumber,
  requiredText,
} from "./certification.schema";

// Validações comuns ficam em certification.schema.ts; re-exportadas aqui para quem já importava daqui.
export {
  BRAZILIAN_UFS,
  approveSchema,
  rejectSchema,
  revokeSchema,
  parseOrThrow,
  parseDocumentTypes,
} from "./certification.schema";

/** Dados da certificação de fazenda enviados pelo dono (criação e reenvio). */
export const farmCertificationInputSchema = z
  .object({
    farmName: requiredText("Nome da fazenda é obrigatório.", 2, 120),
    city: requiredText("Município é obrigatório.", 2, 80),
    uf: z
      .string({ error: "UF é obrigatória." })
      .trim()
      .toUpperCase()
      .pipe(z.enum(BRAZILIAN_UFS, { error: "UF inválida." })),
    ccir: optionalText(60),
    car: optionalText(60),
    areaHectares: positiveNumber("Área total (ha)", 10_000_000),
    type: z.enum(FarmCertificationType, { error: "Tipo de certificação inválido." }),
    ...certificateFields,
  })
  .refine((data) => Boolean(data.ccir || data.car), { message: "Informe o CCIR e/ou o CAR da fazenda.", path: ["ccir"] })
  .refine((data) => data.validUntil > data.issuedAt, { message: "A validade deve ser posterior à emissão.", path: ["validUntil"] });

export type FarmCertificationInput = z.infer<typeof farmCertificationInputSchema>;

export const listFarmCertificationsQuerySchema = z.object({
  status: z.enum(CERTIFICATION_STATUSES).optional(),
  type: z.enum(FarmCertificationType).optional(),
  userId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().trim().min(1).optional(),
});

export type ListFarmCertificationsQuery = z.infer<typeof listFarmCertificationsQuerySchema>;
