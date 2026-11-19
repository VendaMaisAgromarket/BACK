import { z } from "zod";
import { HarvestCertificationType, HarvestProductionUnit } from "@prisma/client";
import { brasiliaDateKey } from "../../lib/brasiliaTime";
import {
  calendarDate,
  CERTIFICATION_STATUSES,
  certificateFields,
  optionalText,
  positiveNumber,
  requiredText,
} from "./certification.schema";

/** Ano agrícola: "2026/27" (dois anos consecutivos) ou um ano só ("2026"). */
const HARVEST_SEASON = /^(\d{4})(?:\/(\d{2}))?$/;

/** Anos de calendário cobertos pelo ano agrícola ("2026/27" → [2026, 2027]). Null se inválido. */
export function harvestSeasonYears(season: string): number[] | null {
  const match = HARVEST_SEASON.exec(season);
  if (!match) return null;
  const start = Number(match[1]);
  if (match[2] === undefined) return [start];
  return Number(match[2]) === (start + 1) % 100 ? [start, start + 1] : null;
}

/** Dados da certificação de safra enviados pelo dono (criação e reenvio). */
export const harvestCertificationInputSchema = z
  .object({
    harvestSeason: z
      .string({ error: "Safra (ano agrícola) é obrigatória." })
      .trim()
      .refine((value) => harvestSeasonYears(value) !== null, "Safra inválida: use o ano agrícola, ex.: 2026/27 (ou 2026)."),
    crop: requiredText("Cultura é obrigatória.", 2, 80),
    variety: optionalText(80),
    plotIdentifier: requiredText("Talhão/lote é obrigatório.", 1, 80),
    plantedAreaHectares: positiveNumber("Área plantada (ha)", 10_000_000),
    estimatedProduction: positiveNumber("Produção estimada", 1_000_000_000_000),
    productionUnit: z
      .string({ error: "Unidade da produção é obrigatória." })
      .trim()
      .toUpperCase()
      .pipe(z.enum(HarvestProductionUnit, { error: "Unidade da produção inválida: use KG ou TON." })),
    plantingDate: calendarDate("Data de plantio"),
    harvestDate: calendarDate("Data de colheita"),
    type: z.enum(HarvestCertificationType, { error: "Tipo de certificação inválido." }),
    ...certificateFields,
  })
  .refine((data) => data.harvestDate >= data.plantingDate, {
    message: "A data de colheita não pode ser anterior à de plantio.",
    path: ["harvestDate"],
  })
  .refine((data) => harvestSeasonYears(data.harvestSeason)?.includes(Number(brasiliaDateKey(data.harvestDate).slice(0, 4))) ?? true, {
    message: "A data de colheita não pertence à safra (ano agrícola) informada.",
    path: ["harvestDate"],
  })
  .refine((data) => data.validUntil > data.issuedAt, { message: "A validade deve ser posterior à emissão.", path: ["validUntil"] });

export type HarvestCertificationInput = z.infer<typeof harvestCertificationInputSchema>;

export const listHarvestCertificationsQuerySchema = z.object({
  status: z.enum(CERTIFICATION_STATUSES).optional(),
  type: z.enum(HarvestCertificationType).optional(),
  userId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().trim().min(1).optional(),
});
