/**
 * CONFIRMED BUGS (QA, 2026-10-12). Every test in this file FAILS against the current src/ on purpose:
 * it states the expected behaviour and must be turned green by fixing src/, never by weakening the test.
 * Each title starts with BUG-<n> and a severity. Numbering matches the QA report.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime, Settings } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidGameDateError, parseGameDate, toGameDate, type GameDate } from '../../src/config/gameDate.js';
import { buildHolidaySet } from '../../src/config/holidays.js';
import { buildAddEventBody, type AddEventRequest } from '../../src/reservaplay/bookingBody.js';
import { classifyAddEventResponse, classifyFormPage } from '../../src/reservaplay/classify.js';
import { bookingOpensAt, latestOpenGameDate, type OpenRule } from '../../src/sniper/openTime.js';
import { FAKE_HASH } from './_helpers.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const base: AddEventRequest = {
  hash: FAKE_HASH,
  accountId: 12345,
  gameDate: '2026-10-20' as GameDate, // Tuesday
  courtId: 4,
  startMinutes: 1080,
  durationMinutes: 90,
  payment: 'wallet',
  holidays: buildHolidaySet(undefined),
};
const build = (patch: Record<string, unknown>): string => buildAddEventBody({ ...base, ...patch } as AddEventRequest);
const okBody = (url: string): string => JSON.stringify({ status: 'ok', data: { msg: 'x', redirect: { url } } });
const msBudget = <T>(fn: () => T): { value: T; ms: number } => {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
};

const saved = { locale: Settings.defaultLocale, numbering: Settings.defaultNumberingSystem };
afterEach(() => {
  Settings.defaultLocale = saved.locale;
  Settings.defaultNumberingSystem = saved.numbering;
});

describe('BUG-1 [medium] bookingBody.ts:64,79,85 - any payment value other than "wallet" silently becomes the CARD variant', () => {
  // card = tipo_pago 2 / tpvonline 1 = an unpaid booking that eats the daily limit (CONTRACT C8: card fallback must be OFF by default)
  it.each([undefined, null, 'WALLET', 'Wallet', ' wallet', 'walet', 'monedero', '', 0, false, {}, 5])(
    'payment %j must throw instead of building a card booking',
    (payment) => {
      expect(() => build({ payment })).toThrow();
    },
  );
});

describe('BUG-2 [medium] classify.ts:32,83-84 - `ok` is returned for ids that are not a clean positive integer', () => {
  it.each([
    ['id 0', 'cal_event.php?id=0'],
    ['trailing junk after the digits', 'cal_event.php?id=12abc'],
    ['above Number.MAX_SAFE_INTEGER (id is silently altered: ...993 -> ...992)', 'cal_event.php?id=9007199254740993'],
    ['400 digits (reservationId becomes Infinity)', `cal_event.php?id=${'9'.repeat(400)}`],
  ])('%s must be `unknown`, never `ok`', (_label, url) => {
    const outcome = classifyAddEventResponse({ status: 200, body: okBody(url) });
    expect(outcome.kind).toBe('unknown');
  });

  it('every `ok` carries a positive safe integer id', () => {
    for (const id of ['1', '100002', '00100002']) {
      const outcome = classifyAddEventResponse({ status: 200, body: okBody(`cal_event.php?id=${id}`) });
      expect(outcome.kind).toBe('ok');
      if (outcome.kind === 'ok') expect(Number.isSafeInteger(outcome.reservationId) && outcome.reservationId > 0).toBe(true);
    }
  });
});

describe('BUG-3 [medium] classify.ts:61-65,77 - a success-looking JSON is `ok` on ANY non-redirect status, even 4xx / 1xx / 0 / NaN', () => {
  it.each([100, 199, 400, 403, 404, 405, 409, 422, 429, 0, Number.NaN])('HTTP %s with an ok-shaped body must not be `ok`', (status) => {
    expect(classifyAddEventResponse({ status, body: okBody('cal_event.php?id=100002') }).kind).not.toBe('ok');
  });
});

describe('BUG-4 [medium] classify.ts:11,112-113,129-134 - quadratic regexes: a hostile/truncated page stalls the event loop', () => {
  // measured on this machine: 40k "<" = 1.1 s, 1 MB of "<a " = 231 s (!), 20k "name=hash" without ">" = 3.3 s
  it('stripTags on 50k "<" through classifyFormPage finishes in < 400 ms', () => {
    const { ms } = msBudget(() => classifyFormPage('<'.repeat(50_000)));
    expect(ms).toBeLessThan(400);
  });

  it('stripTags on 50k "<" through a JSON message of a 2xx response finishes in < 400 ms', () => {
    const body = JSON.stringify({ status: 'error', data: { msg: '<'.repeat(50_000) } });
    const { ms } = msBudget(() => classifyAddEventResponse({ status: 200, body }));
    expect(ms).toBeLessThan(400);
  });

  it('the hash regex on a form-marker page with 20k `name="hash"` and no ">" finishes in < 400 ms', () => {
    const html = `id="event-form" ${'name="hash" '.repeat(20_000)}`;
    const { ms } = msBudget(() => classifyFormPage(html));
    expect(ms).toBeLessThan(400);
  });
});

describe('BUG-5 [medium] classify.ts:47-48,136-138 - loose daily_limit match that also outranks login_required', () => {
  it.each([
    '<form action="/login"><h1>Acceso</h1><p>¿Ya tienes cuenta? Reserva tu pista en segundos.</p><input name="username"><input type="password" name="password"></form>',
    '<form><p>Ya tienes tu usuario? Tus reservas te esperan.</p><input name="username"><input name="password"></form>',
  ])('a login form (session expired) is `login_required`, not `daily_limit`: %#', (html) => {
    expect(classifyFormPage(html).kind).toBe('login_required');
  });

  it.each(['Ya tienes una reserva en este horario (pista ocupada)', '¿Ya tienes cuenta? Reserva ya', 'Ya tienes saldo para esta reserva'])(
    'POST message %j is not the observed "Ya tienes N reserva/s" text and must stay `unknown`',
    (msg) => {
      const outcome = classifyAddEventResponse({ status: 200, body: JSON.stringify({ status: 'error', data: { msg } }) });
      expect(outcome.kind).toBe('unknown');
    },
  );
});

describe('BUG-6 [low] classify.ts:112-113,130 - regexes are case-insensitive, so `open` can return an UPPERCASE hash that the builder then rejects', () => {
  it('whenever classifyFormPage says open, buildAddEventBody must accept that hash', () => {
    const html = `<form id="event-form"><input name="hash" value="${FAKE_HASH.toUpperCase()}"></form>`;
    const gate = classifyFormPage(html);
    if (gate.kind === 'open') expect(() => build({ hash: gate.hash })).not.toThrow();
  });
});

describe('BUG-7 [low] classify.ts:130 - hash is not taken from the event form and attribute order beats document order', () => {
  it('uses the hash input that belongs to #event-form, not a name-first input of another form', () => {
    const wanted = 'b'.repeat(40);
    const html =
      `<form id="event-form"><input value="${wanted}" name="hash"></form>` +
      `<form id="newsletter"><input name="hash" value="${FAKE_HASH}"></form>`;
    expect(classifyFormPage(html)).toEqual({ kind: 'open', hash: wanted });
  });
});

describe('BUG-8 [low] classify.ts:129 - the form marker is a plain substring: a commented-out or scripted form counts as an open window', () => {
  const closedMessage = '<div class="msg msg-error">No se puede reservar a 8 o más dias vista</div>';
  it('form markup inside an HTML comment is not an open window', () => {
    const html = `${closedMessage}<!-- <form id="event-form"><input name="hash" value="${FAKE_HASH}"></form> -->`;
    expect(classifyFormPage(html).kind).not.toBe('open');
  });

  it('form markup inside a <script> string is not an open window', () => {
    const html = `${closedMessage}<script>var tpl = '<form id="event-form"><input name="hash" value="${FAKE_HASH}"></form>';</script>`;
    expect(classifyFormPage(html).kind).not.toBe('open');
  });
});

describe('BUG-9 [low] bookingBody.ts:46 - accountId is only checked with Number.isInteger, so exponent notation / unsafe integers reach the wire', () => {
  it.each([1e21, 1e300, 2 ** 53, 2 ** 53 + 2])('accountId %s must be rejected (socis would be "%s,3,3,3")', (accountId) => {
    expect(() => build({ accountId })).toThrow();
  });
});

describe('BUG-10 [low] bookingBody.ts:43,75 - the builder trusts the compile-time GameDate brand; a non-validated date string is serialised as-is', () => {
  // A job row loaded from SQLite and cast `as GameDate` is the realistic path. Academy courts are still blocked (fail-closed),
  // but every non-academy court happily produces a body with a garbage `data=` field.
  it.each(['2026-02-30', '2026-10-24\n', ' 2026-10-24', '2026-10-24T00:00:00', '', 'garbage', '24-10-2026'])(
    'gameDate %j must be rejected by buildAddEventBody',
    (gameDate) => {
      expect(() => build({ gameDate, courtId: 4 })).toThrow();
    },
  );
});

describe('BUG-11 [low] openTime.ts:10-29 - OpenRule is not validated; invalid values silently give a different/inconsistent opening time', () => {
  const invalid: ReadonlyArray<[string, OpenRule]> = [
    ['daysAhead 0', { daysAhead: 0, hour: 7 }],
    ['daysAhead -1', { daysAhead: -1, hour: 7 }],
    ['daysAhead 7.5', { daysAhead: 7.5, hour: 7 }],
    ['daysAhead 1e9 (returns an INVALID DateTime without throwing)', { daysAhead: 1e9, hour: 7 }],
    ['hour -1', { daysAhead: 7, hour: -1 }],
    ['hour 24', { daysAhead: 7, hour: 24 }],
    ['hour 25', { daysAhead: 7, hour: 25 }],
    ['hour 7.5', { daysAhead: 7, hour: 7.5 }],
  ];

  it.each(invalid)('bookingOpensAt rejects %s', (_label, rule) => {
    expect(() => bookingOpensAt(parseGameDate('2026-10-20'), rule)).toThrow();
  });

  it.each(invalid)('a rule that bookingOpensAt accepts must agree with latestOpenGameDate (%s)', (_label, rule) => {
    const day = parseGameDate('2026-10-20');
    let opens: DateTime;
    try {
      opens = bookingOpensAt(day, rule);
    } catch {
      return; // rejected: fine
    }
    expect(opens.isValid).toBe(true);
    expect(latestOpenGameDate(opens, rule)).toBe(day);
    expect(latestOpenGameDate(opens.minus({ milliseconds: 1 }), rule)).toBe('2026-10-19');
  });

  it('bookingOpensAt never returns an invalid DateTime (comparisons with NaN are false both ways => "fire immediately")', () => {
    const result = (() => {
      try {
        return bookingOpensAt('not-a-date' as GameDate);
      } catch {
        return null;
      }
    })();
    expect(result === null || result.isValid).toBe(true);
  });
});

describe('BUG-12 [low] gameDate.ts:33 - toGameDate / latestOpenGameDate depend on the process default locale (non-Latin digits)', () => {
  it.each(['ar-EG', 'fa-IR', 'ar-SA'])('toGameDate returns ASCII digits when luxon default locale is %s', (locale) => {
    Settings.defaultLocale = locale;
    expect(toGameDate(DateTime.fromISO('2026-10-20T10:00:00Z'))).toBe('2026-10-20');
    expect(latestOpenGameDate(DateTime.fromISO('2026-10-13T09:00:00Z'))).toBe('2026-10-20');
  });

  it('parseGameDate does not depend on Settings.defaultNumberingSystem', () => {
    Settings.defaultNumberingSystem = 'arab';
    expect(parseGameDate('2026-10-20')).toBe('2026-10-20');
    expect(bookingOpensAt(parseGameDate('2026-10-20')).toISO()).toBe('2026-10-13T07:00:00.000+02:00');
  });
});

describe('BUG-13 [low] gameDate.ts:23-25 - non-string input escapes as an accidental TypeError from luxon instead of InvalidGameDateError', () => {
  it.each([
    ['array holding a valid date', ['2026-10-20']],
    ['object with toString', { toString: (): string => '2026-10-20' }],
    ['symbol', Symbol('2026-10-20')],
    ['Date object', new Date(0)],
  ])('%s', (_label, value) => {
    expect(() => parseGameDate(value as unknown as string)).toThrow(InvalidGameDateError);
  });
});

describe('BUG-15 [low] classify.ts:42 - the 160-char cut can split a surrogate pair and leave an ill-formed string', () => {
  it('unknown.message is well-formed UTF-16', () => {
    const msg = `${'a'.repeat(159)}😀 tail`;
    const outcome = classifyAddEventResponse({ status: 200, body: JSON.stringify({ status: 'error', data: { msg } }) });
    expect(outcome.kind).toBe('unknown');
    const message = outcome.kind === 'unknown' ? (outcome.message ?? '') : '';
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(message)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Repository hygiene
// ---------------------------------------------------------------------------------------------

describe('BUG-14 [low] .gitignore - secrets/data patterns that the stack of this project will produce are not ignored', () => {
  const rules = readFileSync(join(ROOT, '.gitignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const covers = (...accepted: string[]) => accepted.some((pattern) => rules.includes(pattern));

  it('covers the basics (regression guard, currently green)', () => {
    expect(covers('.env')).toBe(true);
    expect(covers('*.sqlite')).toBe(true);
    expect(covers('data/')).toBe(true);
    expect(covers('logs/')).toBe(true);
    expect(covers('node_modules/')).toBe(true);
  });

  it('ignores .env variants (.env.local, .env.production) but still tracks .env.example', () => {
    expect(covers('.env.*', '.env.local', '.env*')).toBe(true);
    if (covers('.env.*', '.env*')) expect(covers('!.env.example')).toBe(true);
  });

  it('ignores SQLite WAL/SHM side files that better-sqlite3 creates', () => {
    expect(covers('*.sqlite-wal', '*.sqlite*', '*.sqlite-*')).toBe(true);
    expect(covers('*.sqlite-shm', '*.sqlite*', '*.sqlite-*')).toBe(true);
  });
});

describe('BUG-16 [low] bookingBody.ts:43,76 - request.courtId/gameDate are read twice (guard, then serialisation): the guard is not on "the very values that go on the wire"', () => {
  it('a request whose courtId getter changes between reads cannot put an academy court on a weekday into the body', () => {
    let reads = 0;
    const request = {
      ...base,
      gameDate: '2026-10-20' as GameDate, // Tuesday
      get courtId(): number {
        reads += 1;
        return reads === 1 ? 4 : 1; // guard sees Pista 4, the wire gets id 1 (academy)
      },
    };
    let recurso: string | null = null;
    try {
      recurso = new URLSearchParams(buildAddEventBody(request)).get('recurso');
    } catch {
      return; // refusing is fine
    }
    expect(['1', '2', '3', '7', '8']).not.toContain(recurso);
  });
});
