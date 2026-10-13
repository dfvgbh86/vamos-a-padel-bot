import { afterEach, describe, expect, it, vi } from 'vitest';
import { CourtNotAllowedError } from '../../src/config/courts.js';
import { parseGameDate } from '../../src/config/gameDate.js';
import type { BookRequest } from '../../src/contracts.js';
import { buildAddEventBody } from '../../src/reservaplay/bookingBody.js';
import { ACCOUNT_ID, BASE_URL, HASH } from '../fixtures/reservaplay/constants.js';
import { bodyParams } from '../fixtures/reservaplay/fakeFetch.js';
import { AUTHED_SESSION } from '../fixtures/reservaplay/fakeSite.js';
import { bookingErrorPayload, bookingOkPayload, loginPageHtml } from '../fixtures/reservaplay/pages.js';
import { emptyResponse, htmlResponse, jsonResponse, redirectResponse } from '../fixtures/reservaplay/responses.js';
import { posts, ready, respondWith } from './bookHelpers.js';
import { bookRequest, slotRef } from './helpers.js';

const OTHER_HASH = 'f'.repeat(40);
const MANAGER_URL = `${BASE_URL}/sportssuite/manager.php`;

afterEach(() => {
  vi.useRealTimers();
});

describe('book(): the request that goes out', () => {
  const EXPECTED_BODY =
    `hash=${HASH}&id_reserva=&libres=0&libres_step=1&nivel=0&nivel_max=7&sx=-&lista_usuarios=0` +
    '&data=2026-10-19+00%3A00%3A00&recurso=9&op=add_event&desactivar_pago=0' +
    '&tipo_pago_anticipado_socio=5&array_of_bonos=&esReservaFija=0&array_of_bonos=&esReservaFija=0' +
    '&tipoabonos=0&tipo_pago_anticipado_tpvonline=0&duration=90&time_ini=18%3A00' +
    '&socis=12345%2C3%2C3%2C3';

  it('posts the exact add_event body to manager.php with the site headers and the session cookie', async () => {
    const { site, client } = await ready();
    await client.book(bookRequest());

    expect(posts(site)).toHaveLength(1);
    const call = posts(site)[0];
    expect(call).toMatchObject({ method: 'POST', url: MANAGER_URL, body: EXPECTED_BODY, redirect: 'manual' });
    expect(call?.headers['content-type']).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    expect(call?.headers['x-requested-with']).toBe('XMLHttpRequest');
    expect(call?.headers['accept']).toContain('application/json');
    expect(call?.headers['cookie']).toContain(`laravel_session=${AUTHED_SESSION}`);
  });

  it('builds the body only through buildAddEventBody (byte for byte, wallet and card)', async () => {
    for (const payment of ['wallet', 'card'] as const) {
      const { site, client } = await ready();
      const request = bookRequest({ payment });
      await client.book(request);
      expect(posts(site)[0]?.body).toBe(
        buildAddEventBody({
          hash: HASH,
          accountId: ACCOUNT_ID,
          gameDate: request.slot.gameDate,
          courtId: request.slot.courtId,
          startMinutes: request.slot.startMinutes,
          durationMinutes: request.slot.durationMinutes,
          payment,
          holidays: request.holidays,
        }),
      );
    }
  });

  it('uses the hash and account of the request, and the slot of the request', async () => {
    const { site, client } = await ready();
    await client.book(
      bookRequest({
        slot: slotRef({ courtId: 4, startMinutes: 570, durationMinutes: 60, gameDate: parseGameDate('2026-10-20') }),
        account: { accountId: 777, hash: OTHER_HASH },
      }),
    );
    const params = bodyParams(posts(site)[0]!);
    expect(params.get('hash')).toBe(OTHER_HASH);
    expect(params.get('socis')).toBe('777,3,3,3');
    expect(params.get('recurso')).toBe('4');
    expect(params.get('time_ini')).toBe('09:30');
    expect(params.get('duration')).toBe('60');
    expect(params.get('data')).toBe('2026-10-20 00:00:00');
  });

  it('sends no other request: no probe, no retry, no login', async () => {
    const { site, client } = await ready();
    await client.book(bookRequest());
    expect(site.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual(['POST /sportssuite/manager.php']);
  });
});

describe('book(): the academy guard and input validation run before anything is sent', () => {
  it.each([1, 2, 3, 7, 8])('refuses academy court id %i on a weekday', async (courtId) => {
    const { site, client } = await ready();
    await expect(client.book(bookRequest({ slot: slotRef({ courtId }) }))).rejects.toBeInstanceOf(CourtNotAllowedError);
    expect(site.calls).toHaveLength(0);
  });

  it('allows an academy court on a weekend and on a holiday known to the request', async () => {
    const { site, client } = await ready();
    expect(await client.book(bookRequest({ slot: slotRef({ courtId: 1, gameDate: parseGameDate('2026-10-24') }) }))).toMatchObject({ kind: 'booked' });
    const holiday = parseGameDate('2026-12-08');
    expect(await client.book(bookRequest({ slot: slotRef({ courtId: 1, gameDate: holiday }), holidays: new Set([holiday]) }))).toMatchObject({ kind: 'booked' });
    expect(posts(site)).toHaveLength(2);
  });

  it('refuses a weekday academy court when the request does not list the date as a holiday', async () => {
    const { site, client } = await ready();
    const slot = slotRef({ courtId: 1, gameDate: parseGameDate('2026-12-08') });
    await expect(client.book(bookRequest({ slot, holidays: new Set() }))).rejects.toBeInstanceOf(CourtNotAllowedError);
    expect(site.calls).toHaveLength(0);
  });

  describe('without holidays in the request', () => {
    const withoutHolidays = (request: BookRequest): BookRequest => ({ ...request, holidays: undefined }) as unknown as BookRequest;

    it('falls back to the official holiday calendar', async () => {
      const { client } = await ready();
      const slot = slotRef({ courtId: 1, gameDate: parseGameDate('2026-12-08') });
      expect(await client.book(withoutHolidays(bookRequest({ slot })))).toMatchObject({ kind: 'booked' });
    });

    it('falls back to the holidays given in the configuration, and to nothing else', async () => {
      const custom = parseGameDate('2026-11-17');
      const slot = slotRef({ courtId: 1, gameDate: custom });

      const configured = await ready({ holidays: new Set([custom]) });
      expect(await configured.client.book(withoutHolidays(bookRequest({ slot })))).toMatchObject({ kind: 'booked' });

      const plain = await ready();
      await expect(plain.client.book(withoutHolidays(bookRequest({ slot })))).rejects.toBeInstanceOf(CourtNotAllowedError);
      expect(plain.site.calls).toHaveLength(0);
    });
  });

  it.each([
    ['a hash that is not 40 hex characters', { account: { accountId: ACCOUNT_ID, hash: 'not-a-hash' } }],
    ['an upper-case hash', { account: { accountId: ACCOUNT_ID, hash: HASH.toUpperCase() } }],
    ['the guest account id', { account: { accountId: 3, hash: HASH } }],
    ['a negative account id', { account: { accountId: -1, hash: HASH } }],
    ['a payment mode that is neither wallet nor card', { payment: 'cash' as unknown as 'wallet' }],
    ['a duration below the minimum', { slot: slotRef({ durationMinutes: 30 }) }],
    ['a start time beyond the day', { slot: slotRef({ startMinutes: 1440 }) }],
    ['a date that is not a real calendar day', { slot: { ...slotRef(), gameDate: '2026-02-30' as never } }],
  ])('refuses %s', async (_name, overrides) => {
    const { site, client } = await ready();
    await expect(client.book(bookRequest(overrides))).rejects.toThrow();
    expect(site.calls).toHaveLength(0);
  });

  it('does not leave the in-flight flag set after a refusal', async () => {
    const { client } = await ready();
    await expect(client.book(bookRequest({ slot: slotRef({ courtId: 1 }) }))).rejects.toBeInstanceOf(CourtNotAllowedError);
    await expect(client.book(bookRequest())).resolves.toMatchObject({ kind: 'booked' });
  });
});

describe('book(): outcomes of a response that was received', () => {
  it('maps the real success payload to booked with the reservation id', async () => {
    const { site, client } = await ready();
    respondWith(site, () => jsonResponse(bookingOkPayload(100002)));
    expect(await client.book(bookRequest())).toEqual({ kind: 'booked', reservationId: 100002 });
  });

  it.each([
    ['not open yet', bookingErrorPayload('No se puede reservar a 8 o más dias vista.'), 200, { kind: 'not_open_yet' }],
    ['daily limit', bookingErrorPayload('Ya tienes 1 reserva/s para este dia.'), 200, { kind: 'daily_limit' }],
    ['too short', bookingErrorPayload('El tiempo de reserva mínimo es de 60 minutos'), 200, { kind: 'too_short' }],
    ['an unrecognised error message', bookingErrorPayload('Algo nuevo ha pasado'), 200, { kind: 'unknown', status: 200, message: 'Algo nuevo ha pasado' }],
    ['a success without a reservation id', { status: 'ok', data: { msg: 'hecho', redirect: { url: 'cal_week.php' } } }, 200, { kind: 'unknown', status: 200, message: 'hecho' }],
    ['a success status on a non-2xx answer', { ...bookingOkPayload(5) }, 400, { kind: 'unknown', status: 400, message: expect.any(String) as unknown as string }],
  ])('maps %s to a rejection', async (_name, payload, status, outcome) => {
    const { site, client } = await ready();
    respondWith(site, () => jsonResponse(payload, { status }));
    expect(await client.book(bookRequest())).toEqual({ kind: 'rejected', outcome });
    expect(posts(site)).toHaveLength(1);
  });

  it('never reports booked without an explicit reservation id', async () => {
    const { site, client } = await ready();
    for (const payload of [{ status: 'ok' }, { status: 'ok', data: {} }, { status: 'ok', data: { redirect: { url: 'cal_event.php?id=0' } } }, { status: 'ok', data: { redirect: { url: 'cal_event.php?id=abc' } } }]) {
      respondWith(site, () => jsonResponse(payload));
      expect((await client.book(bookRequest())).kind).toBe('rejected');
    }
  });

  it('maps a 500 (Laravel debug page) to server_error without exposing the page', async () => {
    const { site, client } = await ready();
    respondWith(site, () => htmlResponse('<html>Whoops, DEBUG-PAGE-MARKER stack trace</html>', { status: 500 }));
    const result = await client.book(bookRequest());
    expect(result).toEqual({ kind: 'rejected', outcome: { kind: 'server_error', status: 500 } });
    expect(JSON.stringify(result)).not.toContain('DEBUG-PAGE-MARKER');
  });

  it('maps a 503 to server_error', async () => {
    const { site, client } = await ready();
    respondWith(site, () => emptyResponse(503));
    expect(await client.book(bookRequest())).toEqual({ kind: 'rejected', outcome: { kind: 'server_error', status: 503 } });
  });

  it.each([
    ['HTTP 401', () => emptyResponse(401)],
    ['HTTP 419', () => emptyResponse(419)],
    ['a redirect to /login', () => redirectResponse('/login')],
  ])('maps %s to auth_expired and does not log in again by itself', async (_name, response) => {
    const { site, client } = await ready();
    respondWith(site, response);
    expect(await client.book(bookRequest())).toEqual({ kind: 'rejected', outcome: { kind: 'auth_expired' } });
    expect(site.calls).toHaveLength(1);
  });

  it('maps an expired session on the real site to auth_expired', async () => {
    const { site, client } = await ready();
    site.expireSession();
    expect(await client.book(bookRequest())).toEqual({ kind: 'rejected', outcome: { kind: 'auth_expired' } });
    expect(site.calls).toHaveLength(1);
  });

  it.each([
    ['an HTML page', () => htmlResponse('<html>surprise</html>')],
    ['the login page', () => htmlResponse(loginPageHtml())],
    ['an empty body', () => emptyResponse(200)],
    ['a redirect elsewhere', () => redirectResponse('/elsewhere')],
  ])('maps %s to unknown (stop, never retry), without the body', async (_name, response) => {
    const { site, client } = await ready();
    respondWith(site, response);
    const result = await client.book(bookRequest());
    expect(result).toMatchObject({ kind: 'rejected', outcome: { kind: 'unknown' } });
    expect(JSON.stringify(result)).not.toContain('surprise');
  });

  it.each([502, 504])('treats a gateway answer (HTTP %i) as ambiguous: the backend may have processed the request', async (status) => {
    const { site, client } = await ready();
    respondWith(site, () => htmlResponse('Gateway problem', { status }));
    expect(await client.book(bookRequest())).toEqual({ kind: 'ambiguous' });
    expect(posts(site)).toHaveLength(1);
  });
});

