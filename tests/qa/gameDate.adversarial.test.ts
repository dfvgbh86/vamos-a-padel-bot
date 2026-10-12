import { DateTime, Settings } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
import { gameDateStart, InvalidGameDateError, isWeekend, parseGameDate, toGameDate } from '../../src/config/gameDate.js';
import { dayOfWeek, eachDay, isRealCalendarDate, madridLocal, makeRng } from './_helpers.js';

const saved = { zone: Settings.defaultZone, locale: Settings.defaultLocale, numbering: Settings.defaultNumberingSystem };
afterEach(() => {
  Settings.defaultZone = saved.zone;
  Settings.defaultLocale = saved.locale;
  Settings.defaultNumberingSystem = saved.numbering;
});

describe('QA parseGameDate: calendar validity against an independent oracle', () => {
  it('accepts exactly the real calendar days 2000-01-01..2040-12-31 and round-trips them', () => {
    const all = eachDay('2000-01-01', '2040-12-31');
    expect(all.length).toBeGreaterThan(14_900);
    for (const day of all) {
      expect(parseGameDate(day)).toBe(day);
      expect(toGameDate(gameDateStart(parseGameDate(day)))).toBe(day);
    }
  });

  it('rejects every impossible day-of-month (31 in 30-day months, 30/31 Feb, day 00, month 00/13)', () => {
    for (const year of [2024, 2025, 2026, 2027, 2028, 2100, 2000, 1900]) {
      for (let month = 1; month <= 12; month += 1) {
        const mm = String(month).padStart(2, '0');
        for (let day = 0; day <= 33; day += 1) {
          const input = `${year}-${mm}-${String(day).padStart(2, '0')}`;
          if (isRealCalendarDate(input)) expect(parseGameDate(input)).toBe(input);
          else expect(() => parseGameDate(input), input).toThrow(InvalidGameDateError);
        }
      }
      expect(() => parseGameDate(`${year}-00-10`)).toThrow(InvalidGameDateError);
      expect(() => parseGameDate(`${year}-13-10`)).toThrow(InvalidGameDateError);
    }
  });

  it('leap days: valid only in real leap years (century rule included)', () => {
    for (const year of ['2024', '2028', '2032', '2000', '2400']) {
      expect(parseGameDate(`${year}-02-29`)).toBe(`${year}-02-29`);
    }
    for (const year of ['2025', '2026', '2027', '2029', '1900', '2100', '2200', '2300']) {
      expect(() => parseGameDate(`${year}-02-29`), year).toThrow(InvalidGameDateError);
    }
    expect(parseGameDate('2028-02-28')).toBe('2028-02-28');
    expect(parseGameDate('2028-03-01')).toBe('2028-03-01');
  });

  it('year boundaries parse and neighbouring weekdays are correct', () => {
    for (const day of ['2025-12-31', '2026-01-01', '2026-12-31', '2027-01-01', '2027-12-31', '2028-01-01']) {
      const date = parseGameDate(day);
      expect(gameDateStart(date).weekday % 7, day).toBe(dayOfWeek(day));
      expect(isWeekend(date), day).toBe(dayOfWeek(day) === 0 || dayOfWeek(day) === 6);
    }
  });
});

