import { GrammyError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { COURTS } from '../../src/config/courts.js';
import {
  courtName,
  formatClock,
  formatDayLong,
  formatDayMonth,
  formatDayShort,
  formatMadrid,
  formatMoney,
  formatTimeRange,
} from '../../src/telegram/format.js';
import {
  describeError,
  escapeHtml,
  htmlToPlain,
  redactSecrets,
  safeText,
  sanitizeText,
  truncateByCodePoints,
} from '../../src/telegram/text.js';
import { FAKE_HASH, makeRng } from '../qa/_helpers.js';
import { date } from './_fakes.js';

const hasLoneSurrogate = (text: string): boolean =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text) || /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

describe('formatMoney: integer cents to "19,02 €"', () => {
  it.each([
    [1902, '19,02 €'],
    [0, '0,00 €'],
    [1, '0,01 €'],
    [5, '0,05 €'],
    [99, '0,99 €'],
    [100, '1,00 €'],
    [101, '1,01 €'],
    [5000, '50,00 €'],
    [123_456, '1234,56 €'],
    [-250, '-2,50 €'],
    [-5, '-0,05 €'],
    [0.4, '0,00 €'],
    [-0.4, '0,00 €'],
    [1901.6, '19,02 €'],
  ])('%s => %s', (cents, expected) => {
    expect(formatMoney(cents)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('does not print %s as a number', (bad) => {
    expect(formatMoney(bad)).toBe('? €');
  });

  it('always uses the euro sign and a decimal comma', () => {
    for (const cents of [0, 7, 1902, 99_999]) expect(formatMoney(cents)).toMatch(/^-?\d+,\d{2} €$/);
  });
});

describe('formatClock and formatTimeRange', () => {
  it.each([
    [1080, '18:00'],
    [0, '00:00'],
    [9 * 60 + 5, '09:05'],
    [1439, '23:59'],
    [1440, '00:00'],
    [1500, '01:00'],
    [-30, '23:30'],
    [570.9, '09:30'],
  ])('%s => %s', (minutes, expected) => {
    expect(formatClock(minutes)).toBe(expected);
  });

  it('ranges use an en dash and wrap past midnight', () => {
    expect(formatTimeRange(1080, 90)).toBe('18:00–19:30');
    expect(formatTimeRange(1350, 90)).toBe('22:30–00:00');
  });
});

describe('dates are formatted in Russian regardless of the machine locale', () => {
  it('short, long and day-month forms', () => {
    expect(formatDayShort(date('2026-10-20'))).toBe('вт 20.10');
    expect(formatDayLong(date('2026-10-17'))).toBe('сб 17.10.2026');
    expect(formatDayLong(date('2026-10-18'))).toBe('вс 18.10.2026');
    expect(formatDayShort(date('2026-10-19'))).toBe('пн 19.10');
    expect(formatDayMonth('2026-12-08')).toBe('08.12');
    expect(formatDayMonth('garbage')).toBe('?');
  });

  it('covers every weekday name', () => {
    const names = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
    names.forEach((name, index) => {
      expect(formatDayShort(date(`2026-10-${String(19 + index)}`)).startsWith(name)).toBe(true);
    });
  });

  it('formats an instant in club time (summer and winter)', () => {
    expect(formatMadrid(Date.UTC(2026, 9, 13, 5, 0, 0))).toBe('13.10 07:00');
    expect(formatMadrid(Date.UTC(2026, 0, 15, 6, 0, 0))).toBe('15.01 07:00');
    expect(formatMadrid(Date.UTC(2026, 9, 25, 6, 0, 0))).toBe('25.10 07:00'); // first morning after clocks go back
    expect(formatMadrid(Date.UTC(2026, 9, 13, 22, 30, 0))).toBe('14.10 00:30');
    expect(formatMadrid(Number.NaN)).toBe('?');
  });
});

describe('courtName comes from the court table', () => {
  it('names every court by its Pista, not by its resource id', () => {
    for (const court of COURTS) {
      expect(courtName(court.id)).toBe(court.name);
      expect(courtName(court.id)).toContain(`Pista ${court.pista}`);
    }
    expect(courtName(7)).toContain('Pista 5');
    expect(courtName(9)).toContain('Pista 7');
  });

  it('does not invent a Pista for an unknown id', () => {
    expect(courtName(5)).toBe('корт (id 5)');
    expect(courtName(Number.NaN)).not.toContain('Pista');
  });
});

describe('escapeHtml and htmlToPlain', () => {
  it('escapes the four special characters', () => {
    expect(escapeHtml('<b>"a" & b</b>')).toBe('&lt;b&gt;&quot;a&quot; &amp; b&lt;/b&gt;');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('Pista 7, 18:00 — ок')).toBe('Pista 7, 18:00 — ок');
  });

  it('round-trips through htmlToPlain', () => {
    const original = 'a < b && c > d "q" <script>';
    expect(htmlToPlain(`<b>${escapeHtml(original)}</b>`)).toBe(original);
  });
});

describe('truncateByCodePoints', () => {
  it('keeps short text as it is', () => {
    expect(truncateByCodePoints('abc', 3)).toBe('abc');
    expect(truncateByCodePoints('', 5)).toBe('');
  });

  it('cuts at the limit including the ellipsis', () => {
    expect(truncateByCodePoints('abcdef', 4)).toBe('abc…');
    expect(Array.from(truncateByCodePoints('x'.repeat(1000), 300))).toHaveLength(300);
  });

  it('handles degenerate limits', () => {
    expect(truncateByCodePoints('abc', 0)).toBe('');
    expect(truncateByCodePoints('abc', -4)).toBe('');
    expect(truncateByCodePoints('abc', 1)).toBe('…');
  });

  it('counts an emoji as one code point and never splits it', () => {
    expect(truncateByCodePoints('🎾🎾🎾🎾', 3)).toBe('🎾🎾…');
    expect(truncateByCodePoints('🎾🎾🎾', 3)).toBe('🎾🎾🎾');
  });

  it('never produces a lone surrogate and never exceeds the limit, for random mixed text', () => {
    const rng = makeRng(20261013);
    const alphabet = ['a', 'я', '🎾', '👍🏽', '€', '<', '&', '́', '😀'];
    for (let round = 0; round < 300; round += 1) {
      const text = Array.from({ length: rng.int(0, 120) }, () => rng.pick(alphabet)).join('');
      const limit = rng.int(0, 40);
      const result = truncateByCodePoints(text, limit);
      expect(Array.from(result).length, JSON.stringify(text)).toBeLessThanOrEqual(limit);
      expect(hasLoneSurrogate(result), JSON.stringify(text)).toBe(false);
    }
  });

  it('is fast on huge input', () => {
    const started = Date.now();
    truncateByCodePoints('🎾'.repeat(2_000_000), 100);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('sanitizeText and safeText', () => {
  it('turns anything that is not a string into an empty string', () => {
    for (const value of [undefined, null, 5, {}, ['a']]) expect(sanitizeText(value)).toBe('');
  });

  it('collapses whitespace and strips control, zero-width and bidi characters', () => {
    expect(sanitizeText('  a\n\tb \u0000c​d‮e﻿  ')).toBe('a b cde');
  });

  it('masks long hex values and bot tokens, also glued to a URL', () => {
    const token = `987654321:${'Q'.repeat(35)}`;
    const text = sanitizeText(`h=${FAKE_HASH} bot${token}/getUpdates plain 100002`);
    expect(text).not.toContain(FAKE_HASH);
    expect(text).not.toContain(token);
    expect(text).toContain('100002');
    expect(text.match(/\[скрыто\]/g)).toHaveLength(2);
  });

  it('masks extra secrets given by the caller wherever they occur', () => {
    expect(redactSecrets('x-secret-y x-secret-y', ['secret'])).toBe('x-[скрыто]-y x-[скрыто]-y');
    expect(redactSecrets('nothing', [''])).toBe('nothing');
  });

  it('escapes after truncating, so an entity is never cut in half', () => {
    const text = safeText('<'.repeat(50), 10);
    expect(text).toBe(`${'&lt;'.repeat(9)}…`);
  });

  it('is bounded even for enormous input', () => {
    expect(Array.from(sanitizeText('я'.repeat(5_000_000), 300))).toHaveLength(300);
  });

  it('never leaves half an entity at the cut: every "&" of the output starts a complete entity', () => {
    for (const limit of [5, 6, 7, 50, 199, 200]) {
      for (const source of ['&'.repeat(1_000), '<&>"'.repeat(500), `${'a'.repeat(limit - 3)}&&&&&`]) {
        const text = safeText(source, limit);
        expect(text.replace(/&(amp|lt|gt|quot);/g, ''), `${limit}/${source.slice(0, 8)}`).not.toContain('&');
        expect(Array.from(text.replace(/&(amp|lt|gt|quot);/g, '?')).length).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('the cut lands before the escaping, so an ampersand keeps its whole entity and the ellipsis stays last', () => {
    expect(safeText('&'.repeat(1_000), 4)).toBe(`${'&amp;'.repeat(3)}…`);
  });
});

describe('long hex secrets are masked however they are glued to other text', () => {
  const hex = FAKE_HASH;
  const sha256 = `${hex}${hex.slice(0, 24)}`;
  const longRun = (text: string): boolean => /[0-9a-f]{32}/i.test(text);

  it.each<[string, string]>([
    ['after a word and an underscore', `session_${hex}`],
    ['glued to a letter in front', `x${hex}`],
    ['glued to a letter behind', `${hex}z`],
    ['upper case behind a word', `HASH${hex.toUpperCase()}`],
    ['behind a zero-width character', `hash​${hex}`],
    ['behind a bidi override', `hash‮${hex}`],
    ['with a suffix', `${hex}_suffix`],
    ['in brackets', `(${hex})`],
    ['after an equals sign', `hash=${hex}`],
    ['as the whole text', hex],
    ['a longer digest', sha256],
    ['inside a url path', `https://club.example/api/${hex}/done`],
    ['split by a zero-width character in the middle', `${hex.slice(0, 20)}​${hex.slice(20)}`],
  ])('%s', (_name, text) => {
    const clean = sanitizeText(text);
    expect(longRun(clean)).toBe(false);
    expect(clean).toContain('[скрыто]');
    expect(longRun(safeText(text))).toBe(false);
  });

  it('describeError masks it too (the zero-width character is removed first)', () => {
    const summary = describeError(new Error(`failed token_${hex} and hash​${hex}`));
    expect(longRun(summary.errorMessage)).toBe(false);
    expect(summary.errorMessage).toContain('[скрыто]');
  });

  it('redactSecrets masks glued hex on its own', () => {
    expect(longRun(redactSecrets(`session_${hex}Z`))).toBe(false);
  });

  it('leaves ordinary text alone: a run shorter than 32 hex characters, a long non-hex word, ids and prices', () => {
    const text = `${'a'.repeat(31)} ${'z'.repeat(80)} 100002 19,02 € #12 2026-10-20`;
    expect(sanitizeText(text)).toBe(text);
  });

  it('stays fast on enormous hex-looking input', () => {
    const started = Date.now();
    redactSecrets('ab'.repeat(500_000));
    redactSecrets(`${'a'.repeat(31)}g`.repeat(30_000));
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('a run of exactly 32 hex characters is masked, one of 31 is not', () => {
    expect(sanitizeText('f'.repeat(32))).toBe('[скрыто]');
    expect(sanitizeText('f'.repeat(31))).toBe('f'.repeat(31));
  });
});

describe('describeError never carries message text, stack or token', () => {
  it('summarises a plain error', () => {
    const summary = describeError(new TypeError('bad thing'));
    expect(summary).toEqual({ errorName: 'TypeError', errorMessage: 'bad thing' });
  });

  it('keeps the Bot API error code but not the payload of the failed call', () => {
    const error = new GrammyError('Call failed', { ok: false, error_code: 400, description: 'Bad Request' }, 'sendMessage', {
      chat_id: 42,
      text: 'PRIVATE-MESSAGE-TEXT',
    });
    const summary = describeError(error);
    expect(summary.errorCode).toBe(400);
    expect(JSON.stringify(summary)).not.toContain('PRIVATE-MESSAGE-TEXT');
    expect(JSON.stringify(summary)).not.toContain('stack');
  });

  it('masks the configured secrets and bounds the message', () => {
    const summary = describeError(new Error(`${'x'.repeat(5000)} TOKEN-VALUE`), ['TOKEN-VALUE']);
    expect(Array.from(summary.errorMessage).length).toBeLessThanOrEqual(200);
    expect(describeError(new Error('url /botTOKEN-VALUE/x'), ['TOKEN-VALUE']).errorMessage).toBe('url /bot[скрыто]/x');
  });

  it('handles thrown non-errors', () => {
    expect(describeError('a string')).toEqual({ errorName: 'string', errorMessage: '' });
    expect(describeError(undefined)).toEqual({ errorName: 'undefined', errorMessage: '' });
  });
});
