import { describe, expect, it } from 'vitest';
import { parseGameDate } from '../../src/config/gameDate.js';
import { UnexpectedResponseError } from '../../src/reservaplay/errors.js';
import { parseCalendar } from '../../src/reservaplay/parsers/index.js';
import { calendarPayload, courtJson, type FixtureCourt } from '../fixtures/reservaplay/calendar.js';

const gameDate = parseGameDate('2026-10-19');

const oneCourt = (court: Partial<FixtureCourt> = {}): FixtureCourt => ({
  id: 9,
  name: 'Pista 7 semicubierta',
  slots: [{ start: 1080, end: 1170, duration: 90 }],
  ...court,
});

const failureOf = (payload: unknown): UnexpectedResponseError => {
  try {
    parseCalendar(payload, gameDate);
  } catch (error) {
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    return error as UnexpectedResponseError;
  }
  throw new Error('expected parseCalendar to throw');
};

describe('parseCalendar: the happy path', () => {
  it('maps courts and slots to the whitelisted fields only', () => {
    const payload = calendarPayload([
      {
        id: 4,
        name: 'Pista 4 semicubierta',
        slots: [
          { start: 540, end: 630, duration: 90 },
          { start: 630, end: 720, duration: 90, taken: true },
          { start: 720, end: 810, duration: 90, taken: true, own: 1 },
        ],
      },
      oneCourt(),
    ]);

    expect(parseCalendar(payload, gameDate)).toEqual({
      gameDate,
      courts: [
        {
          courtId: 4,
          name: 'Pista 4 semicubierta',
          slots: [
            { startMinutes: 540, endMinutes: 630, durationMinutes: 90, free: true, ownBooking: false },
            { startMinutes: 630, endMinutes: 720, durationMinutes: 90, free: false, ownBooking: false },
            { startMinutes: 720, endMinutes: 810, durationMinutes: 90, free: false, ownBooking: true },
          ],
        },
        {
          courtId: 9,
          name: 'Pista 7 semicubierta',
          slots: [{ startMinutes: 1080, endMinutes: 1170, durationMinutes: 90, free: true, ownBooking: false }],
        },
      ],
    });
  });

  it('takes the game date from the caller, not from the response', () => {
    expect(parseCalendar(calendarPayload([]), parseGameDate('2027-01-02')).gameDate).toBe('2027-01-02');
  });

  it('accepts an empty calendar', () => {
    expect(parseCalendar([[[]]], gameDate).courts).toEqual([]);
    expect(parseCalendar([], gameDate).courts).toEqual([]);
  });

  it('accepts a court without slots', () => {
    expect(parseCalendar(calendarPayload([oneCourt({ slots: [] })]), gameDate).courts[0]?.slots).toEqual([]);
  });

  it('reads ids and minutes written as digit strings', () => {
    const payload = calendarPayload([{ id: '9', name: 'P', slots: [{ start: '1080' as unknown as number, end: '1170' as unknown as number, duration: '90' }] }]);
    expect(parseCalendar(payload, gameDate).courts[0]).toMatchObject({
      courtId: 9,
      slots: [{ startMinutes: 1080, endMinutes: 1170, durationMinutes: 90 }],
    });
  });

  it('derives the duration from the time range when `duracion` is absent or not a positive integer', () => {
    const slots = [
      { start: 540, end: 600 },
      { start: 600, end: 690, duration: 'abc' },
      { start: 690, end: 750, duration: 0 },
    ];
    const durations = parseCalendar(calendarPayload([oneCourt({ slots })]), gameDate).courts[0]?.slots.map((slot) => slot.durationMinutes);
    expect(durations).toEqual([60, 90, 60]);
  });

  it('allows a slot that ends at midnight', () => {
    const slot = parseCalendar(calendarPayload([oneCourt({ slots: [{ start: 1320, end: 1440 }] })]), gameDate).courts[0]?.slots[0];
    expect(slot).toMatchObject({ startMinutes: 1320, endMinutes: 1440, durationMinutes: 120 });
  });

  it('names a court without a description after its id and strips control characters from real names', () => {
    const unnamed = { ...courtJson(oneCourt()), desc_recurso: undefined };
    const noisy = { ...courtJson(oneCourt({ id: 10 })), desc_recurso: ' Pista\u0000  8\n exterior ' };
    const courts = parseCalendar([[[unnamed, noisy]]], gameDate).courts;
    expect(courts.map((court) => court.name)).toEqual(['Court 9', 'Pista 8 exterior']);
  });

  it('caps the length of a court name', () => {
    const name = parseCalendar(calendarPayload([oneCourt({ name: 'x'.repeat(500) })]), gameDate).courts[0]?.name;
    expect(name).toHaveLength(80);
  });
});

