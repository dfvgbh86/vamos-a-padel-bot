import { describe, expect, it } from 'vitest';
import { allowedCourtIds } from '../../src/config/courts.js';
import type { GameDate } from '../../src/config/gameDate.js';
import { buildHolidaySet, holidaysWithin } from '../../src/config/holidays.js';
import { addDays, dayOfWeek, eachDay, isRealCalendarDate, makeRng } from './_helpers.js';

const date = (value: string) => value as GameDate;

describe('QA buildHolidaySet: EXTRA_HOLIDAYS parsing', () => {
  it('undefined, empty, whitespace and stray commas all give exactly the built-in seeds', () => {
    const seeds = [...buildHolidaySet(undefined)].sort();
    expect(seeds.length).toBeGreaterThanOrEqual(2);
    for (const raw of [undefined, '', ' ', ',', ' , , ', '\n', '\t,\t']) {
      expect([...buildHolidaySet(raw)].sort(), JSON.stringify(raw)).toEqual(seeds);
    }
  });

  it('every built-in holiday is a real calendar date that unlocks all ten courts (weekend dates are harmless no-ops)', () => {
    const seeds = buildHolidaySet(undefined);
    expect(seeds.size).toBeGreaterThanOrEqual(26);
    let weekdays = 0;
    for (const seed of seeds) {
      expect(isRealCalendarDate(seed), seed).toBe(true);
      expect(allowedCourtIds(seed, seeds), seed).toHaveLength(10);
      if (dayOfWeek(seed) >= 1 && dayOfWeek(seed) <= 5) weekdays += 1;
    }
    expect(weekdays).toBeGreaterThanOrEqual(20);
  });

  it('surrounding whitespace, BOM and NBSP around entries are tolerated; duplicates collapse', () => {
    const set = buildHolidaySet(' 2026-11-20 , 2026-11-21 ,﻿2026-11-22,2026-11-20');
    for (const day of ['2026-11-20', '2026-11-21', '2026-11-22']) expect(set.has(date(day)), day).toBe(true);
    expect(set.size).toBe(buildHolidaySet(undefined).size + 3);
  });

  const bad = [
    '2026-11-20;2026-11-21',
    '2026-11-20 2026-11-21',
    '2026-11-20\n2026-11-21',
    '"2026-11-20"',
    "'2026-11-20'",
    '2026-11-2',
    '26-11-20',
    '2026/11/20',
    '2026-11-20T00:00:00',
    '2026-11-31',
    '2026-02-29',
    '2026-00-10',
    '٢٠٢٦-١١-٢٠',
    '2026-11-２０',
    'null',
    'undefined',
    '__proto__',
    '2026-11-20,,garbage',
  ];

  it.each(bad)('rejects %j loudly (the whole variable is refused, never silently trimmed)', (raw) => {
    expect(() => buildHolidaySet(raw)).toThrow(/EXTRA_HOLIDAYS has invalid dates/);
  });

  it('one bad entry among good ones rejects everything and names the bad entries', () => {
    expect(() => buildHolidaySet('2026-11-20,2026-02-30,nope')).toThrow(/2026-02-30, nope/);
  });

  it('each call returns an independent Set: mutating one result never changes the next', () => {
    const first = buildHolidaySet(undefined) as Set<GameDate>;
    first.add(date('2026-10-20'));
    expect(buildHolidaySet(undefined).has(date('2026-10-20'))).toBe(false);
    expect(allowedCourtIds(date('2026-10-20'), buildHolidaySet(undefined))).toEqual([4, 9, 10, 11, 12]);
  });

  it('randomised valid lists round-trip exactly', () => {
    const rng = makeRng(2026);
    const days = eachDay('2026-01-01', '2028-12-31');
    for (let round = 0; round < 200; round += 1) {
      const chosen = Array.from({ length: rng.int(0, 12) }, () => rng.pick(days));
      const raw = chosen.map((day) => `${rng.pick(['', ' ', '\t'])}${day}${rng.pick(['', ' '])}`).join(',');
      const set = buildHolidaySet(raw);
      for (const day of chosen) expect(set.has(date(day))).toBe(true);
      expect(set.size).toBeLessThanOrEqual(buildHolidaySet(undefined).size + chosen.length);
    }
  });
});

describe('QA holidaysWithin', () => {
  const set = buildHolidaySet('2026-10-24,2026-10-25,2026-10-26,2026-12-01');

  it('window is [from, from+days): start inclusive, end exclusive, sorted ascending', () => {
    expect(holidaysWithin(set, date('2026-10-24'), 3)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
    expect(holidaysWithin(set, date('2026-10-24'), 2)).toEqual(['2026-10-24', '2026-10-25']);
    expect(holidaysWithin(set, date('2026-10-25'), 1)).toEqual(['2026-10-25']);
    expect(holidaysWithin(set, date('2026-10-27'), 1)).toEqual([]);
  });

  it('zero and negative windows are empty, a fractional window keeps the start day, NaN is refused loudly', () => {
    expect(holidaysWithin(set, date('2026-10-24'), 0)).toEqual([]);
    expect(holidaysWithin(set, date('2026-10-24'), -5)).toEqual([]);
    expect(holidaysWithin(set, date('2026-10-24'), 0.5)).toEqual(['2026-10-24']);
    expect(() => holidaysWithin(set, date('2026-10-24'), Number.NaN)).toThrow();
  });

  it('is calendar-day based across both DST changes (a 23 h / 25 h day is still one day)', () => {
    const dst = buildHolidaySet('2026-03-28,2026-03-29,2026-03-30,2026-10-24,2026-10-25,2026-10-26');
    expect(holidaysWithin(dst, date('2026-03-28'), 3)).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
    expect(holidaysWithin(dst, date('2026-03-29'), 1)).toEqual(['2026-03-29']);
    expect(holidaysWithin(dst, date('2026-10-24'), 3)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
    expect(holidaysWithin(dst, date('2026-10-25'), 1)).toEqual(['2026-10-25']);
  });

  it('does not mutate the holiday set', () => {
    const before = [...set].sort();
    holidaysWithin(set, date('2026-10-24'), 400);
    expect([...set].sort()).toEqual(before);
  });
});
