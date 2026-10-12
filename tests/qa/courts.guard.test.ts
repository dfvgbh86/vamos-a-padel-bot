import { describe, expect, it } from 'vitest';
import { allowedCourtIds, assertCourtAllowed, CourtNotAllowedError, isAcademyFreeDay } from '../../src/config/courts.js';
import type { GameDate } from '../../src/config/gameDate.js';
import { buildHolidaySet } from '../../src/config/holidays.js';
import { buildAddEventBody, type AddEventRequest } from '../../src/reservaplay/bookingBody.js';
import { dayOfWeek, eachGameDate, FAKE_HASH, makeRng } from './_helpers.js';

// Hard-coded on purpose: an independent statement of the owner's rule, NOT read from COURTS.
const ACADEMY_IDS = [1, 2, 3, 7, 8] as const;
const WEEKDAY_OK_IDS = [4, 9, 10, 11, 12] as const;
const KNOWN_IDS = [...ACADEMY_IDS, ...WEEKDAY_OK_IDS] as const;

const holidays = buildHolidaySet(undefined);
const days = eachGameDate('2026-01-01', '2027-12-31');

const requestFor = (gameDate: GameDate, courtId: number, set: ReadonlySet<GameDate> = holidays): AddEventRequest => ({
  hash: FAKE_HASH,
  accountId: 12345,
  gameDate,
  courtId,
  startMinutes: 1080,
  durationMinutes: 90,
  payment: 'wallet',
  holidays: set,
});

const isAcademyFree = (day: GameDate, set: ReadonlySet<GameDate>): boolean =>
  dayOfWeek(day) === 0 || dayOfWeek(day) === 6 || set.has(day);

describe('QA courts guard: every day of 2026-2027 x court ids 0..15', () => {
  it('covers the whole range (sanity of the sweep itself)', () => {
    expect(days).toHaveLength(730);
    expect(days[0]).toBe('2026-01-01');
    expect(days.at(-1)).toBe('2027-12-31');
  });

  it('assertCourtAllowed and buildAddEventBody agree with an independent oracle for every (day, id)', () => {
    let weekdayBlocked = 0;
    let weekdayAllowed = 0;
    for (const day of days) {
      const free = isAcademyFree(day, holidays);
      for (let id = 0; id <= 15; id += 1) {
        const expected = (KNOWN_IDS as readonly number[]).includes(id) && (free || !(ACADEMY_IDS as readonly number[]).includes(id));
        const context = `${day} (dow ${dayOfWeek(day)}) court ${id}`;

        let guardAllowed = true;
        try {
          assertCourtAllowed(id, day, holidays);
        } catch (error) {
          guardAllowed = false;
          expect(error, context).toBeInstanceOf(CourtNotAllowedError);
        }
        expect(guardAllowed, context).toBe(expected);

        let bodyBuilt = true;
        let body = '';
        try {
          body = buildAddEventBody(requestFor(day, id));
        } catch (error) {
          bodyBuilt = false;
          expect(error, context).toBeInstanceOf(CourtNotAllowedError);
        }
        expect(bodyBuilt, `builder ${context}`).toBe(expected);

        if (bodyBuilt) {
          const parsed = new URLSearchParams(body);
          expect(parsed.get('recurso'), context).toBe(String(id));
          expect(parsed.get('data'), context).toBe(`${day} 00:00:00`);
          if (!free) weekdayAllowed += 1;
        } else if (!free && (ACADEMY_IDS as readonly number[]).includes(id)) {
          weekdayBlocked += 1;
        }
      }
    }
    // The sweep really exercised both sides of the rule.
    expect(weekdayBlocked).toBeGreaterThan(2000);
    expect(weekdayAllowed).toBeGreaterThan(2000);
  });

  it('on a weekday non-holiday NO academy id is ever allowed, and the body builder always throws for it', () => {
    const weekdays = days.filter((day) => !isAcademyFree(day, holidays));
    expect(weekdays.length).toBeGreaterThan(450);
    for (const day of weekdays) {
      expect(allowedCourtIds(day, holidays), day).toEqual([...WEEKDAY_OK_IDS]);
      for (const id of ACADEMY_IDS) {
        expect(() => buildAddEventBody(requestFor(day, id)), `${day} court ${id}`).toThrow(CourtNotAllowedError);
      }
    }
  });

  it('on weekends and holidays all 10 known ids are allowed, nothing else is', () => {
    const free = days.filter((day) => isAcademyFree(day, holidays));
    expect(free.length).toBeGreaterThan(200);
    for (const day of free) {
      expect(allowedCourtIds(day, holidays), day).toEqual([1, 2, 3, 4, 7, 8, 9, 10, 11, 12]);
      for (let id = 0; id <= 15; id += 1) {
        const known = (KNOWN_IDS as readonly number[]).includes(id);
        if (known) expect(() => assertCourtAllowed(id, day, holidays), `${day} ${id}`).not.toThrow();
        else expect(() => assertCourtAllowed(id, day, holidays), `${day} ${id}`).toThrow(CourtNotAllowedError);
      }
    }
  });

  it('the default holiday seeds are weekdays that really switch the academy rule off', () => {
    for (const holiday of ['2026-12-08', '2026-12-25'] as const) {
      const day = days.find((candidate) => candidate === holiday);
      expect(day, holiday).toBeDefined();
      expect(holidays.has(day as GameDate), holiday).toBe(true);
      expect(dayOfWeek(holiday), `${holiday} must be Mon-Fri to be a meaningful seed`).toBeGreaterThanOrEqual(1);
      expect(dayOfWeek(holiday)).toBeLessThanOrEqual(5);
      expect(allowedCourtIds(day as GameDate, holidays)).toHaveLength(10);
    }
  });

  it('a holiday must not leak to the neighbouring days', () => {
    expect(allowedCourtIds('2026-12-07' as GameDate, holidays)).toEqual([...WEEKDAY_OK_IDS]); // Monday
    expect(allowedCourtIds('2026-12-09' as GameDate, holidays)).toEqual([...WEEKDAY_OK_IDS]); // Wednesday
    expect(allowedCourtIds('2026-12-24' as GameDate, holidays)).toEqual([...WEEKDAY_OK_IDS]); // Thursday
  });
});

