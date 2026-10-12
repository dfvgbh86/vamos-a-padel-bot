import { describe, expect, it } from 'vitest';
import { CourtNotAllowedError } from '../../src/config/courts.js';
import { InvalidGameDateError, type GameDate } from '../../src/config/gameDate.js';
import { buildHolidaySet } from '../../src/config/holidays.js';
import { buildAddEventBody, GUEST_ACCOUNT_ID, type AddEventRequest } from '../../src/reservaplay/bookingBody.js';
import { dayOfWeek, eachDay, FAKE_HASH, makeRng } from './_helpers.js';

const holidays = buildHolidaySet(undefined);
const date = (value: string) => value as GameDate;

const base: AddEventRequest = {
  hash: FAKE_HASH,
  accountId: 12345,
  gameDate: date('2026-10-20'), // Tuesday
  courtId: 4,
  startMinutes: 1080,
  durationMinutes: 90,
  payment: 'wallet',
  holidays,
};

/** Exact field order captured from the real site on 2026-10-12. */
const KEY_ORDER = [
  'hash',
  'id_reserva',
  'libres',
  'libres_step',
  'nivel',
  'nivel_max',
  'sx',
  'lista_usuarios',
  'data',
  'recurso',
  'op',
  'desactivar_pago',
  'tipo_pago_anticipado_socio',
  'array_of_bonos',
  'esReservaFija',
  'array_of_bonos',
  'esReservaFija',
  'tipoabonos',
  'tipo_pago_anticipado_tpvonline',
  'duration',
  'time_ini',
  'socis',
] as const;

const pairs = (body: string): Array<[string, string]> =>
  body.split('&').map((part) => {
    const index = part.indexOf('=');
    return [decodeURIComponent(part.slice(0, index).replace(/\+/g, ' ')), decodeURIComponent(part.slice(index + 1).replace(/\+/g, ' '))];
  });

const keys = (body: string): string[] => pairs(body).map(([key]) => key);

const build = (patch: Record<string, unknown>): string => buildAddEventBody({ ...base, ...patch } as AddEventRequest);

describe('QA bookingBody: wire format invariants', () => {
  it('field order is exactly the captured order, for both payment modes', () => {
    expect(keys(build({}))).toEqual([...KEY_ORDER]);
    expect(keys(build({ payment: 'card' }))).toEqual([...KEY_ORDER]);
  });

  it('exactly one `op` key (value add_event) and the only duplicated keys are array_of_bonos and esReservaFija', () => {
    const body = build({});
    const all = keys(body);
    expect(all.filter((key) => key === 'op')).toHaveLength(1);
    expect(pairs(body).find(([key]) => key === 'op')?.[1]).toBe('add_event');
    const counts = new Map<string, number>();
    for (const key of all) counts.set(key, (counts.get(key) ?? 0) + 1);
    const duplicated = [...counts].filter(([, count]) => count > 1).map(([key]) => key).sort();
    expect(duplicated).toEqual(['array_of_bonos', 'esReservaFija']);
    expect(counts.get('array_of_bonos')).toBe(2);
    expect(counts.get('esReservaFija')).toBe(2);
  });

  it('is plain percent-encoded ASCII: no raw space, comma, colon, CR or LF; 21 separators; never a del_event', () => {
    const body = build({});
    expect(body).toMatch(/^[A-Za-z0-9_\-.*+%=&]+$/);
    expect(body.split('&')).toHaveLength(22);
    expect(body).not.toContain('del_event');
    expect(body).not.toMatch(/op=(?!add_event(&|$))/);
    expect((body.match(/(^|&)op=/g) ?? []).length).toBe(1);
  });

  it('is deterministic and does not mutate (or depend on) frozen inputs', () => {
    const frozen = Object.freeze({ ...base });
    const first = buildAddEventBody(frozen);
    const second = buildAddEventBody(frozen);
    expect(second).toBe(first);
    expect(Object.keys(frozen)).toEqual(Object.keys(base));
    expect(holidays.has(date('2026-10-20'))).toBe(false);
  });

  it('fixed fields never vary with the request', () => {
    const rng = makeRng(99);
    for (let i = 0; i < 200; i += 1) {
      const parsed = new URLSearchParams(
        build({ courtId: rng.pick([4, 9, 10, 11, 12]), startMinutes: rng.int(0, 1439), durationMinutes: rng.int(60, 180), accountId: rng.int(4, 99999) }),
      );
      expect(parsed.get('id_reserva')).toBe('');
      expect(parsed.get('libres')).toBe('0');
      expect(parsed.get('libres_step')).toBe('1');
      expect(parsed.get('nivel')).toBe('0');
      expect(parsed.get('nivel_max')).toBe('7');
      expect(parsed.get('sx')).toBe('-');
      expect(parsed.get('lista_usuarios')).toBe('0');
      expect(parsed.get('desactivar_pago')).toBe('0');
      expect(parsed.get('tipoabonos')).toBe('0');
      expect(parsed.getAll('array_of_bonos')).toEqual(['', '']);
      expect(parsed.getAll('esReservaFija')).toEqual(['0', '0']);
    }
  });

  it('payment modes map to the documented pairs: wallet = 5/0, card = 2/1', () => {
    const wallet = new URLSearchParams(build({ payment: 'wallet' }));
    const card = new URLSearchParams(build({ payment: 'card' }));
    expect([wallet.get('tipo_pago_anticipado_socio'), wallet.get('tipo_pago_anticipado_tpvonline')]).toEqual(['5', '0']);
    expect([card.get('tipo_pago_anticipado_socio'), card.get('tipo_pago_anticipado_tpvonline')]).toEqual(['2', '1']);
  });
});

