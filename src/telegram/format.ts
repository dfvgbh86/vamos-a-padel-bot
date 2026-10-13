import { DateTime } from 'luxon';
import { COURTS } from '../config/courts.js';
import { gameDateStart, type GameDate } from '../config/gameDate.js';
import { CLUB_LUXON_OPTIONS } from '../config/timezone.js';

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] as const;
const MINUTES_PER_DAY = 24 * 60;

/** Integer euro cents => "19,02 €". */
export const formatMoney = (cents: number): string => {
  if (!Number.isFinite(cents)) return '? €';
  const rounded = Math.round(Math.abs(cents));
  const euros = Math.floor(rounded / 100);
  const rest = String(rounded % 100).padStart(2, '0');
  return `${cents < 0 && rounded > 0 ? '-' : ''}${euros},${rest} €`;
};

/** Minutes from midnight => "18:00" (wraps past midnight). */
export const formatClock = (minutes: number): string => {
  const wrapped = ((Math.trunc(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
  const mm = String(wrapped % 60).padStart(2, '0');
  return `${hh}:${mm}`;
};

export const formatTimeRange = (startMinutes: number, durationMinutes: number): string =>
  `${formatClock(startMinutes)}–${formatClock(startMinutes + durationMinutes)}`;

const weekdayName = (day: DateTime): string => WEEKDAYS[day.weekday - 1] ?? '';

/** "вт 20.10" */
export const formatDayShort = (gameDate: GameDate): string => {
  const day = gameDateStart(gameDate);
  return `${weekdayName(day)} ${day.toFormat('dd.MM')}`;
};

/** "вт 20.10.2026" */
export const formatDayLong = (gameDate: GameDate): string => {
  const day = gameDateStart(gameDate);
  return `${weekdayName(day)} ${day.toFormat('dd.MM.yyyy')}`;
};

/** "20.10" for any strict YYYY-MM-DD string. */
export const formatDayMonth = (gameDate: string): string => {
  const day = DateTime.fromFormat(gameDate, 'yyyy-MM-dd', CLUB_LUXON_OPTIONS);
  return day.isValid ? day.toFormat('dd.MM') : '?';
};

/** Club-time wall clock of an instant: "13.10 07:00". */
export const formatMadrid = (epochMs: number): string => {
  const moment = DateTime.fromMillis(epochMs, CLUB_LUXON_OPTIONS);
  return moment.isValid ? moment.toFormat('dd.MM HH:mm') : '?';
};

/** Display name from the court table ("Pista 7 semicubierta"), never the bare resource id. */
export const courtName = (courtId: number): string =>
  COURTS.find((court) => court.id === courtId)?.name ?? `корт (id ${courtId})`;
