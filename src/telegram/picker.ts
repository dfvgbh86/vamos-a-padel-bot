import type { GameDate } from '../config/gameDate.js';
import { DEFAULT_DURATION_MINUTES } from '../reservaplay/bookingBody.js';
import type { Clock, DaySchedule, JobService } from '../contracts.js';
import type { OpenRule } from '../sniper/openTime.js';
import { COMMON_START_MINUTES, gridStarts, latestOpenDate } from './schedule.js';
import type { PickerMode } from './sessions.js';
import { SCHEDULE_TIMEOUT_MS, TIMED_OUT, withTimeout } from './timeout.js';
import { describeError } from './text.js';
import type { TelegramLogger } from './types.js';

export interface PickerDeps {
  readonly service: JobService;
  readonly clock: Clock;
  readonly logger: TelegramLogger;
  /** When windows open; the default rule when absent. */
  readonly openRule?: OpenRule;
}

/** The schedule of a day, or null when the site/service cannot provide a usable one right now. */
export const tryGetDay = async (deps: PickerDeps, gameDate: GameDate): Promise<DaySchedule | null> => {
  try {
    const schedule = await withTimeout(deps.service.getDay(gameDate), SCHEDULE_TIMEOUT_MS, deps.clock);
    if (schedule === TIMED_OUT) {
      deps.logger.warn({ gameDate }, 'telegram: day schedule timed out');
      return null;
    }
    return schedule.gameDate === gameDate ? schedule : null;
  } catch (error) {
    deps.logger.warn({ gameDate, ...describeError(error) }, 'telegram: day schedule unavailable');
    return null;
  }
};

const hasSlotsForAllowedCourt = (schedule: DaySchedule, allowedCourtIds: readonly number[]): boolean =>
  schedule.courts.some((court) => allowedCourtIds.includes(court.courtId) && court.slots.length > 0);

/**
 * Where the start times for `gameDate` come from, best source first: the real schedule of that date; for a date
 * that is not open yet the typical grid of the latest open day; finally the fixed half-hour keyboard.
 */
export const loadPickerMode = async (deps: PickerDeps, gameDate: GameDate, nowMs: number): Promise<PickerMode> => {
  const schedule = await tryGetDay(deps, gameDate);
  if (schedule !== null && hasSlotsForAllowedCourt(schedule, deps.service.allowedCourts(gameDate))) {
    return { kind: 'schedule', schedule };
  }

  const latestOpen = latestOpenDate(nowMs, deps.openRule);
  if (gameDate > latestOpen) {
    const typical = await tryGetDay(deps, latestOpen);
    const starts = typical === null ? [] : gridStarts(typical, DEFAULT_DURATION_MINUTES);
    if (starts.length > 0) return { kind: 'grid', source: 'open-day', starts };
  }
  return { kind: 'grid', source: 'common', starts: COMMON_START_MINUTES };
};
