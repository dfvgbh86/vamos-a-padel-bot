import { DateTime } from 'luxon';
import { allowedCourtIds } from '../config/courts.js';
import { gameDateStart, toGameDate, type GameDate } from '../config/gameDate.js';
import { CLUB_LUXON_OPTIONS } from '../config/timezone.js';
import type { AccountContext, Clock, DaySchedule, ReservaplayApi, SlotRef } from '../contracts.js';
import { MIN_DURATION_MINUTES } from '../reservaplay/bookingBody.js';
import { AuthExpiredError } from '../reservaplay/errors.js';
import type { Pacer } from './clock.js';
import { hasOwnBooking } from './ownBooking.js';
import { latestOpenGameDate } from './openTime.js';
import { describeError, type SniperLogger } from './types.js';

export const firstFreeAllowedSlot = (
  day: DaySchedule,
  gameDate: GameDate,
  holidays: ReadonlySet<GameDate>,
): SlotRef | null => {
  const allowed = new Set(allowedCourtIds(gameDate, holidays));
  for (const court of day.courts) {
    if (!allowed.has(court.courtId)) continue;
    const slot = court.slots.find(
      (candidate) => candidate.free && !candidate.ownBooking && candidate.durationMinutes >= MIN_DURATION_MINUTES,
    );
    if (slot !== undefined) {
      return { gameDate, courtId: court.courtId, startMinutes: slot.startMinutes, durationMinutes: slot.durationMinutes };
    }
  }
  return null;
};

export interface SampleSearch {
  readonly api: ReservaplayApi;
  readonly clock: Clock;
  readonly holidays: ReadonlySet<GameDate>;
  readonly logger: SniperLogger;
  readonly searchDays: number;
  readonly pace: Pacer;
}

/**
 * The account hash only appears on a rendered booking form, and the site renders none on a day on which the
 * account already has a booking. Walks the open days downwards from the newest one and reads the context from the
 * first free slot of an allowed court on a day without an own booking (that includes the job's own date).
 * Throws AuthExpiredError; any other failure moves on to the next day. Null when no day worked.
 */
export const findAccountContext = async (search: SampleSearch): Promise<AccountContext | null> => {
  const { api, clock, holidays, logger } = search;
  const now = DateTime.fromMillis(clock.nowMs(), CLUB_LUXON_OPTIONS);
  const today = toGameDate(now);
  const newest = gameDateStart(latestOpenGameDate(now));
  for (let back = 0; back < search.searchDays; back++) {
    const date = toGameDate(newest.minus({ days: back }));
    if (date < today) break;
    try {
      await search.pace();
      const day = await api.getDay(date);
      if (hasOwnBooking(day)) continue;
      const sample = firstFreeAllowedSlot(day, date, holidays);
      if (sample === null) continue;
      await search.pace();
      return await api.getAccountContext(sample);
    } catch (error) {
      if (error instanceof AuthExpiredError) throw error;
      logger.warn({ daysBack: back, ...describeError(error) }, 'sample slot unusable; trying the previous day');
    }
  }
  return null;
};