describe('parseCalendar: own booking flag (`esta_en_reserva`)', () => {
  const ownFlag = (own: unknown): boolean | undefined =>
    parseCalendar(calendarPayload([oneCourt({ slots: [{ start: 540, end: 630, taken: true, own: own as number }] })]), gameDate).courts[0]?.slots[0]?.ownBooking;

  it.each([1, true, '1', 'true', 2])('is true for %j', (value) => expect(ownFlag(value)).toBe(true));
  it.each([0, false, '0', '', 'false', null])('is false for %j', (value) => expect(ownFlag(value)).toBe(false));

  it('is false when the key is absent', () => {
    const slot = parseCalendar(calendarPayload([oneCourt({ slots: [{ start: 540, end: 630, taken: true }] })]), gameDate).courts[0]?.slots[0];
    expect(slot?.ownBooking).toBe(false);
  });

  it('reports the flag as the site sends it, independent of `free`', () => {
    const slot = parseCalendar(calendarPayload([oneCourt({ slots: [{ start: 540, end: 630, own: 1 }] })]), gameDate).courts[0]?.slots[0];
    expect(slot).toMatchObject({ free: true, ownBooking: true });
  });

  describe('where the flag lives (unverified on the real site, so both places count)', () => {
    const reservation = (flag: unknown): Record<string, unknown> => ({ id: 1, fecha_creacion: '2026-10-12 07:00:36', tipo: 'normal', esta_en_reserva: flag });
    const ownOf = (slot: { own?: number | string | boolean; reserva?: unknown }): boolean | undefined =>
      parseCalendar(calendarPayload([oneCourt({ slots: [{ start: 540, end: 630, taken: true, ...slot }] })]), gameDate).courts[0]?.slots[0]?.ownBooking;

    it.each([
      ['on the slot only', { own: 1 }, true],
      ['inside the reservation only', { reserva: reservation(1) }, true],
      ['in both places', { own: 1, reserva: reservation(1) }, true],
      ['on the slot, with a false flag inside the reservation', { own: 1, reserva: reservation(0) }, true],
      ['inside the reservation, with a false flag on the slot', { own: 0, reserva: reservation(1) }, true],
      ['nowhere', { reserva: reservation(undefined) }, false],
      ['false in both places', { own: 0, reserva: reservation(0) }, false],
    ] as const)('%s', (_name, slot, expected) => {
      expect(ownOf(slot)).toBe(expected);
    });

    it.each([true, '1', 'true', 2])('accepts %j inside the reservation too', (flag) => expect(ownOf({ reserva: reservation(flag) })).toBe(true));
    it.each([false, 0, '0', '', 'false', null, [], {}])('rejects %j inside the reservation', (flag) => expect(ownOf({ reserva: reservation(flag) })).toBe(false));

    it('never reads the flag of a reservation that is absent (a free slot)', () => {
      const free = parseCalendar(calendarPayload([oneCourt({ slots: [{ start: 540, end: 630 }] })]), gameDate).courts[0]?.slots[0];
      expect(free).toMatchObject({ free: true, ownBooking: false });
    });

    it('keeps `free` false for a taken slot whose reservation says nothing about ownership', () => {
      expect(parseCalendar(calendarPayload([oneCourt({ slots: [{ start: 540, end: 630, taken: true }] })]), gameDate).courts[0]?.slots[0]).toMatchObject({
        free: false,
        ownBooking: false,
      });
    });
  });
});

describe('parseCalendar: `duracion` against the time range', () => {
  const durationOf = (slot: { start: number; end: number; duration?: number | string }): number | undefined =>
    parseCalendar(calendarPayload([oneCourt({ slots: [slot] })]), gameDate).courts[0]?.slots[0]?.durationMinutes;

  it('takes the declared duration when it differs from the range (it is what the site books by)', () => {
    expect(durationOf({ start: 540, end: 630, duration: 60 })).toBe(60);
    expect(durationOf({ start: 540, end: 600, duration: '120' })).toBe(120);
  });

  it('falls back to the range only when `duracion` is missing or unusable', () => {
    expect(durationOf({ start: 540, end: 630 })).toBe(90);
    expect(durationOf({ start: 540, end: 630, duration: 0 })).toBe(90);
    expect(durationOf({ start: 540, end: 630, duration: 'x' })).toBe(90);
  });
});

