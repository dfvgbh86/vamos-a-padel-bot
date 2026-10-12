import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { parseGameDate, type GameDate } from '../../src/config/gameDate.js';
import { bookingOpensAt, DEFAULT_OPEN_RULE, latestOpenGameDate, type OpenRule } from '../../src/sniper/openTime.js';
import { addDays, eachDay, eachGameDate, madridInstant, madridLocal, makeRng, oracleLatestOpen } from './_helpers.js';

const days = eachGameDate('2026-01-01', '2027-12-31');
const HOUR = 3_600_000;
const asUtc = (epochMs: number): DateTime => DateTime.fromMillis(epochMs, { zone: 'UTC' });

describe('QA openTime: bookingOpensAt for every game day of 2026-2027', () => {
  it('the default rule is 7 days ahead at 07:00', () => {
    expect(DEFAULT_OPEN_RULE).toEqual({ daysAhead: 7, hour: 7 });
  });

  it('is always 07:00:00.000 Madrid local time, on exactly D-7, at the right absolute instant', () => {
    for (const day of days) {
      const opens = bookingOpensAt(day);
      expect(opens.isValid, day).toBe(true);
      expect(opens.zoneName, day).toBe('Europe/Madrid');
      expect([opens.hour, opens.minute, opens.second, opens.millisecond], day).toEqual([7, 0, 0, 0]);
      const local = madridLocal(opens.toMillis());
      expect(local.date, `local date of the opening of ${day}`).toBe(addDays(day, -7));
      expect([local.hour, local.minute, local.second], day).toEqual([7, 0, 0]);
      expect(opens.toMillis(), day).toBe(madridInstant(addDays(day, -7), 7));
    }
  });

  it('is strictly monotonic: consecutive game days open 24 h apart, except the 4 DST changes (23 h / 25 h)', () => {
    const odd: Array<{ day: string; hours: number }> = [];
    for (let i = 1; i < days.length; i += 1) {
      const previous = bookingOpensAt(days[i - 1] as GameDate).toMillis();
      const current = bookingOpensAt(days[i] as GameDate).toMillis();
      expect(current, days[i]).toBeGreaterThan(previous);
      const hours = (current - previous) / HOUR;
      expect([23, 24, 25], `${days[i]} gap ${hours}h`).toContain(hours);
      if (hours !== 24) odd.push({ day: days[i] as string, hours });
    }
    expect(odd).toEqual([
      { day: '2026-04-05', hours: 23 }, // opens 2026-03-29, clocks forward
      { day: '2026-11-01', hours: 25 }, // opens 2026-10-25, clocks back
      { day: '2027-04-04', hours: 23 }, // opens 2027-03-28
      { day: '2027-11-07', hours: 25 }, // opens 2027-10-31
    ]);
  });

  it('known DST anchors', () => {
    const iso = (day: string) => bookingOpensAt(parseGameDate(day)).toISO();
    expect(iso('2026-04-04')).toBe('2026-03-28T07:00:00.000+01:00');
    expect(iso('2026-04-05')).toBe('2026-03-29T07:00:00.000+02:00');
    expect(iso('2026-10-31')).toBe('2026-10-24T07:00:00.000+02:00');
    expect(iso('2026-11-01')).toBe('2026-10-25T07:00:00.000+01:00');
    expect(iso('2027-04-03')).toBe('2027-03-27T07:00:00.000+01:00');
    expect(iso('2027-04-04')).toBe('2027-03-28T07:00:00.000+02:00');
    expect(iso('2027-11-06')).toBe('2027-10-30T07:00:00.000+02:00');
    expect(iso('2027-11-07')).toBe('2027-10-31T07:00:00.000+01:00');
  });

  it('the game day that is itself a DST day opens at 07:00 on D-7 as usual', () => {
    expect(bookingOpensAt(parseGameDate('2026-03-29')).toISO()).toBe('2026-03-22T07:00:00.000+01:00');
    expect(bookingOpensAt(parseGameDate('2026-10-25')).toISO()).toBe('2026-10-18T07:00:00.000+02:00');
    expect(bookingOpensAt(parseGameDate('2027-03-28')).toISO()).toBe('2027-03-21T07:00:00.000+01:00');
    expect(bookingOpensAt(parseGameDate('2027-10-31')).toISO()).toBe('2027-10-24T07:00:00.000+02:00');
  });
});

