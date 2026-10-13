import { DateTime } from 'luxon';
import { gameDateStart, toGameDate, type GameDate } from '../config/gameDate.js';
import { CLUB_LUXON_OPTIONS } from '../config/timezone.js';

/** Calendar day in club time of an instant (not the UTC day). */
export const clubDateOf = (epochMs: number): GameDate => toGameDate(DateTime.fromMillis(epochMs, CLUB_LUXON_OPTIONS));

/** Minutes since club midnight of an instant (0..1439), the unit of `SlotChoice.startMinutes`. */
export const clubMinuteOf = (epochMs: number): number => {
  const local = DateTime.fromMillis(epochMs, CLUB_LUXON_OPTIONS);
  return local.hour * 60 + local.minute;
};

export const addDays = (gameDate: GameDate, days: number): GameDate => toGameDate(gameDateStart(gameDate).plus({ days }));