describe('parseCalendar: tolerance to extra keys and nesting', () => {
  const courts = [oneCourt()];

  it.each([
    ['a flat array of courts', (list: unknown[]) => list],
    ['two array levels', (list: unknown[]) => [list]],
    ['three array levels (the real shape)', (list: unknown[]) => [[list]]],
    ['four array levels', (list: unknown[]) => [[[list]]]],
    ['courts in a sparse object', (list: unknown[]) => [[Object.fromEntries(list.map((court, index) => [String(index + 3), court]))]]],
  ])('finds the courts in %s', (_name, wrap) => {
    const result = parseCalendar(wrap(courts.map(courtJson)), gameDate);
    expect(result.courts.map((court) => court.courtId)).toEqual([9]);
  });

  it('accepts `horari` as an object (PHP sparse list)', () => {
    const court = { ...courtJson(oneCourt()), horari: { 0: courtSlot(540), 3: courtSlot(630) } };
    expect(parseCalendar([[[court]]], gameDate).courts[0]?.slots.map((slot) => slot.startMinutes)).toEqual([540, 630]);
  });

  it('ignores unknown keys on courts and slots', () => {
    const payload = [[[{ ...courtJson(oneCourt()), brand_new: { deep: [1, 2, 3] }, horari: [{ ...courtSlot(540), reservar_pista: 0, anything: 'x' }] }]]];
    expect(parseCalendar(payload, gameDate).courts[0]?.slots).toEqual([
      { startMinutes: 540, endMinutes: 630, durationMinutes: 90, free: true, ownBooking: false },
    ]);
  });

  it('accepts nesting up to the limit and rejects anything deeper', () => {
    const nest = (levels: number): unknown => Array.from({ length: levels }).reduce<unknown>((inner) => [inner], courtJson(oneCourt()));
    expect(parseCalendar(nest(8), gameDate).courts).toHaveLength(1);
    expect(failureOf(nest(12)).message).toContain('nesting');
  });
});

const courtSlot = (start: number): Record<string, unknown> => ({ hora_ini: start, hora_fin: start + 90, duracion: 90, reserva: null });

describe('parseCalendar: wrong shapes fail loudly', () => {
  it.each([
    ['null', null],
    ['a string', 'oops'],
    ['a number', 7],
    ['an object', {}],
    ['an error envelope', { status: 'error', msg: 'nope' }],
  ])('rejects %s at the top level', (_name, payload) => {
    expect(failureOf(payload).message).toContain('top level');
  });

  it.each([
    ['a primitive among the courts', [[[courtJson(oneCourt()), 'x']]]],
    ['null among the courts', [[[courtJson(oneCourt()), null]]]],
    ['an unrelated object among the courts', [[[{ message: 'nope' }]]]],
  ])('rejects %s', (_name, payload) => {
    failureOf(payload);
  });

  const withCourt = (patch: Record<string, unknown>): unknown => [[[{ ...courtJson(oneCourt()), ...patch }]]];
  const withSlot = (patch: Record<string, unknown>): unknown => withCourt({ horari: [{ ...courtSlot(1080), ...patch }] });

  it.each([
    ['a court id of zero', withCourt({ id_mst_recurso: 0 })],
    ['a negative court id', withCourt({ id_mst_recurso: -4 })],
    ['a fractional court id', withCourt({ id_mst_recurso: 4.5 })],
    ['a non-numeric court id', withCourt({ id_mst_recurso: 'nine' })],
    ['a missing `horari`', withCourt({ horari: undefined })],
    ['a null `horari`', withCourt({ horari: null })],
    ['a string `horari`', withCourt({ horari: 'none' })],
    ['a slot that is not an object', withCourt({ horari: ['x'] })],
    ['a slot without hora_ini', withSlot({ hora_ini: undefined })],
    ['a slot without hora_fin', withSlot({ hora_fin: undefined })],
    ['a slot with non-numeric minutes', withSlot({ hora_ini: 'six' })],
    ['a slot with negative minutes', withSlot({ hora_ini: -30 })],
    ['a slot with minutes beyond a day', withSlot({ hora_fin: 5000 })],
    ['a slot starting at midnight of the next day', withSlot({ hora_ini: 1440, hora_fin: 1440 })],
    ['a slot that ends before it starts', withSlot({ hora_ini: 1200, hora_fin: 1100 })],
    ['a slot of zero length', withSlot({ hora_ini: 1200, hora_fin: 1200 })],
    ['a slot without `reserva`', withSlot({ reserva: undefined })],
    ['a string `reserva`', withSlot({ reserva: 'libre' })],
    ['a numeric `reserva`', withSlot({ reserva: 0 })],
    ['a boolean `reserva`', withSlot({ reserva: false })],
  ])('rejects %s', (_name, payload) => {
    failureOf(payload);
  });

  it('names the offending court and slot by position, never by value', () => {
    const payload = withCourt({ horari: [courtSlot(540), { ...courtSlot(630), hora_ini: 'ZZ-LEAK-ZZ' }] });
    const message = failureOf(payload).message;
    expect(message).toContain('court #0 slot #1');
    expect(message).toContain('hora_ini');
    expect(message).not.toContain('ZZ-LEAK-ZZ');
  });

  it('rejects an absurd number of courts or slots', () => {
    expect(() => parseCalendar([[Array.from({ length: 101 }, () => courtJson(oneCourt()))]], gameDate)).toThrow(UnexpectedResponseError);
    const slots = Array.from({ length: 1001 }, () => ({ start: 540, end: 630 }));
    expect(() => parseCalendar(calendarPayload([oneCourt({ slots })]), gameDate)).toThrow(UnexpectedResponseError);
  });

  it('fails the whole day when one slot is malformed (no silent partial calendars)', () => {
    const payload = withCourt({ horari: [courtSlot(540), { hora_ini: 600 }, courtSlot(690)] });
    failureOf(payload);
  });
});