describe('QA courts guard: weird court ids never pass', () => {
  const weird: ReadonlyArray<[string, unknown]> = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['-1', -1],
    ['-0', -0],
    ['1.5', 1.5],
    ['4.0000001', 4.0000001],
    ['3.9999999999', 3.9999999999],
    ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ['1e21', 1e21],
    ["'4' string", '4'],
    ["'04' string", '04'],
    ["' 4' string", ' 4'],
    ["'1' string (academy)", '1'],
    ['null', null],
    ['undefined', undefined],
    ['true', true],
    ['[4]', [4]],
    ['{}', {}],
    ['new Number(4)', new Number(4)],
    ['bigint 4n', 4n],
    ['object with valueOf=4', { valueOf: () => 4 }],
    ['object with toString=4', { toString: () => '4' }],
  ];

  it.each(weird)('%s is rejected on every day of the year (weekday, weekend, holiday)', (_label, value) => {
    for (const day of ['2026-10-20', '2026-10-24', '2026-10-25', '2026-12-08'] as const) {
      expect(() => assertCourtAllowed(value as number, day as GameDate, holidays), day).toThrow(CourtNotAllowedError);
      expect(() => buildAddEventBody(requestFor(day as GameDate, value as number)), day).toThrow(CourtNotAllowedError);
    }
  });

  it('weird court ids never pass on ANY day of 2026-2027', () => {
    for (const day of days) {
      for (const [, value] of weird) {
        expect(() => assertCourtAllowed(value as number, day, holidays), day).toThrow(CourtNotAllowedError);
      }
    }
  });
});

describe('QA courts guard: randomized holiday sets', () => {
  it('academy courts are allowed iff weekend or in the (random) holiday set', () => {
    const rng = makeRng(20261012);
    for (let round = 0; round < 12; round += 1) {
      const chosen = days.filter(() => rng.bool(0.08));
      const set = new Set<GameDate>(chosen);
      for (const day of days) {
        const free = isAcademyFree(day, set);
        expect(isAcademyFreeDay(day, set), day).toBe(free);
        const ids = allowedCourtIds(day, set);
        expect(ids.length, day).toBe(free ? 10 : 5);
        for (const id of ACADEMY_IDS) expect(ids.includes(id), `${day} ${id}`).toBe(free);
      }
    }
  });

  it('an empty holiday set never changes weekday behaviour', () => {
    const empty = new Set<GameDate>();
    for (const day of days) {
      const free = dayOfWeek(day) === 0 || dayOfWeek(day) === 6;
      expect(allowedCourtIds(day, empty), day).toHaveLength(free ? 10 : 5);
    }
  });

  it('allowedCourtIds returns a fresh array: mutating it cannot widen the next answer', () => {
    const day = '2026-10-20' as GameDate;
    const first = allowedCourtIds(day, holidays) as number[];
    first.push(1, 2, 3, 7, 8);
    expect(allowedCourtIds(day, holidays)).toEqual([...WEEKDAY_OK_IDS]);
  });
});

describe('QA courts guard: guard is evaluated on the date that is serialised', () => {
  it('Friday vs Saturday boundary: the same academy court flips exactly at the weekend', () => {
    expect(() => buildAddEventBody(requestFor('2026-10-23' as GameDate, 1))).toThrow(CourtNotAllowedError); // Fri
    expect(() => buildAddEventBody(requestFor('2026-10-24' as GameDate, 1))).not.toThrow(); // Sat
    expect(() => buildAddEventBody(requestFor('2026-10-25' as GameDate, 1))).not.toThrow(); // Sun
    expect(() => buildAddEventBody(requestFor('2026-10-26' as GameDate, 1))).toThrow(CourtNotAllowedError); // Mon
  });

  it('year boundary and leap-day weekdays are classified correctly', () => {
    // 2026-12-31 Thursday, 2027-01-01 Friday (official holiday, Año Nuevo), 2027-01-02 Saturday, 2028-02-29 Tuesday
    expect(() => buildAddEventBody(requestFor('2026-12-31' as GameDate, 7))).toThrow(CourtNotAllowedError);
    expect(() => buildAddEventBody(requestFor('2027-01-01' as GameDate, 7))).not.toThrow();
    expect(() => buildAddEventBody(requestFor('2027-01-02' as GameDate, 7))).not.toThrow();
    expect(() => buildAddEventBody(requestFor('2028-02-29' as GameDate, 7))).toThrow(CourtNotAllowedError);
  });
});
