export const BRASILIA_TIME_ZONE = "America/Sao_Paulo";

// Brasília não tem horário de verão desde 2019: o offset é fixo em UTC-3.
const BRASILIA_UTC_OFFSET_HOURS = 3;

/** Data de calendário (YYYY-MM-DD) de um instante no fuso de Brasília. */
export function brasiliaDateKey(date: Date): string {
  // en-CA formata como YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BRASILIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Instante (UTC) em que começa o dia atual no fuso de Brasília. */
export function startOfTodayInBrasilia(now: Date = new Date()): Date {
  const [year, month, day] = brasiliaDateKey(now).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, BRASILIA_UTC_OFFSET_HOURS));
}

/**
 * "YYYY-MM-DD" ou um ISO 8601 completo e válido ("YYYY-MM-DDTHH:mm[:ss[.sss]][Z|±HH:mm]").
 * A string inteira precisa casar: lixo depois da data é recusado.
 */
const CALENDAR_DATE_OR_ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/;

/**
 * Converte uma data de calendário "YYYY-MM-DD" (também aceita um ISO completo e válido, usando só a
 * parte da data) no instante em que esse dia começa em Brasília. Retorna null se o valor for malformado
 * ou a data não existir.
 */
export function brasiliaDateFromKey(value: string): Date | null {
  const trimmed = value.trim();
  const match = CALENDAR_DATE_OR_ISO.exec(trimmed);
  if (!match || Number.isNaN(Date.parse(trimmed))) return null;
  const [year, month, day] = match.slice(1, 4).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, BRASILIA_UTC_OFFSET_HOURS));
  // Rejeita datas que "transbordam" (ex.: 2026-02-30 → 2026-03-02).
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}
