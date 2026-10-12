import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { InvalidGameDateError, isWeekend, parseGameDate, toGameDate } from '../src/config/gameDate.js';

describe('parseGameDate', () => {
  it('accepts a strict real calendar date', () => {
    expect(parseGameDate('2026-10-20')).toBe('2026-10-20');
    expect(parseGameDate('2028-02-29')).toBe('2028-02-29');
  });

  it.each([
    '2026-10-23T23:30:00-10:00', // ISO with time/offset: would shift to another weekday in Madrid
    '2026-10-23T00:00:00',
    '20261024',
    '2026-W43-6',
    '2026-297',
    '2026-1-5',
    '2026-13-45',
    '2026-02-30',
    '2027-02-29',
    ' 2026-10-20',
    '2026-10-20 ',
    '',
  ])('rejects %j', (input) => {
    expect(() => parseGameDate(input)).toThrow(InvalidGameDateError);
  });
});

describe('toGameDate', () => {
  it('formats the club-time calendar day, not the UTC day', () => {
    // 22:30Z on 19 Oct is already 00:30 on 20 Oct in Madrid (UTC+2)
    expect(toGameDate(DateTime.fromISO('2026-10-19T22:30:00Z'))).toBe('2026-10-20');
  });

  it('rejects invalid DateTime values', () => {
    expect(() => toGameDate(DateTime.invalid('test'))).toThrow(InvalidGameDateError);
  });
});

describe('isWeekend', () => {
  it('is true only for Saturday and Sunday', () => {
    expect(isWeekend(parseGameDate('2026-10-23'))).toBe(false); // Friday
    expect(isWeekend(parseGameDate('2026-10-24'))).toBe(true); // Saturday
    expect(isWeekend(parseGameDate('2026-10-25'))).toBe(true); // Sunday
    expect(isWeekend(parseGameDate('2026-10-26'))).toBe(false); // Monday
  });
});
