import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { parseGameDate } from '../src/config/gameDate.js';
import { bookingOpensAt, latestOpenGameDate } from '../src/sniper/openTime.js';

const date = parseGameDate;

describe('bookingOpensAt', () => {
  it('opens a day 7 days earlier at 07:00 Madrid time (summer time, UTC+2)', () => {
    const opens = bookingOpensAt(date('2026-10-20'));
    expect(opens.toISO()).toBe('2026-10-13T07:00:00.000+02:00');
    expect(opens.toUTC().toISO()).toBe('2026-10-13T05:00:00.000Z');
  });

  it('stays at 07:00 local time across the end of daylight saving (25 Oct 2026)', () => {
    // game day 1 Nov opens on 25 Oct, the day clocks go back; 07:00 is already CET (UTC+1)
    expect(bookingOpensAt(date('2026-11-01')).toISO()).toBe('2026-10-25T07:00:00.000+01:00');
  });

  it('also holds for the start of daylight saving (28 Mar 2027)', () => {
    // game day 4 Apr opens on 28 Mar, the day clocks go forward; 07:00 is already CEST (UTC+2)
    expect(bookingOpensAt(date('2027-04-04')).toISO()).toBe('2027-03-28T07:00:00.000+02:00');
  });

  it('is configurable', () => {
    const opens = bookingOpensAt(date('2026-10-20'), { daysAhead: 1, hour: 0 });
    expect(opens.toISO()).toBe('2026-10-19T00:00:00.000+02:00');
  });
});

describe('latestOpenGameDate', () => {
  it('is today + 7 once 07:00 has passed (12 Oct 2026 observation: 19 Oct open, 20 Oct closed)', () => {
    const now = DateTime.fromISO('2026-10-12T22:50:00', { zone: 'Europe/Madrid' });
    expect(latestOpenGameDate(now)).toBe('2026-10-19');
  });

  it('is still yesterday + 7 before 07:00', () => {
    const now = DateTime.fromISO('2026-10-13T06:59:59', { zone: 'Europe/Madrid' });
    expect(latestOpenGameDate(now)).toBe('2026-10-19');
  });

  it('moves forward at exactly 07:00', () => {
    const now = DateTime.fromISO('2026-10-13T07:00:00', { zone: 'Europe/Madrid' });
    expect(latestOpenGameDate(now)).toBe('2026-10-20');
  });

  it('gives the same answers for UTC inputs (07:00 Madrid is 05:00Z in summer)', () => {
    expect(latestOpenGameDate(DateTime.fromISO('2026-10-13T04:59:59.999Z', { setZone: true }))).toBe('2026-10-19');
    expect(latestOpenGameDate(DateTime.fromISO('2026-10-13T05:00:00Z', { setZone: true }))).toBe('2026-10-20');
    expect(latestOpenGameDate(DateTime.utc(2026, 10, 13, 5, 0, 0))).toBe('2026-10-20');
  });

  it('handles the daylight-saving change on 25 Oct 2026 (07:00 CET is 06:00Z)', () => {
    expect(latestOpenGameDate(DateTime.utc(2026, 10, 25, 5, 59, 59))).toBe('2026-10-31');
    expect(latestOpenGameDate(DateTime.utc(2026, 10, 25, 6, 0, 0))).toBe('2026-11-01');
  });

  it('throws for an invalid DateTime instead of returning a bogus date', () => {
    expect(() => latestOpenGameDate(DateTime.invalid('bad input'))).toThrow(/invalid DateTime/);
  });

  it('agrees with bookingOpensAt: the latest open date opens exactly at or before now', () => {
    const now = DateTime.fromISO('2026-10-13T07:00:00', { zone: 'Europe/Madrid' });
    const latest = latestOpenGameDate(now);
    expect(bookingOpensAt(latest) <= now).toBe(true);
    const next = parseGameDate(DateTime.fromISO(latest).plus({ days: 1 }).toISODate() ?? '');
    expect(bookingOpensAt(next) > now).toBe(true);
  });
});
