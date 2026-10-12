import { DateTime } from 'luxon';
import { CLUB_TIME_ZONE } from '../config/timezone.js';
import { gameDateStart, toGameDate, type GameDate } from '../config/gameDate.js';

/**
 * A slot for day D becomes bookable `daysAhead` days before at `hour`:00 club time.
 * Verified 2026-10-12 (19 Oct open, 20 Oct closed; others booked 13 Oct slots on 6 Oct from 07:00:36);
 * the exact opening instant is re-measured at 07:00 on 2026-10-13, so the rule is configurable.
 */
export interface OpenRule {
  readonly daysAhead: number;
  readonly hour: number;
}

export const DEFAULT_OPEN_RULE: OpenRule = { daysAhead: 7, hour: 7 };

/** Moment (club time zone, DST-safe) when `gameDate` opens for booking. */
export const bookingOpensAt = (gameDate: GameDate, rule: OpenRule = DEFAULT_OPEN_RULE): DateTime =>
  gameDateStart(gameDate)
    .minus({ days: rule.daysAhead })
    .set({ hour: rule.hour, minute: 0, second: 0, millisecond: 0 });

/** Latest game date that is already open at `now` (inclusive). */
export const latestOpenGameDate = (now: DateTime, rule: OpenRule = DEFAULT_OPEN_RULE): GameDate => {
  if (!now.isValid) throw new Error(`latestOpenGameDate: invalid DateTime (${String(now.invalidReason)})`);
  const local = now.setZone(CLUB_TIME_ZONE);
  const opened = local.hour >= rule.hour ? local : local.minus({ days: 1 });
  return toGameDate(opened.plus({ days: rule.daysAhead }));
};
