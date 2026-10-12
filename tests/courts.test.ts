import { describe, expect, it } from 'vitest';
import {
  allowedCourtIds,
  assertCourtAllowed,
  COURTS,
  CourtNotAllowedError,
} from '../src/config/courts.js';
import { parseGameDate } from '../src/config/gameDate.js';
import { buildHolidaySet, holidaysWithin } from '../src/config/holidays.js';

const holidays = buildHolidaySet(undefined);
const date = parseGameDate;

describe('court table invariants (owner constraint: academy courts are ids 1, 2, 3, 7, 8)', () => {
  it('has exactly the ten known resource ids, unique', () => {
    const ids = COURTS.map((court) => court.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 7, 8, 9, 10, 11, 12]);
  });

  it('marks exactly resource ids 1, 2, 3, 7, 8 as academy courts', () => {
    const academy = COURTS.filter((court) => court.academyOnWeekdays).map((court) => court.id);
    expect(academy.sort((a, b) => a - b)).toEqual([1, 2, 3, 7, 8]);
  });

  it('keeps the id to Pista mapping (Pista 5 is id 7, Pista 6 is id 8, Pista 7 is id 9)', () => {
    const pistaOf = Object.fromEntries(COURTS.map((court) => [court.id, court.pista]));
    expect(pistaOf).toMatchObject({ 4: 4, 7: 5, 8: 6, 9: 7, 10: 8, 11: 9, 12: 10 });
  });
});

describe('allowedCourtIds', () => {
  it('on weekdays allows only the non-academy courts (ids 4, 9, 10, 11, 12)', () => {
    for (const day of ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']) {
      expect(allowedCourtIds(date(day), holidays)).toEqual([4, 9, 10, 11, 12]);
    }
  });

  it('on Saturday and Sunday allows all ten courts', () => {
    expect(allowedCourtIds(date('2026-10-24'), holidays)).toEqual([1, 2, 3, 4, 7, 8, 9, 10, 11, 12]);
    expect(allowedCourtIds(date('2026-10-25'), holidays)).toHaveLength(10);
  });

  it('on a weekday holiday allows all ten courts', () => {
    expect(allowedCourtIds(date('2026-12-08'), holidays)).toHaveLength(10);
  });

  it('a holiday that falls on a weekend changes nothing', () => {
    const custom = buildHolidaySet('2026-10-24');
    expect(allowedCourtIds(date('2026-10-24'), custom)).toHaveLength(10);
  });

  it('applies owner-supplied extra holidays and nothing else', () => {
    const custom = buildHolidaySet('2026-11-20');
    expect(allowedCourtIds(date('2026-11-20'), custom)).toHaveLength(10);
    expect(allowedCourtIds(date('2026-11-20'), holidays)).toEqual([4, 9, 10, 11, 12]);
    expect(allowedCourtIds(date('2026-11-19'), custom)).toEqual([4, 9, 10, 11, 12]);
  });
});

describe('assertCourtAllowed', () => {
  it('rejects academy courts on weekdays by resource id, not by Pista number', () => {
    for (const academyId of [1, 2, 3, 7, 8]) {
      expect(() => assertCourtAllowed(academyId, date('2026-10-20'), holidays)).toThrow(CourtNotAllowedError);
    }
  });

  it('accepts Pista 4 and Pista 7 (ids 4 and 9) on weekdays', () => {
    expect(() => assertCourtAllowed(4, date('2026-10-20'), holidays)).not.toThrow();
    expect(() => assertCourtAllowed(9, date('2026-10-20'), holidays)).not.toThrow();
  });

  it('rejects unknown court ids even on weekends', () => {
    expect(() => assertCourtAllowed(5, date('2026-10-24'), holidays)).toThrow(CourtNotAllowedError);
    expect(() => assertCourtAllowed(0, date('2026-10-24'), holidays)).toThrow(CourtNotAllowedError);
  });
});

describe('buildHolidaySet', () => {
  it.each(['2026-1-5', '2026-13-45', '2026-02-30', '2026-10-24T10:00:00Z', 'tomorrow'])(
    'rejects malformed or non-existent date %j',
    (bad) => {
      expect(() => buildHolidaySet(`2026-11-20, ${bad}`)).toThrow(/invalid dates/);
    },
  );

  it('ignores empty entries and whitespace', () => {
    expect(buildHolidaySet(' 2026-11-20 ,, ').has(date('2026-11-20'))).toBe(true);
  });
});

describe('holidaysWithin', () => {
  it('lists holidays in the window, sorted, end exclusive', () => {
    const custom = buildHolidaySet('2026-11-20,2026-12-01');
    expect(holidaysWithin(custom, date('2026-11-20'), 30)).toEqual(['2026-11-20', '2026-12-01', '2026-12-08']);
    expect(holidaysWithin(custom, date('2026-11-20'), 11)).toEqual(['2026-11-20']);
  });
});