describe('QA parseGameDate: hostile strings', () => {
  const hostile: ReadonlyArray<[string, string]> = [
    ['arabic-indic digits', '٢٠٢٦-١٠-٢٠'],
    ['extended arabic-indic digits', '۲۰۲۶-۱۰-۲۰'],
    ['devanagari digits', '२०२६-१०-२०'],
    ['fullwidth digits', '２０２６-１０-２０'],
    ['fullwidth last digit only', '2026-10-2０'],
    ['superscript digit', '2026-10-2²'],
    ['circled digit', '2026-10-2①'],
    ['mathematical bold digits', '𝟐𝟎𝟐𝟔-10-20'],
    ['unicode minus U+2212', '2026−10−20'],
    ['en dash', '2026–10–20'],
    ['non-breaking hyphen', '2026‑10‑20'],
    ['slashes', '2026/10/20'],
    ['dots', '2026.10.20'],
    ['dmy', '20-10-2026'],
    ['mdy', '10-20-2026'],
    ['two-digit year', '26-10-20'],
    ['five-digit year', '12026-10-20'],
    ['negative year', '-2026-10-20'],
    ['plus sign year', '+2026-10-20'],
    ['trailing LF', '2026-10-20\n'],
    ['trailing CRLF', '2026-10-20\r\n'],
    ['leading LF', '\n2026-10-20'],
    ['embedded LF', '2026-10-\n20'],
    ['trailing tab', '2026-10-20\t'],
    ['trailing NBSP', '2026-10-20 '],
    ['trailing zero-width space', '2026-10-20​'],
    ['trailing BOM', '2026-10-20﻿'],
    ['leading BOM', '﻿2026-10-20'],
    ['trailing line separator U+2028', '2026-10-20 '],
    ['trailing NUL', '2026-10-20\u0000'],
    ['trailing percent-encoded LF', '2026-10-20%0A'],
    ['query injection', '2026-10-20&op=del_event'],
    ['time suffix', '2026-10-20 00:00:00'],
    ['T suffix', '2026-10-20T00:00:00Z'],
    ['two dates', '2026-10-20,2026-10-21'],
    ['empty', ''],
    ['whitespace only', '   '],
    ['word', 'today'],
    ['proto', '__proto__'],
    ['1 MB of digits', '9'.repeat(1_000_000)],
    ['1 MB of dashes', '-'.repeat(1_000_000)],
    ['valid prefix + 1 MB junk', `2026-10-20${'x'.repeat(1_000_000)}`],
    ['valid prefix + 1 MB newlines', `2026-10-20${'\n'.repeat(1_000_000)}`],
    ['1 MB of valid dates joined', Array.from({ length: 100_000 }, () => '2026-10-20').join(',')],
  ];

  it.each(hostile)('%s is rejected with InvalidGameDateError, quickly', (_label, input) => {
    const started = performance.now();
    expect(() => parseGameDate(input)).toThrow(InvalidGameDateError);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('randomised garbage never yields a GameDate that is not strictly YYYY-MM-DD', () => {
    const rng = makeRng(777);
    const alphabet = ['0', '1', '2', '3', '9', '-', '-', ' ', '\n', 'T', 'Z', '٣', '/', '.', ':', 'a', '+'];
    for (let i = 0; i < 20_000; i += 1) {
      const length = rng.int(0, 14);
      let candidate = '';
      for (let j = 0; j < length; j += 1) candidate += rng.pick(alphabet);
      let result: string | undefined;
      try {
        result = parseGameDate(candidate);
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidGameDateError);
      }
      if (result !== undefined) {
        expect(result).toBe(candidate);
        expect(isRealCalendarDate(candidate), candidate).toBe(true);
      }
    }
  });

  it('error message JSON-escapes the input (no raw newline / control chars leak into logs)', () => {
    try {
      parseGameDate('2026-10-20\n\u001b[31mred');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toMatch(/[\n\u001b]/);
    }
  });
});

describe('QA parseGameDate: non-string input cast to string', () => {
  const nonStrings: ReadonlyArray<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['number 20261020', 20261020],
    ['NaN', Number.NaN],
    ['true', true],
    ['{}', {}],
    ['[]', []],
    ['Date object', new Date(0)],
    ['symbol', Symbol('2026-10-20')],
    ['object with toString', { toString: () => '2026-10-20' }],
    ['array with one date', ['2026-10-20']],
  ];

  it.each(nonStrings)('%s never produces a GameDate', (_label, value) => {
    let produced: unknown;
    try {
      produced = parseGameDate(value as string);
    } catch {
      return; // any throw is acceptable here; the typed-error contract is pinned in confirmed-bugs.test.ts
    }
    expect.fail(`parseGameDate returned ${JSON.stringify(produced)} for a non-string`);
  });
});

describe('QA toGameDate / isWeekend: club time zone, not process time zone or locale-agnostic luxon defaults', () => {
  it('every hour of 2026-2027 maps to the Madrid calendar day given by the platform ICU', () => {
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const end = Date.UTC(2027, 11, 31, 23, 0, 0);
    for (let t = start; t <= end; t += 3_600_000) {
      expect(toGameDate(DateTime.fromMillis(t, { zone: 'UTC' })), new Date(t).toISOString()).toBe(madridLocal(t).date);
    }
  });

  it('is independent of the input DateTime zone', () => {
    const instant = Date.UTC(2026, 9, 19, 22, 30, 0); // 00:30 on the 20th in Madrid
    for (const zone of ['UTC', 'Europe/Madrid', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kolkata', 'UTC+14']) {
      expect(toGameDate(DateTime.fromMillis(instant, { zone })), zone).toBe('2026-10-20');
    }
  });

  it('New Year in Madrid happens at 23:00Z (CET), not at 00:00Z', () => {
    expect(toGameDate(DateTime.utc(2026, 12, 31, 22, 59, 59, 999))).toBe('2026-12-31');
    expect(toGameDate(DateTime.utc(2026, 12, 31, 23, 0, 0, 0))).toBe('2027-01-01');
  });

  it('isWeekend matches the oracle for every day of 2026-2027 regardless of the process default zone', () => {
    for (const zone of ['Europe/Madrid', 'UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles']) {
      Settings.defaultZone = zone;
      for (const day of eachDay('2026-01-01', '2027-12-31')) {
        const expected = dayOfWeek(day) === 0 || dayOfWeek(day) === 6;
        expect(isWeekend(parseGameDate(day)), `${zone} ${day}`).toBe(expected);
      }
    }
  });

  it('gameDateStart is local midnight in Madrid for every day (DST days included)', () => {
    for (const day of eachDay('2026-01-01', '2027-12-31')) {
      const start = gameDateStart(parseGameDate(day));
      expect(start.zoneName).toBe('Europe/Madrid');
      expect([start.hour, start.minute, start.second, start.millisecond], day).toEqual([0, 0, 0, 0]);
      expect(start.toFormat('yyyy-MM-dd')).toBe(day);
    }
  });

  it('rejects invalid DateTime values with InvalidGameDateError', () => {
    expect(() => toGameDate(DateTime.invalid('x'))).toThrow(InvalidGameDateError);
    expect(() => toGameDate(DateTime.fromISO('not a date'))).toThrow(InvalidGameDateError);
  });
});
