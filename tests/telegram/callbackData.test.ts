import { describe, expect, it } from 'vitest';
import {
  encodeCallbackData,
  MAX_CALLBACK_DATA_BYTES,
  parseCallbackData,
  SESSION_ID_PATTERN,
  type CallbackAction,
} from '../../src/telegram/callbackData.js';
import { newSessionId } from '../../src/telegram/sessions.js';
import { date } from './_fakes.js';

const sid = 'a1b2c3';

const actions: CallbackAction[] = [
  { type: 'pickDate', sid, date: date('2026-10-20') },
  { type: 'pickCourt', sid, courtId: 12 },
  { type: 'pickTime', sid, courtId: 12, startMinutes: 1439 },
  { type: 'pickTime', sid, courtId: 4, startMinutes: 0 },
  { type: 'undo', sid },
  { type: 'toCourts', sid },
  { type: 'toDates', sid },
  { type: 'review', sid },
  { type: 'confirm', sid },
  { type: 'abort', sid },
  { type: 'cancelYes', sid },
  { type: 'cancelNo', sid },
];

describe('encodeCallbackData / parseCallbackData', () => {
  it.each(actions)('round-trips %j', (action) => {
    const data = encodeCallbackData(action);
    expect(parseCallbackData(data)).toEqual(action);
  });

  it('every encoded action fits the 64 byte Telegram limit, also in the worst case', () => {
    for (const action of actions) {
      expect(new TextEncoder().encode(encodeCallbackData(action)).length).toBeLessThanOrEqual(MAX_CALLBACK_DATA_BYTES);
    }
    const worst = encodeCallbackData({ type: 'pickTime', sid: 'ffffff', courtId: 999, startMinutes: 1439 });
    expect(worst.length).toBeLessThan(25);
  });

  it('refuses to encode something that would exceed the limit', () => {
    expect(() => encodeCallbackData({ type: 'pickDate', sid, date: 'x'.repeat(80) as never })).toThrow(/64 bytes/);
  });

  it('keeps the two flows apart: n: for the /new conversation, x: for /cancel', () => {
    expect(encodeCallbackData({ type: 'confirm', sid })).toBe('n:y:a1b2c3');
    expect(encodeCallbackData({ type: 'cancelYes', sid })).toBe('x:y:a1b2c3');
    expect(encodeCallbackData({ type: 'cancelNo', sid })).toBe('x:n:a1b2c3');
  });

  it.each([undefined, null, 5, {}, [], true, Symbol('x')])('rejects the non-string %s', (value) => {
    expect(parseCallbackData(value)).toBeNull();
  });

  it.each([
    '',
    'n:y',
    'n:y:',
    'n:y:A1B2C3',
    'n:y:a1b2c',
    'n:y:a1b2c3d',
    'n:y:a1b2c3\n',
    'n:y:a1b2c3 ',
    ' n:y:a1b2c3',
    'n:y:a1b2c3:',
    'N:y:a1b2c3',
    'n:Y:a1b2c3',
    'n:y:a1b2c3\u0000',
    'n:c:a1b2c3:',
    'n:c:a1b2c3:-1',
    'n:c:a1b2c3:+1',
    'n:c:a1b2c3:1.5',
    'n:c:a1b2c3:1e2',
    'n:c:a1b2c3:0x1',
    'n:c:a1b2c3:1000',
    'n:t:a1b2c3:4',
    'n:t:a1b2c3:4:',
    'n:t:a1b2c3:4:1440',
    'n:t:a1b2c3:4:99999',
    'n:t:a1b2c3:-4:60',
    'n:d:a1b2c3:2026-10-20 ',
    'n:d:a1b2c3:2026-1-20',
    'n:d:a1b2c3:2026-02-30',
    'n:d:a1b2c3:2026-13-01',
    'n:d:a1b2c3:20261020',
    `n:d:a1b2c3:${'9'.repeat(70)}`,
    'x:y:a1b2c3:extra',
    'x:x:a1b2c3',
    '‮n:y:a1b2c3',
  ])('rejects %j', (data) => {
    expect(parseCallbackData(data)).toBeNull();
  });

  it('accepts leading zeros as plain numbers (they are re-validated against the court list anyway)', () => {
    expect(parseCallbackData('n:c:a1b2c3:007')).toEqual({ type: 'pickCourt', sid, courtId: 7 });
  });

  it('does not use the real calendar loosely: a leap day exists only in leap years', () => {
    expect(parseCallbackData('n:d:a1b2c3:2028-02-29')).toMatchObject({ type: 'pickDate' });
    expect(parseCallbackData('n:d:a1b2c3:2027-02-29')).toBeNull();
  });
});

describe('session ids', () => {
  it('are six lower-case hex characters and differ between conversations', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSessionId()));
    for (const id of ids) expect(id).toMatch(SESSION_ID_PATTERN);
    expect(ids.size).toBeGreaterThan(190);
  });
});
