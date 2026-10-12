/**
 * QA helpers: a hand-written seeded PRNG (no fast-check dependency) and an ORACLE for calendar
 * arithmetic / Europe/Madrid wall-clock time that does NOT use luxon or any code from src/,
 * so the tests cannot be fooled by the same bug as the implementation.
 */
import { parseGameDate, type GameDate } from '../../src/config/gameDate.js';

/** mulberry32: small, fast, deterministic. */
export const makeRng = (seed: number) => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (minInclusive: number, maxInclusive: number): number =>
      minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1)),
    bool: (probability = 0.5): boolean => next() < probability,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
  };
};
export type Rng = ReturnType<typeof makeRng>;

const DAY_MS = 86_400_000;

const utcMs = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y as number, (m as number) - 1, d as number);
};

export const addDays = (iso: string, days: number): string =>
  new Date(utcMs(iso) + days * DAY_MS).toISOString().slice(0, 10);

/** 0 = Sunday ... 6 = Saturday, computed without luxon. */
export const dayOfWeek = (iso: string): number => new Date(utcMs(iso)).getUTCDay();

export const isRealCalendarDate = (iso: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  return new Date(utcMs(iso)).toISOString().slice(0, 10) === iso;
};

export const eachDay = (from: string, to: string): string[] => {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
};

export const eachGameDate = (from: string, to: string): GameDate[] => eachDay(from, to).map(parseGameDate);

const MADRID = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export interface LocalParts {
  readonly date: string;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** Madrid wall-clock fields of an absolute instant, from the platform's ICU (not luxon). */
export const madridLocal = (epochMs: number): LocalParts => {
  const get: Record<string, string> = {};
  for (const part of MADRID.formatToParts(new Date(epochMs))) get[part.type] = part.value;
  return {
    date: `${get['year']}-${get['month']}-${get['day']}`,
    hour: Number(get['hour']),
    minute: Number(get['minute']),
    second: Number(get['second']),
  };
};

/** The instant at which Madrid wall-clock reads `date` `hour`:00:00 (hour must not be in a DST gap/overlap). */
export const madridInstant = (date: string, hour: number): number => {
  const naive = utcMs(date) + hour * 3_600_000;
  for (const offsetHours of [1, 2]) {
    const candidate = naive - offsetHours * 3_600_000;
    const local = madridLocal(candidate);
    if (local.date === date && local.hour === hour && local.minute === 0 && local.second === 0) return candidate;
  }
  throw new Error(`no unique Madrid instant for ${date} ${hour}:00`);
};

/** Oracle for latestOpenGameDate with the default rule (7 days ahead, 07:00 Madrid). */
export const oracleLatestOpen = (epochMs: number, daysAhead = 7, hour = 7): string => {
  const local = madridLocal(epochMs);
  const base = local.hour >= hour ? local.date : addDays(local.date, -1);
  return addDays(base, daysAhead);
};

/** Unique marker used to prove that a body was not echoed back by a classifier. */
export const ECHO_MARKER = 'ZZ-QA-ECHO-MARKER-ZZ';

/** A syntactically valid, obviously synthetic booking hash (never a real one). */
export const FAKE_HASH = '0123456789abcdef0123456789abcdef01234567';