describe('QA bookingBody: participants (socis)', () => {
  it('always starts with the account id; the guest id 3 is only ever used as a guest', () => {
    for (let accountId = 1; accountId <= 300; accountId += 1) {
      for (const guestCount of [0, 1, 2, 3]) {
        if (accountId === GUEST_ACCOUNT_ID) {
          expect(() => build({ accountId, guestCount }), `account ${accountId}`).toThrow();
          continue;
        }
        const socis = new URLSearchParams(build({ accountId, guestCount })).get('socis') as string;
        const parts = socis.split(',');
        expect(parts[0], socis).toBe(String(accountId));
        expect(parts.slice(1), socis).toEqual(Array(guestCount).fill('3'));
        expect(parts).toHaveLength(guestCount + 1);
      }
    }
  });

  it('the account id 3 is rejected in every spelling (3, 3.0, +3) and with every guest count', () => {
    for (const guestCount of [undefined, 0, 1, 2, 3]) {
      expect(() => build({ accountId: 3, guestCount })).toThrow();
      expect(() => build({ accountId: 3.0, guestCount })).toThrow();
      expect(() => build({ accountId: +3, guestCount })).toThrow();
    }
  });

  it('default guest count is 3; undefined and null both mean default, never zero', () => {
    expect(new URLSearchParams(build({})).get('socis')).toBe('12345,3,3,3');
    expect(new URLSearchParams(build({ guestCount: undefined })).get('socis')).toBe('12345,3,3,3');
    expect(new URLSearchParams(build({ guestCount: null })).get('socis')).toBe('12345,3,3,3');
  });

  it.each([-1, 4, 5, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '3', '0', true, [], {}])('guestCount %j is rejected', (guestCount) => {
    expect(() => build({ guestCount })).toThrow();
  });
});

