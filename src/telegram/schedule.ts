import { DateTime } from 'luxon';
import { gameDateStart, toGameDate, type GameDate } from '../config/gameDate.js';
import { CLUB_LUXON_OPTIONS } from '../config/timezone.js';
import { bookingOpensAt, DEFAULT_OPEN_RULE, latestOpenGameDate, type OpenRule } from '../sniper/openTime.js';
import type { DayCourt, DaySchedule } from '../contracts.js';
import type { PickerMode } from './sessions.js';

/** Manual-time keyboard used when no schedule is available: 09:00 ... 21:00 every 30 minutes. */
export const COMMON_START_MINUTES: readonly number[] = Array.from({ length: 25 }, (_, index) => 9 * 60 + index * 30);

export const MAX_CHOICES = 8;

/** Game lengths offered in /new (the club's minimum is 60 minutes). */
export const DURATION_OPTIONS: readonly number[] = [60, 90];

/** Typed start times must fall inside these club hours (the calendar runs from 07:30 to 22:30). */
export const EARLIEST_START_MINUTES = 7 * 60;
export const LATEST_END_MINUTES = 23 * 60;

const MAX_DATE_BUTTONS = 14;

export interface OfferedDate {
  readonly date: GameDate;
  /** The window for this date is already open. */
  readonly open: boolean;
  readonly opensAtMs: number;
}

const nextDay = (gameDate: GameDate): GameDate => toGameDate(gameDateStart(gameDate).plus({ days: 1 }));

/** Today (club time) up to the furthest open date plus one: the next date to open is offered too. */
export const offeredDates = (nowMs: number, rule: OpenRule = DEFAULT_OPEN_RULE): readonly OfferedDate[] => {
  const now = DateTime.fromMillis(nowMs, CLUB_LUXON_OPTIONS);
  const latestOpen = latestOpenGameDate(now, rule);
  const last = nextDay(latestOpen);
  const offered: OfferedDate[] = [];
  for (let date = toGameDate(now); date <= last && offered.length < MAX_DATE_BUTTONS; date = nextDay(date)) {
    offered.push({ date, open: date <= latestOpen, opensAtMs: bookingOpensAt(date, rule).toMillis() });
  }
  return offered;
};

export const latestOpenDate = (nowMs: number, rule: OpenRule = DEFAULT_OPEN_RULE): GameDate =>
  latestOpenGameDate(DateTime.fromMillis(nowMs, CLUB_LUXON_OPTIONS), rule);

/**
 * Start times at which `durationMinutes` fit: the slot itself, or a run of back-to-back slots, covers the duration
 * (the grid mixes 30/60/90 minute slots). With `requireFree` every slot of the run must be free.
 */
export const startsFor = (court: DayCourt, durationMinutes: number, requireFree: boolean): readonly number[] => {
  const slots = [...court.slots].sort((a, b) => a.startMinutes - b.startMinutes);
  const starts = new Set<number>();
  slots.forEach((slot, index) => {
    let covered = 0;
    let end = slot.startMinutes;
    for (let cursor = index; cursor < slots.length && covered < durationMinutes; cursor += 1) {
      const current = slots[cursor];
      if (current === undefined || current.startMinutes !== end || (requireFree && !current.free)) break;
      covered += current.durationMinutes;
      end = current.endMinutes;
    }
    if (covered >= durationMinutes) starts.add(slot.startMinutes);
  });
  return [...starts].sort((a, b) => a - b);
};

export const freeStarts = (court: DayCourt, durationMinutes: number): readonly number[] =>
  startsFor(court, durationMinutes, true);

/** Union of the start times of every court of a day, free or not: the "typical grid" of that day. */
export const gridStarts = (schedule: DaySchedule, durationMinutes: number): readonly number[] => {
  const starts = new Set<number>();
  for (const court of schedule.courts) {
    for (const start of startsFor(court, durationMinutes, false)) starts.add(start);
  }
  return [...starts].sort((a, b) => a - b);
};

export const hasOwnBooking = (schedule: DaySchedule): boolean =>
  schedule.courts.some((court) => court.slots.some((slot) => slot.ownBooking));

/** Start times offered for one court in the given mode (empty when the court has none). */
export const startsForCourt = (mode: PickerMode, courtId: number, durationMinutes: number): readonly number[] => {
  if (mode.kind === 'grid') return mode.starts;
  const court = mode.schedule.courts.find((candidate) => candidate.courtId === courtId);
  return court === undefined ? [] : freeStarts(court, durationMinutes);
};

export interface CourtOption {
  readonly courtId: number;
  /** Number of offered start times, or null when the times come from a fixed grid. */
  readonly startCount: number | null;
}

/** Courts the owner may pick for the date; with a real schedule, courts without a free fitting slot are left out. */
export const courtOptions = (
  allowedCourtIds: readonly number[],
  mode: PickerMode,
  durationMinutes: number,
): readonly CourtOption[] => {
  if (mode.kind === 'grid') return allowedCourtIds.map((courtId) => ({ courtId, startCount: null }));
  return allowedCourtIds
    .map((courtId) => ({ courtId, startCount: startsForCourt(mode, courtId, durationMinutes).length }))
    .filter((option) => option.startCount > 0);
};
