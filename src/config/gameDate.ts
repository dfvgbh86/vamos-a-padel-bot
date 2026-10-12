import { DateTime } from 'luxon';
import { CLUB_TIME_ZONE } from './timezone.js';

declare const gameDateBrand: unique symbol;

/**
 * Calendar day of a game in club time, strictly `YYYY-MM-DD`.
 * The only way to obtain one is `parseGameDate` / `toGameDate`, so every date that reaches the
 * court guard, the open-time rule and the booking request body is the very same validated string.
 */
export type GameDate = string & { readonly [gameDateBrand]: true };

export class InvalidGameDateError extends Error {
  constructor(readonly input: string) {
    super(`Invalid game date (expected strict YYYY-MM-DD): ${JSON.stringify(input)}`);
    this.name = 'InvalidGameDateError';
  }
}

const FORMAT = 'yyyy-MM-dd';
const STRICT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const parseGameDate = (input: string): GameDate => {
  if (!STRICT_PATTERN.test(input)) throw new InvalidGameDateError(input);
  if (!DateTime.fromFormat(input, FORMAT, { zone: CLUB_TIME_ZONE }).isValid) {
    throw new InvalidGameDateError(input);
  }
  return input as GameDate;
};

export const toGameDate = (moment: DateTime): GameDate => {
  if (!moment.isValid) throw new InvalidGameDateError(String(moment.invalidReason));
  return parseGameDate(moment.setZone(CLUB_TIME_ZONE).toFormat(FORMAT));
};

/** Midnight at the start of the game day in club time. */
export const gameDateStart = (gameDate: GameDate): DateTime =>
  DateTime.fromFormat(gameDate, FORMAT, { zone: CLUB_TIME_ZONE });

export const isWeekend = (gameDate: GameDate): boolean => gameDateStart(gameDate).weekday >= 6;