describe('QA bookingBody: numeric fields as NaN / Infinity / strings / objects', () => {
  const garbage: ReadonlyArray<[string, unknown]> = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['-0.5', -0.5],
    ['numeric string', '12345'],
    ['numeric string with spaces', ' 12345 '],
    ['hex string', '0x10'],
    ['exponent string', '1e3'],
    ['true', true],
    ['null', null],
    ['undefined', undefined],
    ['array', [12345]],
    ['object', { valueOf: () => 12345 }],
    ['bigint', 12345n],
    ['Number object', new Number(12345)],
  ];

  it.each(garbage)('accountId %s is rejected', (_label, accountId) => {
    expect(() => build({ accountId })).toThrow();
  });

  it.each([0, -1, -0, 1.5, 0.1, -12345])('accountId %s (zero, negative, fractional) is rejected', (accountId) => {
    expect(() => build({ accountId })).toThrow();
  });

  it.each([-1, 1440, 1080.5, 100_000])('startMinutes %s is rejected', (startMinutes) => {
    expect(() => build({ startMinutes })).toThrow();
  });

  it.each(garbage)('startMinutes and durationMinutes as %s are rejected', (_label, value) => {
    expect(() => build({ startMinutes: value })).toThrow();
    expect(() => build({ durationMinutes: value })).toThrow();
  });

  it('numeric boundaries: start 0 / 1439 and duration 60 / 180 are accepted, one step outside is not', () => {
    expect(new URLSearchParams(build({ startMinutes: 0 })).get('time_ini')).toBe('00:00');
    expect(new URLSearchParams(build({ startMinutes: 1439 })).get('time_ini')).toBe('23:59');
    expect(new URLSearchParams(build({ startMinutes: 59 })).get('time_ini')).toBe('00:59');
    expect(new URLSearchParams(build({ startMinutes: 60 })).get('time_ini')).toBe('01:00');
    expect(new URLSearchParams(build({ startMinutes: 605 })).get('time_ini')).toBe('10:05');
    expect(() => build({ startMinutes: -1 })).toThrow();
    expect(() => build({ startMinutes: 1440 })).toThrow();
    expect(new URLSearchParams(build({ durationMinutes: 60 })).get('duration')).toBe('60');
    expect(new URLSearchParams(build({ durationMinutes: 180 })).get('duration')).toBe('180');
    expect(() => build({ durationMinutes: 59 })).toThrow();
    expect(() => build({ durationMinutes: 181 })).toThrow();
  });

  it('time_ini is always HH:MM for every start minute 0..1439 and round-trips', () => {
    for (let minutes = 0; minutes < 1440; minutes += 1) {
      const value = new URLSearchParams(build({ startMinutes: minutes })).get('time_ini') as string;
      expect(value).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
      const [hh, mm] = value.split(':').map(Number);
      expect((hh as number) * 60 + (mm as number)).toBe(minutes);
    }
  });
});

describe('QA bookingBody: injection attempts', () => {
  const evilHashes: ReadonlyArray<[string, unknown]> = [
    ['op=del_event suffix', `${'a'.repeat(32)}&op=del_event`],
    ['op=del_event full', `${'a'.repeat(30)}&op=del_event`],
    ['encoded ampersand', `${'a'.repeat(37)}%26=`],
    ['trailing LF', `${FAKE_HASH}\n`],
    ['leading LF', `\n${FAKE_HASH}`],
    ['embedded LF', `${FAKE_HASH.slice(0, 20)}\n${FAKE_HASH.slice(21)}`],
    ['CRLF', `${FAKE_HASH}\r\n`],
    ['trailing space', `${FAKE_HASH} `],
    ['trailing NUL', `${FAKE_HASH}\u0000`],
    ['uppercase', FAKE_HASH.toUpperCase()],
    ['mixed case', `A${FAKE_HASH.slice(1)}`],
    ['41 chars', `${FAKE_HASH}a`],
    ['39 chars', FAKE_HASH.slice(1)],
    ['0 chars', ''],
    ['80 chars', FAKE_HASH + FAKE_HASH],
    ['non-hex letter', `g${FAKE_HASH.slice(1)}`],
    ['0x prefix', `0x${FAKE_HASH.slice(2)}`],
    ['arabic-indic digits', '٠'.repeat(40)],
    ['fullwidth hex', 'ａ'.repeat(40)],
    ['__proto__', '__proto__'],
    ['null', null],
    ['undefined', undefined],
    ['number', 123],
    ['object', {}],
    ['1 MB string', 'a'.repeat(1_000_000)],
  ];

  it.each(evilHashes)('hash: %s is rejected', (_label, hash) => {
    expect(() => build({ hash })).toThrow();
  });

  it('a 40-hex hash with a hostile-looking but valid shape is serialised as a value, never as structure', () => {
    const body = build({ hash: 'e'.repeat(40) });
    expect(pairs(body)[0]).toEqual(['hash', 'e'.repeat(40)]);
    expect(keys(body)).toEqual([...KEY_ORDER]);
  });

  it('even if a non-validated gameDate string reached the builder (type bypass) it can only ever be a VALUE', () => {
    const payloads = ['2026-10-20&op=del_event', '2026-10-20\n&op=del_event', '2026-10-20 00:00:00&recurso=1', '%26op=del_event', '', ' '];
    for (const payload of payloads) {
      let body: string;
      try {
        body = build({ gameDate: payload });
      } catch {
        continue; // rejecting is the better outcome (see BUG-4 in confirmed-bugs.test.ts)
      }
      expect(keys(body), JSON.stringify(payload)).toEqual([...KEY_ORDER]);
      expect(pairs(body).find(([key]) => key === 'op')?.[1]).toBe('add_event');
      expect(pairs(body).find(([key]) => key === 'recurso')?.[1]).toBe('4');
    }
  });

  it('a non-validated gameDate can never unlock an academy court', () => {
    const payloads = ['garbage', '', ' 2026-10-24', '2026-10-24 ', '2026-10-24\n', '2026-10-24T00:00:00', '2026-02-30', '٢٠٢٦-١٠-٢٤', '2026-10-24&x=1', '24-10-2026'];
    for (const payload of payloads) {
      for (const courtId of [1, 2, 3, 7, 8]) {
        const failure = (() => { try { build({ gameDate: payload, courtId }); return null; } catch (error) { return error; } })();
        // rejected either by the date re-validation or by the academy guard - never a body
        expect(failure instanceof InvalidGameDateError || failure instanceof CourtNotAllowedError, `${JSON.stringify(payload)} court ${courtId}`).toBe(true);
      }
    }
  });

  it('fails closed when holidays is missing or not a Set-like', () => {
    expect(() => build({ holidays: undefined })).toThrow();
    expect(() => build({ holidays: null })).toThrow();
    expect(() => build({ holidays: [] })).toThrow();
    expect(() => build({ holidays: {} })).toThrow();
    expect(() => buildAddEventBody(undefined as unknown as AddEventRequest)).toThrow();
    expect(() => buildAddEventBody(null as unknown as AddEventRequest)).toThrow();
  });

  it('an academy court plus an otherwise invalid request still reports the guard error first', () => {
    expect(() => build({ courtId: 1, hash: 'nope', accountId: 3, startMinutes: -5 })).toThrow(CourtNotAllowedError);
  });
});

