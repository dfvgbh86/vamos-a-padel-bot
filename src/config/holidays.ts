import { gameDateStart, parseGameDate, toGameDate, type GameDate } from './gameDate.js';

/**
 * Weekday holidays on which the academy does not play (all courts bookable).
 * Only high-confidence dates are seeded here; the owner extends the list via EXTRA_HOLIDAYS in .env.
 */
const DEFAULT_HOLIDAYS: readonly string[] = ['2026-12-08', '2026-12-25'];

export const buildHolidaySet = (extraRaw: string | undefined): ReadonlySet<GameDate> => {
  const extra = (extraRaw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const dates = new Set<GameDate>();
  const invalid: string[] = [];
  for (const entry of [...DEFAULT_HOLIDAYS, ...extra]) {
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