describe('QA openTime: latestOpenGameDate is consistent with bookingOpensAt', () => {
  it('latestOpenGameDate(opensAt(D)) === D and one millisecond earlier gives D-1, for every D (any input zone)', () => {
    const zones = ['Europe/Madrid', 'UTC', 'America/New_York', 'Pacific/Kiritimati', 'Asia/Tokyo'] as const;
    days.forEach((day, index) => {
      const opens = bookingOpensAt(day).toMillis();
      const zone = zones[index % zones.length] as string;
      const at = (offsetMs: number) => DateTime.fromMillis(opens + offsetMs, { zone });
      expect(latestOpenGameDate(at(0)), `${day} @opens`).toBe(day);
      expect(latestOpenGameDate(at(1)), `${day} @opens+1ms`).toBe(day);
      expect(latestOpenGameDate(at(-1)), `${day} @opens-1ms`).toBe(addDays(day, -1));
      expect(latestOpenGameDate(at(-1000)), `${day} @opens-1s`).toBe(addDays(day, -1));
      const next = bookingOpensAt(addDays(day, 1) as GameDate).toMillis();
      expect(latestOpenGameDate(at(next - opens - 1)), `${day} @next opens-1ms`).toBe(day);
    });
  });

  it('exhaustive 30-minute sweep 2026-01-01 .. 2027-12-31 agrees with an ICU-based oracle (incl. all four DST changes)', () => {
    const start = Date.UTC(2026, 0, 1);
    const end = Date.UTC(2027, 11, 31, 23, 30);
    let previous = '';
    let samples = 0;
    for (let t = start; t <= end; t += 30 * 60_000) {
      const got = latestOpenGameDate(asUtc(t));
      expect(got, new Date(t).toISOString()).toBe(oracleLatestOpen(t));
      expect(got >= previous, `latestOpenGameDate must never go backwards at ${new Date(t).toISOString()}`).toBe(true);
      previous = got;
      samples += 1;
    }
    expect(samples).toBeGreaterThan(35_000);
  }, 120_000);

  it('around each DST change, minute by minute from 04:00Z to 08:00Z, matches the oracle', () => {
    for (const day of ['2026-03-29', '2026-10-25', '2027-03-28', '2027-10-31']) {
      const base = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
      let flips = 0;
      let last = '';
      for (let minute = 4 * 60; minute <= 8 * 60; minute += 1) {
        const t = base + minute * 60_000;
        const got = latestOpenGameDate(asUtc(t));
        expect(got, new Date(t).toISOString()).toBe(oracleLatestOpen(t));
        if (last !== '' && got !== last) flips += 1;
        last = got;
      }
      expect(flips, `${day}: exactly one date flip in the 07:00 window`).toBe(1);
    }
  });

  it('randomised instants (seeded) incl. sub-second precision', () => {
    const rng = makeRng(0xc0ffee);
    const start = Date.UTC(2025, 11, 1);
    const span = Date.UTC(2028, 0, 1) - start;
    for (let i = 0; i < 10_000; i += 1) {
      const t = start + Math.floor(rng.next() * span);
      expect(latestOpenGameDate(asUtc(t)), new Date(t).toISOString()).toBe(oracleLatestOpen(t));
    }
  });

  it('every instant strictly between two openings maps to the earlier game day (hourly, all of 2026-2027)', () => {
    const lastDay = days.length - 1;
    for (let i = 0; i < lastDay; i += 1) {
      const from = bookingOpensAt(days[i] as GameDate).toMillis();
      const to = bookingOpensAt(days[i + 1] as GameDate).toMillis();
      for (let t = from; t < to; t += HOUR) expect(latestOpenGameDate(asUtc(t)), new Date(t).toISOString()).toBe(days[i]);
    }
  }, 120_000);

  it('rejects invalid DateTime and non-DateTime input instead of guessing', () => {
    expect(() => latestOpenGameDate(DateTime.invalid('x'))).toThrow(/invalid DateTime/);
    expect(() => latestOpenGameDate(new Date(0) as unknown as DateTime)).toThrow();
    expect(() => latestOpenGameDate(undefined as unknown as DateTime)).toThrow();
    expect(() => latestOpenGameDate(null as unknown as DateTime)).toThrow();
  });
});

describe('QA openTime: any VALID custom rule keeps both functions consistent (incl. DST gap/overlap hours)', () => {
  const dstNeighbourhoods = [
    ...eachDay('2026-03-20', '2026-04-10'),
    ...eachDay('2026-10-18', '2026-11-08'),
    ...eachDay('2027-03-20', '2027-04-10'),
    ...eachDay('2027-10-24', '2027-11-14'),
  ].map(parseGameDate);

  it.each([1, 3, 7, 14])('daysAhead=%i, every hour 0..23', (daysAhead) => {
    for (let hour = 0; hour <= 23; hour += 1) {
      const rule: OpenRule = { daysAhead, hour };
      for (const day of dstNeighbourhoods) {
        const opens = bookingOpensAt(day, rule);
        expect(opens.isValid, `${day} ${JSON.stringify(rule)}`).toBe(true);
        const t = opens.toMillis();
        expect(latestOpenGameDate(asUtc(t), rule), `${day} ${JSON.stringify(rule)} @opens`).toBe(day);
        expect(latestOpenGameDate(asUtc(t - 1), rule), `${day} ${JSON.stringify(rule)} @opens-1ms`).toBe(addDays(day, -1));
      }
    }
  });
});