describe('QA bookingBody: randomized valid requests round-trip', () => {
  it('3000 seeded requests: either CourtNotAllowedError (iff rule says so) or a body that decodes back to the input', () => {
    const rng = makeRng(424242);
    const allDays = eachDay('2026-01-01', '2027-12-31');
    const known = [1, 2, 3, 4, 7, 8, 9, 10, 11, 12];
    const academy = [1, 2, 3, 7, 8];
    let built = 0;
    let refused = 0;
    for (let i = 0; i < 3000; i += 1) {
      const day = rng.pick(allDays);
      const courtId = rng.bool(0.9) ? rng.pick(known) : rng.int(0, 15);
      const request: AddEventRequest = {
        hash: Array.from({ length: 40 }, () => '0123456789abcdef'[rng.int(0, 15)]).join(''),
        accountId: rng.pick([12345, rng.int(4, 999_999)]),
        gameDate: date(day),
        courtId,
        startMinutes: rng.int(0, 1439),
        durationMinutes: rng.int(60, 180),
        guestCount: rng.pick([undefined, 0, 1, 2, 3]),
        payment: rng.pick(['wallet', 'card'] as const),
        holidays,
      };
      const free = dayOfWeek(day) === 0 || dayOfWeek(day) === 6 || holidays.has(date(day));
      const allowed = known.includes(courtId) && (free || !academy.includes(courtId));
      if (!allowed) {
        expect(() => buildAddEventBody(request), `${day} court ${courtId}`).toThrow(CourtNotAllowedError);
        refused += 1;
        continue;
      }
      const parsed = new URLSearchParams(buildAddEventBody(request));
      built += 1;
      expect(parsed.get('hash')).toBe(request.hash);
      expect(parsed.get('data')).toBe(`${day} 00:00:00`);
      expect(parsed.get('recurso')).toBe(String(courtId));
      expect(parsed.get('duration')).toBe(String(request.durationMinutes));
      const [hh, mm] = (parsed.get('time_ini') as string).split(':').map(Number);
      expect((hh as number) * 60 + (mm as number)).toBe(request.startMinutes);
      expect(parsed.get('socis')).toBe([request.accountId, ...Array(request.guestCount ?? 3).fill(3)].join(','));
      expect(parsed.get('tipo_pago_anticipado_socio')).toBe(request.payment === 'wallet' ? '5' : '2');
      expect(parsed.get('tipo_pago_anticipado_tpvonline')).toBe(request.payment === 'wallet' ? '0' : '1');
      expect(parsed.get('op')).toBe('add_event');
    }
    expect(built).toBeGreaterThan(1000);
    expect(refused).toBeGreaterThan(300);
  });
});
