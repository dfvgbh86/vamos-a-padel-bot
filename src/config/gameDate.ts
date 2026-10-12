import { DateTime } from 'luxon';
import { CLUB_LUXON_OPTIONS } from './timezone.js';

declare const gameDateBrand: unique symbol;

/**
 * Calendar day of a game in club time, strictly `YYYY-MM-DD`.
 * The only way to obtain one is `parseGameDate` / `toGameDate`, so every date that reaches the
 * court guard, the open-time rule and the booking request body is the very same validated string.
 */
export type GameDate = string & { readonly [gameDateBrand]: true };

export class InvalidGameDateError extends Error {
  constructor(readonly input: unknown) {
    super(`Invalid game date (expected strict YYYY-MM-DD): ${safeDescribe(input)}`);
    this.name = 'InvalidGameDateError';
  }
}

const safeDescribe = (value: unknown): string => {
  if (typeof value === 'string') return JSON.stringify(value.slice(0, 40));
  return `<${typeof value}>`;
};

const FORMAT = 'yyyy-MM-dd';
const STRICT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const parseGameDate = (input: unknown): GameDate => {
  if (typeof input !== 'string' || !STRICT_PATTERN.test(input)) throw new InvalidGameDateError(input);
  if (!DateTime.fromFormat(input, FORMAT, CLUB_LUXON_OPTIONS).isValid) throw new InvalidGameDateError(input);
  return input as GameDate;
};

export const toGameDate = (moment: DateTime): GameDate => {
  if (!moment.isValid) throw new InvalidGameDateError(moment.invalidReason);
  return parseGameDate(moment.setZone(CLUB_LUXON_OPTIONS.zone).toFormat(FORMAT, CLUB_LUXON_OPTIONS));
};

/** Midnight at the start of the game day in club time. */
export const gameDateStart = (gameDate: GameDate): DateTime =>
  DateTime.fromFormat(gameDate, FORMAT, CLUB_LUXON_OPTIONS);

export const isWeekend = (gameDate: GameDate): boolean => gameDateStart(gameDate).weekday >= 6;
