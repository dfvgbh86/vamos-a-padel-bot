import { describe, expect, it } from 'vitest';
import { parseGameDate } from '../../src/config/gameDate.js';
import { UnexpectedResponseError } from '../../src/reservaplay/errors.js';
import { parseCalendar } from '../../src/reservaplay/parsers/index.js';
import { calendarPayload, courtJson } from '../fixtures/reservaplay/calendar.js';

const gameDate = parseGameDate('2026-10-19');

/** Obviously fake personal data; every value carries a marker that must never show up in any output. */
const PII = {
  nombre: 'PIIMARK-nombre',
  apellidos: 'PIIMARK-apellidos',
  pin: 'PIIMARK-pin',
  codigo_acceso: 'PIIMARK-codigo',
  email: 'PIIMARK-email@example.test',
  telefono: 'PIIMARK-telefono',
  dni: 'PIIMARK-dni',
  nif: 'PIIMARK-nif',
  participantes: [{ nombre: 'PIIMARK-participante', pin: 'PIIMARK-pin2' }],
  fecha_creacion: '2026-10-12 07:00:36',
};

const MARKER = /PIIMARK/;

describe('calendar parsing never lets other people\'s data survive', () => {
  const payload = calendarPayload([
    {
      id: 9,
      name: 'Pista 7',
      extra: { responsable: PII, notas_internas: 'PIIMARK-court-level' },
      slots: [
        { start: 540, end: 630, duration: 90, taken: true, reserva: PII, extra: { usuario: PII, nombre_cliente: 'PIIMARK-slot-level' } },
        { start: 630, end: 720, duration: 90, taken: true, own: 1, reserva: { ...PII, esta_en_reserva: 1 } },
        { start: 720, end: 810, duration: 90 },
        { start: 810, end: 900, duration: 90, taken: true, reserva: { ...PII, esta_en_reserva: 1 } },
      ],
    },
  ]);

  it('the input really contains the personal data (the test is not vacuous)', () => {
    expect(JSON.stringify(payload)).toMatch(MARKER);
  });

  it('the output has no trace of the reservation contents, nor of any other unlisted key', () => {
    const serialised = JSON.stringify(parseCalendar(payload, gameDate));
    expect(serialised).not.toMatch(MARKER);
    for (const key of Object.keys(PII)) expect(serialised).not.toContain(`"${key}"`);
    expect(serialised).not.toContain('reserva');
    expect(serialised).not.toContain('fecha_creacion');
  });

  it('the output objects have exactly the whitelisted keys', () => {
    const [court] = parseCalendar(payload, gameDate).courts;
    expect(Object.keys(court ?? {}).sort()).toEqual(['courtId', 'name', 'slots']);
    for (const slot of court?.slots ?? []) {
      expect(Object.keys(slot).sort()).toEqual(['durationMinutes', 'endMinutes', 'free', 'ownBooking', 'startMinutes']);
    }
  });

  it('reads the own-booking flag from the slot or from inside the reservation, and nothing else of the reservation', () => {
    const slots = parseCalendar(payload, gameDate).courts[0]?.slots;
    expect(slots?.map((slot) => slot.ownBooking)).toEqual([false, true, false, true]);
    expect(slots?.map((slot) => slot.free)).toEqual([false, false, true, false]);
  });

  it('the output is plain data: no getter, prototype or hidden property carries the reservation', () => {
    const [slot] = parseCalendar(payload, gameDate).courts[0]?.slots ?? [];
    expect(Object.getOwnPropertyNames(slot)).toHaveLength(5);
    expect(Object.getPrototypeOf(slot)).toBe(Object.prototype);
    expect(Object.getOwnPropertySymbols(slot ?? {})).toHaveLength(0);
  });

  describe('error messages', () => {
    const attempts: readonly [string, unknown][] = [
      ['a malformed slot next to personal data', calendarPayload([{ id: 9, slots: [{ start: 540, end: 630, taken: true, reserva: PII, extra: { hora_ini: 'PIIMARK-bad-minutes' } }] }])],
      ['a bad court id', [[[{ ...courtJson({ id: 9, slots: [] }), id_mst_recurso: 'PIIMARK-bad-id', responsable: PII }]]]],
      ['a reservation that is not an object', calendarPayload([{ id: 9, slots: [{ start: 540, end: 630, reserva: 'PIIMARK-string-reserva' }] }])],
      ['a primitive among the courts', [[[courtJson({ id: 9, slots: [] }), 'PIIMARK-primitive']]]],
      ['an error envelope', { status: 'error', msg: 'PIIMARK-envelope', data: PII }],
      ['a malformed reservation next to a bad time range', calendarPayload([{ id: 9, slots: [{ start: 700, end: 600, taken: true, reserva: PII }] }])],
    ];

    it.each(attempts)('never echo the response: %s', (_name, input) => {
      let caught: unknown;
      try {
        parseCalendar(input, gameDate);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UnexpectedResponseError);
      const error = caught as UnexpectedResponseError;
      expect(error.message).not.toMatch(MARKER);
      expect(error.stack ?? '').not.toMatch(MARKER);
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toMatch(MARKER);
      expect(error.cause).toBeUndefined();
    });
  });
});
