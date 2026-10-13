import { describe, expect, it } from 'vitest';
import {
  classifyAddEventResponse,
  classifyFormPage,
  classifyTransportFailure,
  parseServerCheckTime,
} from '../src/reservaplay/classify.js';

const json = (value: unknown, status = 200) => ({ status, body: JSON.stringify(value) });

describe('classifyAddEventResponse', () => {
  it('recognises the real success payload and extracts the reservation id', () => {
    const real =
      '{\n    "status": "ok",\n    "data": {\n        "msg": "Gracias para añadir una reserva, su reserva ya ha sido publicada<br\\/>",\n' +
      '        "redirect": {\n            "url": "cal_event.php?id=100002",\n            "wait": 0,\n            "title": "Ficha reserva"\n        }\n    }\n}';
    expect(classifyAddEventResponse({ status: 200, body: real })).toEqual({ kind: 'ok', reservationId: 100002 });
  });

  it('never reports ok without a reservation id', () => {
    const outcome = classifyAddEventResponse(json({ status: 'ok', data: { msg: 'hecho', redirect: { url: 'cal_week.php' } } }));
    expect(outcome.kind).toBe('unknown');
  });

  it('maps the known site messages', () => {
    const body = (msg: string) => json({ status: 'error', data: { msg } });
    expect(classifyAddEventResponse(body('No se puede reservar a 8 o más dias vista.')).kind).toBe('not_open_yet');
    expect(classifyAddEventResponse(body('No puedes reservar hasta las 07:00. Hora actual comprobación:13/10/2026 00:10:08')).kind).toBe('not_open_yet');
    expect(classifyAddEventResponse(body('Ya tienes 1 reserva/s para este dia.')).kind).toBe('daily_limit');
    expect(classifyAddEventResponse(body('El tiempo de reserva mínimo es de 60 minutos')).kind).toBe('too_short');
  });

  it('keeps an unrecognised message as unknown, trimmed and stripped of markup', () => {
    const outcome = classifyAddEventResponse(json({ status: 'error', data: { msg: `<b>${'x'.repeat(400)}</b>` } }));
    expect(outcome).toMatchObject({ kind: 'unknown', status: 200 });
    expect(outcome.kind === 'unknown' && outcome.message?.length).toBe(160);
    expect(outcome.kind === 'unknown' && outcome.message).not.toContain('<');
  });

  it('classifies session problems', () => {
    expect(classifyAddEventResponse({ status: 419, body: '' }).kind).toBe('auth_expired');
    expect(classifyAddEventResponse({ status: 401, body: '' }).kind).toBe('auth_expired');
    expect(classifyAddEventResponse({ status: 302, location: 'https://x.test/login', body: '' }).kind).toBe('auth_expired');
    expect(classifyAddEventResponse({ status: 302, location: '/elsewhere', body: '' }).kind).toBe('unknown');
  });

  it('treats 5xx as server_error and never inspects or returns its body (Laravel debug page)', () => {
    const outcome = classifyAddEventResponse({ status: 500, body: '<script>Sfdump = ... secrets ...</script>' });
    expect(outcome).toEqual({ kind: 'server_error', status: 500 });
  });

  it('treats non-JSON 200 bodies as unknown without echoing the body', () => {
    expect(classifyAddEventResponse({ status: 200, body: '<html>surprise</html>' })).toEqual({
      kind: 'unknown',
      status: 200,
      message: null,
    });
  });
});

describe('classifyTransportFailure', () => {
  it('is ambiguous once the request may have reached the server, otherwise not_sent', () => {
    expect(classifyTransportFailure(true)).toEqual({ kind: 'ambiguous' });
    expect(classifyTransportFailure(false)).toEqual({ kind: 'not_sent' });
  });
});

describe('classifyFormPage', () => {
  const HASH = '0123456789abcdef0123456789abcdef01234567';

  it('open: rendered form with the account hash (either attribute order)', () => {
    const nameFirst = `<form id="event-form"><input type="hidden" name="hash" value="${HASH}"></form>`;
    const valueFirst = `<form id="event-form"><input type="hidden" value="${HASH}" name="hash"></form>`;
    expect(classifyFormPage(nameFirst)).toEqual({ kind: 'open', hash: HASH });
    expect(classifyFormPage(valueFirst)).toEqual({ kind: 'open', hash: HASH });
  });

  it('a form without a hash is unknown, never open', () => {
    expect(classifyFormPage('<form id="event-form"></form>').kind).toBe('unknown');
  });

  it('window_closed with the embedded server clock', () => {
    const html =
      '<div class="msg msg-error">No se puede reservar a 8 o más dias vista. Hora actual comprobación:12/10/2026 22:33:54. Para volver a hacer la comprobación actualiza la página</div>';
    const gate = classifyFormPage(html);
    expect(gate.kind).toBe('window_closed');
    expect(gate.kind === 'window_closed' && gate.serverCheckTime?.toISO()).toBe('2026-10-12T22:33:54.000+02:00');
  });

  it('window_closed for the real midnight-to-07:00 wording, with the server clock', () => {
    const html =
      '<div class="msg msg-error">Usuarios<br/>No puedes reservar hasta las 07:00. Hora actual comprobación:13/10/2026 00:10:08. Para volver a hacer la comprobación actualiza la página o vuelve a entrar en la reserva</div>';
    const gate = classifyFormPage(html);
    expect(gate.kind).toBe('window_closed');
    expect(gate.kind === 'window_closed' && gate.serverCheckTime?.toISO()).toBe('2026-10-13T00:10:08.000+02:00');
  });

  it('daily_limit, too_short and login_required', () => {
    expect(classifyFormPage('<div class="msg">Ya tienes 1 reserva/s para este dia.</div>').kind).toBe('daily_limit');
    expect(classifyFormPage('<div class="msg">El tiempo de reserva mínimo es de 60 minutos</div>').kind).toBe('too_short');
    expect(classifyFormPage('<form><input name="username"><input type="password" name="password"></form>').kind).toBe(
      'login_required',
    );
  });

  it('anything else is unknown', () => {
    expect(classifyFormPage('<html>nothing useful</html>').kind).toBe('unknown');
  });
});

describe('parseServerCheckTime', () => {
  it('returns null when absent or impossible', () => {
    expect(parseServerCheckTime('no clock here')).toBeNull();
    expect(parseServerCheckTime('Hora actual comprobación:31/02/2026 10:00:00')).toBeNull();
  });
});
