import { gameDateStart, parseGameDate, toGameDate, type GameDate } from './gameDate.js';

/**
 * Official non-working days of the city of Valencia: on these days the academy does not play, so every
 * court may be booked (same as a weekend). Dates that fall on a weekend change nothing but are kept so the
 * list mirrors the official calendar.
 *
 * Sources (checked 2026-10-12):
 * - 2026: Decreto 100/2025 del Consell (calendario laboral 2026, DOGV 7 Jul 2025) + local holidays of
 *   the city of Valencia (22 Jan San Vicente Mártir, 13 Apr San Vicente Ferrer; Resolución 12 Nov 2025, DOGV 14 Nov 2025).
 * - 2027: Decreto 42/2026 del Consell (calendario laboral 2027, approved 20 Mar 2026). San Juan (24 Jun) is no
 *   longer a holiday in 2027. The 2027 local holidays of Valencia city are NOT included until they are published
 *   in the DOGV (a wrong holiday would unlock academy courts); add them through EXTRA_HOLIDAYS meanwhile.
 *
 * The club is assumed to be in the city of Valencia. Anything else the owner knows about goes into
 * EXTRA_HOLIDAYS in .env.
 */
const OFFICIAL_HOLIDAYS: readonly string[] = [
  // 2026 - autonomic / national
  '2026-01-01', // Año Nuevo
  '2026-01-06', // Epifanía del Señor
  '2026-03-19', // San José
  '2026-04-03', // Viernes Santo
  '2026-04-06', // Lunes de Pascua
  '2026-05-01', // Fiesta del Trabajo
  '2026-06-24', // San Juan
  '2026-08-15', // Asunción de la Virgen
  '2026-10-09', // Día de la Comunitat Valenciana
  '2026-10-12', // Fiesta Nacional de España
  '2026-12-08', // Inmaculada Concepción
  '2026-12-25', // Natividad del Señor
  // 2026 - local, city of Valencia
  '2026-01-22', // San Vicente Mártir
  '2026-04-13', // Lunes de San Vicente Ferrer

  // 2027 - autonomic / national
  '2027-01-01', // Año Nuevo
  '2027-01-06', // Epifanía del Señor
  '2027-03-19', // San José
  '2027-03-26', // Viernes Santo
  '2027-03-29', // Lunes de Pascua
  '2027-05-01', // Fiesta del Trabajo
  '2027-10-09', // Día de la Comunitat Valenciana
  '2027-10-12', // Fiesta Nacional de España
  '2027-11-01', // Todos los Santos
  '2027-12-06', // Día de la Constitución
  '2027-12-08', // Inmaculada Concepción
  '2027-12-25', // Natividad del Señor
];

export const buildHolidaySet = (extraRaw: string | undefined): ReadonlySet<GameDate> => {
  const extra = (extraRaw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const dates = new Set<GameDate>();
  const invalid: string[] = [];
  for (const entry of [...OFFICIAL_HOLIDAYS, ...extra]) {
    try {
      dates.add(parseGameDate(entry));
    } catch {
      invalid.push(entry);
    }
  }
  if (invalid.length > 0) {
    throw new Error(`EXTRA_HOLIDAYS has invalid dates (expected real YYYY-MM-DD): ${invalid.join(', ')}`);
  }
  return dates;
};

/** Holidays in `[from, from + days)`, sorted. Shown in /status so a wrong date is noticed by the owner. */
export const holidaysWithin = (
  holidays: ReadonlySet<GameDate>,
  from: GameDate,
  days: number,
): GameDate[] => {
  const start = gameDateStart(from);
  const end = start.plus({ days });
  return [...holidays]
    .filter((date) => {
      const moment = gameDateStart(date);
      return moment >= start && moment < end;
    })
    .sort();
};

export { toGameDate };
