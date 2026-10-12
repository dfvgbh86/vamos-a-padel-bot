import { describe, expect, it } from 'vitest';
import { CourtNotAllowedError } from '../src/config/courts.js';
import { parseGameDate } from '../src/config/gameDate.js';
import { buildHolidaySet } from '../src/config/holidays.js';
import { buildAddEventBody, type AddEventRequest } from '../src/reservaplay/bookingBody.js';

const holidays = buildHolidaySet(undefined);
const HASH = 'a'.repeat(40);

const base: AddEventRequest = {
  hash: HASH,
  accountId: 12345,
  gameDate: parseGameDate('2026-10-19'),
  courtId: 9,
  startMinutes: 1080,
  durationMinutes: 90,
  payment: 'wallet',
  holidays,
};

describe('buildAddEventBody', () => {
  it('reproduces byte-for-byte the wallet booking captured from the real site on 2026-10-12', () => {
    expect(buildAddEventBody(base)).toBe(
      `hash=${HASH}&id_reserva=&libres=0&libres_step=1&nivel=0&nivel_max=7&sx=-&lista_usuarios=0` +
        '&data=2026-10-19+00%3A00%3A00&recurso=9&op=add_event&desactivar_pago=0' +
        '&tipo_pago_anticipado_socio=5&array_of_bonos=&esReservaFija=0&array_of_bonos=&esReservaFija=0' +
        '&tipoabonos=0&tipo_pago_anticipado_tpvonline=0&duration=90&time_ini=18%3A00' +
        '&socis=12345%2C3%2C3%2C3',
    );
  });

  it('uses payment type 2 and tpvonline=1 for the card variant', () => {
    const body = new URLSearchParams(buildAddEventBody({ ...base, payment: 'card' }));
    expect(body.get('tipo_pago_anticipado_socio')).toBe('2');
    expect(body.get('tipo_pago_anticipado_tpvonline')).toBe('1');
  });

  it('zero-pads the start time and encodes the date at midnight', () => {
    const body = new URLSearchParams(buildAddEventBody({ ...base, courtId: 4, startMinutes: 570 }));
    expect(body.get('time_ini')).toBe('09:30');
    expect(body.get('data')).toBe('2026-10-19 00:00:00');
    expect(body.get('recurso')).toBe('4');
  });

  it('lists the host plus exactly the requested number of guests', () => {
    expect(new URLSearchParams(buildAddEventBody({ ...base, guestCount: 2 })).get('socis')).toBe('12345,3,3');
    expect(new URLSearchParams(buildAddEventBody({ ...base, guestCount: 0 })).get('socis')).toBe('12345');
  });

  describe('academy guard runs on the values that are serialised', () => {
    it.each([1, 2, 3, 7, 8])('refuses academy court id %i on a weekday', (courtId) => {
      expect(() => buildAddEventBody({ ...base, courtId, gameDate: parseGameDate('2026-10-20') })).toThrow(
        CourtNotAllowedError,
      );
    });

    it('allows academy court ids on a weekend and on a holiday', () => {
      expect(() => buildAddEventBody({ ...base, courtId: 1, gameDate: parseGameDate('2026-10-24') })).not.toThrow();
      expect(() => buildAddEventBody({ ...base, courtId: 7, gameDate: parseGameDate('2026-12-08') })).not.toThrow();
    });

    it('refuses an unknown court id', () => {
      expect(() => buildAddEventBody({ ...base, courtId: 5 })).toThrow(CourtNotAllowedError);
    });
  });

  describe('input validation', () => {
    it.each([
      ['uppercase hash', { hash: 'A'.repeat(40) }],
      ['short hash', { hash: 'abc' }],
      ['hash with junk', { hash: `${'a'.repeat(39)}&` }],
      ['guest id as account', { accountId: 3 }],
      ['non-integer account', { accountId: 1.5 }],
      ['negative start', { startMinutes: -1 }],
      ['start at 24:00', { startMinutes: 1440 }],
      ['duration below 60', { durationMinutes: 30 }],
      ['duration above 180', { durationMinutes: 240 }],
      ['too many guests', { guestCount: 4 }],
    ] as const)('rejects %s', (_label, patch) => {
      expect(() => buildAddEventBody({ ...base, ...patch })).toThrow();
    });
  });
});
