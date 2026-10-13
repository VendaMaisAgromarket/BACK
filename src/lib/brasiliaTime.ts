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
