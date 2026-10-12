import { describe, expect, it } from 'vitest';
import {
  classifyAddEventResponse,
  classifyFormPage,
  classifyTransportFailure,
  parseServerCheckTime,
  type HttpResponseSummary,
} from '../../src/reservaplay/classify.js';
import { ECHO_MARKER, FAKE_HASH, makeRng, type Rng } from './_helpers.js';

const POST_KINDS = ['ok', 'not_open_yet', 'daily_limit', 'too_short', 'auth_expired', 'server_error', 'unknown'];
const FORM_KINDS = ['open', 'window_closed', 'daily_limit', 'too_short', 'login_required', 'unknown'];

const REAL_SUCCESS =
  '{\n    "status": "ok",\n    "data": {\n        "msg": "Gracias para añadir una reserva, su reserva ya ha sido publicada<br\\/>",\n' +
  '        "redirect": {\n            "url": "cal_event.php?id=100002",\n            "wait": 0,\n            "title": "Ficha reserva"\n        }\n    }\n}';

const post = (status: number, body: string, location?: string | null): HttpResponseSummary =>
  location === undefined ? { status, body } : { status, body, location };
const okBody = (url: string): string => JSON.stringify({ status: 'ok', data: { msg: 'x', redirect: { url } } });
const errBody = (msg: unknown): string => JSON.stringify({ status: 'error', data: { msg } });

describe('QA classifyAddEventResponse: structural oddities in the body', () => {
  it.each([
    ['JSON array', '[]'],
    ['array of ok objects', '[{"status":"ok","data":{"redirect":{"url":"cal_event.php?id=5"}}}]'],
    ['JSON null', 'null'],
    ['JSON number', '123'],
    ['JSON string', '"ok"'],
    ['JSON true', 'true'],
    ['empty object', '{}'],
    ['empty string', ''],
    ['whitespace', ' \n\t '],
    ['literal undefined', 'undefined'],
    ['truncated JSON', '{"status":"ok","data":{"redirect":{"url":"cal_event.php?id=6'],
    ['JSON with trailing garbage', `${REAL_SUCCESS}garbage`],
    ['two JSON documents', `${REAL_SUCCESS}${REAL_SUCCESS}`],
    ['HTML login page', '<html><body><form action="/login"><input name="username"><input name="password"></form></body></html>'],
    ['HTML 404', '<h1>404 Not Found</h1>'],
    ['PHP notice before JSON', `<br />\n<b>Notice</b>: Undefined index in manager.php on line 7<br />\n${REAL_SUCCESS}`],
    ['UTF-8 BOM before real success (fail-safe: unknown, never ok)', `﻿${REAL_SUCCESS}`],
  ])('200 + %s => unknown with no echoed body', (_label, body) => {
    const outcome = classifyAddEventResponse(post(200, body));
    expect(outcome.kind).toBe('unknown');
    expect(outcome).toMatchObject({ status: 200 });
  });

  it('non-JSON 200 bodies are never echoed (message is null)', () => {
    const outcome = classifyAddEventResponse(post(200, `<html>${ECHO_MARKER}</html>`));
    expect(outcome).toEqual({ kind: 'unknown', status: 200, message: null });
  });

  it('status field must be exactly the string "ok"', () => {
    for (const status of ['OK', 'Ok', ' ok', 'ok ', true, 1, 'true', ['ok'], null, { v: 'ok' }]) {
      const body = JSON.stringify({ status, data: { redirect: { url: 'cal_event.php?id=5' } } });
      expect(classifyAddEventResponse(post(200, body)).kind, JSON.stringify(status)).toBe('unknown');
    }
  });

  it('ok needs the id in data.redirect.url specifically, not elsewhere in the payload', () => {
    const variants = [
      { status: 'ok' },
      { status: 'ok', data: {} },
      { status: 'ok', data: { redirect: {} } },
      { status: 'ok', data: { redirect: { url: null } } },
      { status: 'ok', data: { redirect: { url: 5 } } },
      { status: 'ok', data: { redirect: 'cal_event.php?id=5' } },
      { status: 'ok', data: 'cal_event.php?id=5' },
      { status: 'ok', redirect: { url: 'cal_event.php?id=5' } },
      { status: 'ok', url: 'cal_event.php?id=5' },
      { status: 'ok', id: 5, data: { id: 5, reserva: 5, msg: 'cal_event.php?id=5' } },
      { status: 'ok', data: { redirect: { url: 'cal_week.php?id=5' } } },
      { status: 'ok', data: { redirect: { url: 'cal_event.php' } } },
      { status: 'ok', data: { redirect: { url: 'cal_event.php?id=' } } },
      { status: 'ok', data: { redirect: { url: 'cal_event.php?id=abc' } } },
      { status: 'ok', data: { redirect: { url: 'cal_event.php?id=-5' } } },
      { status: 'ok', data: { redirect: { url: 'cal_event.php?id=%35' } } },
      { status: 'ok', data: { redirect: { url: 'cal_event.php?id=٣' } } },
      { status: 'ok', data: { redirect: { url: 'CAL_EVENT.PHP?id=5' } } },
      { status: 'ok', data: { redirect: { url: ['cal_event.php?id=5'] } } },
    ];
    for (const variant of variants) {
      expect(classifyAddEventResponse(post(200, JSON.stringify(variant))).kind, JSON.stringify(variant)).toBe('unknown');
    }
  });

  it('reservation id: leading zeros are numeric, absolute URLs work, other plausible ids are read verbatim', () => {
    expect(classifyAddEventResponse(post(200, okBody('cal_event.php?id=00100002')))).toEqual({ kind: 'ok', reservationId: 100002 });
    expect(classifyAddEventResponse(post(200, okBody('/reserves/cal_event.php?id=100002')))).toEqual({ kind: 'ok', reservationId: 100002 });
    expect(classifyAddEventResponse(post(200, okBody('https://club.example/reserves/cal_event.php?id=100002')))).toEqual({
      kind: 'ok',
      reservationId: 100002,
    });
    expect(classifyAddEventResponse(post(200, okBody('cal_event.php?id=1')))).toEqual({ kind: 'ok', reservationId: 1 });
    expect(classifyAddEventResponse(post(201, okBody('cal_event.php?id=100002')))).toEqual({ kind: 'ok', reservationId: 100002 });
  });

  it('real success payload with every key removed one by one is never ok unless the id survives', () => {
    const real = JSON.parse(REAL_SUCCESS) as { status: string; data: { msg: string; redirect: { url: string; wait: number; title: string } } };
    expect(classifyAddEventResponse(post(200, JSON.stringify(real))).kind).toBe('ok');
    const without = (mutate: (copy: typeof real) => void) => {
      const copy = JSON.parse(JSON.stringify(real)) as typeof real;
      mutate(copy);
      return classifyAddEventResponse(post(200, JSON.stringify(copy))).kind;
    };
    expect(without((c) => delete (c as Partial<typeof c>).status)).toBe('unknown');
    expect(without((c) => delete (c as Partial<typeof c>).data)).toBe('unknown');
    expect(without((c) => delete (c.data as Partial<typeof c.data>).redirect)).toBe('unknown');
    expect(without((c) => delete (c.data.redirect as Partial<typeof c.data.redirect>).url)).toBe('unknown');
    expect(without((c) => delete (c.data as Partial<typeof c.data>).msg)).toBe('ok'); // msg is cosmetic
    expect(without((c) => (c.data.redirect.url = 'cal_event.php?id='))).toBe('unknown');
  });
});

describe('QA classifyAddEventResponse: prototype-pollution-like payloads', () => {
  it('__proto__ / constructor / prototype keys cannot fake success, and Object.prototype stays clean', () => {
    const bodies = [
      '{"__proto__":{"status":"ok","data":{"redirect":{"url":"cal_event.php?id=5"}}}}',
      '{"status":"ok","data":{"__proto__":{"redirect":{"url":"cal_event.php?id=5"}}}}',
      '{"status":"ok","data":{"redirect":{"__proto__":{"url":"cal_event.php?id=5"}}}}',
      '{"constructor":{"prototype":{"status":"ok"}}}',
      '{"status":"ok","data":{"constructor":{"redirect":{"url":"cal_event.php?id=5"}}}}',
      '{"data":{"__proto__":{"msg":"No se puede reservar a 8 o más dias vista"}}}',
      '{"__proto__":{"msg":"No se puede reservar a 8 o más dias vista"}}',
    ];
    for (const body of bodies) {
      const outcome = classifyAddEventResponse(post(200, body));
      expect(outcome.kind, body).toBe('unknown');
    }
    expect(({} as Record<string, unknown>)['status']).toBeUndefined();
    expect(({} as Record<string, unknown>)['redirect']).toBeUndefined();
    expect(({} as Record<string, unknown>)['msg']).toBeUndefined();
  });
});

describe('QA classifyAddEventResponse: HTTP status handling', () => {
  it('401 and 419 are auth_expired whatever the body says', () => {
    for (const status of [401, 419]) {
      for (const body of ['', REAL_SUCCESS, '<html>', ECHO_MARKER]) {
        expect(classifyAddEventResponse(post(status, body))).toEqual({ kind: 'auth_expired' });
      }
    }
  });

  it('every 5xx (and above) is server_error and the body is never echoed, whatever it contains', () => {
    const nasty = [
      `<html>${ECHO_MARKER}</html>`,
      `{"status":"ok","data":{"redirect":{"url":"cal_event.php?id=5"}},"x":"${ECHO_MARKER}"}`,
      `{"msg":"No se puede reservar a 8 o más dias vista ${ECHO_MARKER}"}`,
      `Ya tienes 1 reserva ${ECHO_MARKER}`,
      ECHO_MARKER.repeat(5000),
      '',
    ];
    for (let status = 500; status <= 599; status += 1) {
      for (const body of nasty) {
        const outcome = classifyAddEventResponse(post(status, body));
        expect(outcome).toEqual({ kind: 'server_error', status });
        expect(JSON.stringify(outcome)).not.toContain(ECHO_MARKER);
      }
    }
  });

  it('3xx: only a Location containing /login means auth_expired; missing/null/other Location is unknown', () => {
    for (const status of [300, 301, 302, 303, 307, 308, 399]) {
      expect(classifyAddEventResponse(post(status, '')), `${status} no location`).toEqual({ kind: 'unknown', status, message: null });
      expect(classifyAddEventResponse(post(status, '', null)), `${status} null location`).toEqual({ kind: 'unknown', status, message: null });
      expect(classifyAddEventResponse(post(status, '', '')), `${status} empty location`).toEqual({ kind: 'unknown', status, message: null });
      expect(classifyAddEventResponse(post(status, '', '/home')), `${status} /home`).toEqual({ kind: 'unknown', status, message: null });
      expect(classifyAddEventResponse(post(status, '', '/login')), `${status} /login`).toEqual({ kind: 'auth_expired' });
      expect(classifyAddEventResponse(post(status, '', 'https://club.example/login?x=1')), `${status} absolute /login`).toEqual({ kind: 'auth_expired' });
    }
  });

  it('a 3xx never inspects the body: a redirect carrying a success JSON is not ok', () => {
    expect(classifyAddEventResponse(post(302, REAL_SUCCESS, '/home')).kind).toBe('unknown');
    expect(classifyAddEventResponse(post(301, REAL_SUCCESS)).kind).toBe('unknown');
  });

  it('2xx/4xx HTML (e.g. a login page served with 200, or a 403/404/422/429 page) is unknown, not auth_expired and not ok', () => {
    const login = '<form><input name="username"><input type="password" name="password"></form>';
    for (const status of [200, 202, 400, 403, 404, 405, 409, 422, 429]) {
      expect(classifyAddEventResponse(post(status, login)), String(status)).toEqual({ kind: 'unknown', status, message: null });
    }
  });
});

describe('QA classifyAddEventResponse: message matching', () => {
  const kindOf = (msg: unknown) => classifyAddEventResponse(post(200, errBody(msg))).kind;

  it('upper/lower case, accents (precomposed or decomposed), mixed whitespace and inline tags are tolerated', () => {
    const variants = [
      'No se puede reservar a 8 o más dias vista',
      'NO SE PUEDE RESERVAR A 8 O MÁS DÍAS VISTA',
      'no se puede reservar a 8 o mas dias vista',
      'No se puede reservar a 8 o más días vista', // decomposed accents
      'No se puede reservar a 8 o más días vista', // NBSP
      'No se puede reservar a 8 o más días\n\t vista',
      'No se puede reservar a 8 o más <b>dias</b> <i>vista</i>',
      '<div class="msg msg-error">No se puede reservar a 8 o más dias vista. Hora actual comprobación:12/10/2026 22:33:54</div>',
    ];
    for (const variant of variants) expect(kindOf(variant), variant).toBe('not_open_yet');
    for (const variant of ['Ya tienes 1 reserva/s para este dia', 'YA TIENES 2 RESERVA/S PARA ESTE DÍA', 'Ya  tienes\n1\treserva/s']) {
      expect(kindOf(variant), variant).toBe('daily_limit');
    }
    for (const variant of ['El tiempo de reserva mínimo es de 60 minutos', 'EL TIEMPO DE RESERVA MINIMO', 'El tiempo de reserva mínimo']) {
      expect(kindOf(variant), variant).toBe('too_short');
    }
  });

  it('HTML-entity encoded variants are NOT matched (fail-safe unknown; characterisation, see report)', () => {
    expect(kindOf('No se puede reservar a 8 o m&aacute;s d&iacute;as vista')).toBe('unknown');
    expect(kindOf('dias&nbsp;vista')).toBe('unknown');
  });

  it('message in any of the supported keys is found; first non-empty string wins; non-strings are ignored', () => {
    const call = (payload: unknown) => classifyAddEventResponse(post(200, JSON.stringify(payload))).kind;
    expect(call({ status: 'error', msg: 'dias vista' })).toBe('not_open_yet');
    expect(call({ status: 'error', message: 'dias vista' })).toBe('not_open_yet');
    expect(call({ status: 'error', error_msg: 'dias vista' })).toBe('not_open_yet');
    expect(call({ status: 'error', data: { msg: 'dias vista' } })).toBe('not_open_yet');
    expect(call({ status: 'error', data: { msg: 5 }, msg: 'dias vista' })).toBe('not_open_yet');
    expect(call({ status: 'error', data: { msg: '' }, msg: 'dias vista' })).toBe('not_open_yet');
    expect(call({ status: 'error', data: { msg: ['dias vista'] } })).toBe('unknown');
    expect(call({ status: 'error', data: { msg: { text: 'dias vista' } } })).toBe('unknown');
    expect(call({ status: 'error', data: { msg: null } })).toBe('unknown');
    expect(call({ status: 'error', data: { msg: 12345 } })).toBe('unknown');
    expect(call({ status: 'error', data: ['dias vista'] })).toBe('unknown');
  });

  it('a daily_limit or too_short phrase alone, or only part of it, does not trigger the class', () => {
    expect(kindOf('Ya tienes')).toBe('unknown');
    expect(kindOf('reserva')).toBe('unknown');
    expect(kindOf('Ya hay una reserva en esa pista')).toBe('unknown');
    expect(kindOf('El tiempo de reserva')).toBe('unknown');
    expect(kindOf('tiempo minimo')).toBe('unknown');
    expect(kindOf('No tienes saldo suficiente en el monedero')).toBe('unknown');
    expect(kindOf('Pista ocupada')).toBe('unknown');
  });

  it('unknown keeps a bounded, tag-free message and never more than 160 chars', () => {
    const outcome = classifyAddEventResponse(post(200, errBody(`<script>alert(1)</script><b>${'é'.repeat(500)}</b>${ECHO_MARKER}`)));
    expect(outcome.kind).toBe('unknown');
    if (outcome.kind === 'unknown') {
      expect((outcome.message ?? '').length).toBeLessThanOrEqual(160);
      expect(outcome.message).not.toMatch(/<[^>]*>/);
    }
  });
});

describe('QA classifyTransportFailure', () => {
  it('truthiness quirks: only literal true is ambiguous (the typed contract), everything else is not_sent for falsy', () => {
    expect(classifyTransportFailure(true)).toEqual({ kind: 'ambiguous' });
    expect(classifyTransportFailure(false)).toEqual({ kind: 'not_sent' });
    expect(classifyTransportFailure(0 as unknown as boolean)).toEqual({ kind: 'not_sent' });
    expect(classifyTransportFailure(undefined as unknown as boolean)).toEqual({ kind: 'not_sent' });
  });
});

describe('QA classifyFormPage', () => {
  const form = (input: string) => `<form id="event-form" method="post">${input}</form>`;

  it('open: both attribute orders, single or double quotes, extra attributes and newlines between them', () => {
    const inputs = [
      `<input type="hidden" name="hash" value="${FAKE_HASH}">`,
      `<input type="hidden" value="${FAKE_HASH}" name="hash">`,
      `<input name='hash' value='${FAKE_HASH}'>`,
      `<input value='${FAKE_HASH}' name='hash'>`,
      `<input\n  type="hidden"\n  name="hash"\n  class="x"\n  value="${FAKE_HASH}"\n/>`,
      // attribute NAMES are case-insensitive in HTML; the field name and the hex value are matched exactly
      `<INPUT TYPE="HIDDEN" NAME="hash" VALUE="${FAKE_HASH}">`,
      `<input id="hash" name="hash" data-x="y" value="${FAKE_HASH}" readonly>`,
    ];
    for (const input of inputs) expect(classifyFormPage(form(input)), input).toEqual({ kind: 'open', hash: FAKE_HASH });
  });

  it('a hash of the wrong length or alphabet is never open', () => {
    const bad = [FAKE_HASH.slice(1), `${FAKE_HASH}a`, '', 'g'.repeat(40), `${FAKE_HASH.slice(0, 39)}-`, ` ${FAKE_HASH}`, `${FAKE_HASH} `, FAKE_HASH.repeat(2), '٠'.repeat(40)];
    for (const hash of bad) {
      expect(classifyFormPage(form(`<input name="hash" value="${hash}">`)).kind, JSON.stringify(hash)).toBe('unknown');
      expect(classifyFormPage(form(`<input value="${hash}" name="hash">`)).kind, JSON.stringify(hash)).toBe('unknown');
    }
  });

  it('only an input literally named hash counts', () => {
    for (const name of ['hash2', 'xhash', 'hash_', 'Hash ', 'data-hash', 'user_hash']) {
      expect(classifyFormPage(form(`<input name="${name}" value="${FAKE_HASH}">`)).kind, name).toBe('unknown');
    }
  });

  it('no event-form marker => never open, even if a hash input exists', () => {
    expect(classifyFormPage(`<form><input name="hash" value="${FAKE_HASH}"></form>`).kind).toBe('unknown');
    expect(classifyFormPage(`<form id="other-form"><input name="hash" value="${FAKE_HASH}"></form>`).kind).toBe('unknown');
    expect(classifyFormPage(`<form id="EVENT-FORM"><input name="hash" value="${FAKE_HASH}"></form>`).kind).toBe('unknown');
  });

  it('login page: username + password => login_required; either one alone => unknown', () => {
    expect(classifyFormPage('<form action="/login"><input name="username"><input type="password" name="password"></form>').kind).toBe('login_required');
    expect(classifyFormPage("<input name='username'><input name='password'>").kind).toBe('login_required');
    expect(classifyFormPage('<form><input name="username"></form>').kind).toBe('unknown');
    expect(classifyFormPage('<form><input name="password"></form>').kind).toBe('unknown');
    expect(classifyFormPage('<form><input name="user"><input name="pass"></form>').kind).toBe('unknown');
  });

  it('the three server messages are recognised inside realistic markup, with accents/case variants', () => {
    expect(classifyFormPage('<div class="msg msg-error">NO SE PUEDE RESERVAR A 8 O MÁS DIAS VISTA</div>').kind).toBe('window_closed');
    expect(classifyFormPage('<p>Ya tienes 2 reserva/s para este dia</p>').kind).toBe('daily_limit');
    expect(classifyFormPage('<p>El tiempo de reserva <b>mínimo</b> es de 60 minutos</p>').kind).toBe('too_short');
  });

  it('window_closed carries the server clock only when it is a real instant', () => {
    const closed = (clock: string) => classifyFormPage(`<div>No se puede reservar a 8 o más dias vista. ${clock}</div>`);
    const good = closed('Hora actual comprobación:12/10/2026 22:33:54');
    expect(good.kind === 'window_closed' && good.serverCheckTime?.toISO()).toBe('2026-10-12T22:33:54.000+02:00');
    const spaced = closed('HORA ACTUAL COMPROBACION:   13/10/2026   07:00:00');
    expect(spaced.kind === 'window_closed' && spaced.serverCheckTime?.toISO()).toBe('2026-10-13T07:00:00.000+02:00');
    for (const clock of ['', 'Hora actual comprobación:31/02/2026 10:00:00', 'Hora actual comprobación:12/13/2026 10:00:00', 'Hora actual comprobación:12/10/2026 25:00:00', 'Hora actual comprobación:12/10/2026 10:61:00', 'Hora actual comprobación:2026-10-12 10:00:00']) {
      const gate = closed(clock);
      expect(gate.kind, clock).toBe('window_closed');
      expect(gate.kind === 'window_closed' && gate.serverCheckTime, clock).toBeNull();
    }
  });

  it('parseServerCheckTime is Madrid time, including summer vs winter offset', () => {
    expect(parseServerCheckTime('Hora actual comprobación:13/10/2026 07:00:00')?.toUTC().toISO()).toBe('2026-10-13T05:00:00.000Z');
    expect(parseServerCheckTime('Hora actual comprobación:25/10/2026 07:00:00')?.toUTC().toISO()).toBe('2026-10-25T06:00:00.000Z');
    expect(parseServerCheckTime('Hora actual comprobación:15/01/2027 07:00:00')?.toUTC().toISO()).toBe('2027-01-15T06:00:00.000Z');
    expect(parseServerCheckTime('')).toBeNull();
  });

  it('CHARACTERISATION (decision needed): closed-window text AND a form with a hash => currently `open`', () => {
    // PLAN §2: "Есть форма => бронь разрешена". If the owner prefers the opposite precedence this test must flip.
    const html = `<div class="msg">No se puede reservar a 8 o más dias vista</div>${form(`<input name="hash" value="${FAKE_HASH}">`)}`;
    expect(classifyFormPage(html)).toEqual({ kind: 'open', hash: FAKE_HASH });
  });

  it('a form marker without a hash, or a closed message without a marker, never becomes open', () => {
    expect(classifyFormPage('<form id="event-form">No se puede reservar a 8 o más dias vista</form>').kind).toBe('unknown');
    expect(classifyFormPage('No se puede reservar a 8 o más dias vista').kind).toBe('window_closed');
  });
});

describe('QA classifiers: huge but benign inputs (1 MB) stay fast and fail safe', () => {
  const timed = <T>(fn: () => T): { value: T; ms: number } => {
    const started = performance.now();
    const value = fn();
    return { value, ms: performance.now() - started };
  };

  it('POST classifier on 1 MB bodies of various shapes', () => {
    const bodies = [
      'x'.repeat(1_000_000),
      ' '.repeat(1_000_000),
      '{'.repeat(1_000_000),
      '['.repeat(1_000_000),
      `{"status":"error","data":{"msg":"${'x'.repeat(1_000_000)}"}}`,
      `{"status":"error","data":{"msg":"${' '.repeat(1_000_000)}dias vista"}}`,
      `{"status":"error","data":{"msg":"${'<b>x</b>'.repeat(125_000)}"}}`,
      `{"status":"ok","data":{"redirect":{"url":"${'a'.repeat(1_000_000)}cal_event.php?id=7"}}}`,
      `${'['.repeat(10_000)}${']'.repeat(10_000)}`,
    ];
    for (const body of bodies) {
      const { value, ms } = timed(() => classifyAddEventResponse(post(200, body)));
      expect(POST_KINDS).toContain(value.kind);
      expect(ms, `${body.slice(0, 30)}... took ${Math.round(ms)} ms`).toBeLessThan(1500);
    }
  });

  it('form classifier on 1 MB pages of various benign shapes', () => {
    const pages = [
      'x'.repeat(1_000_000),
      ' '.repeat(1_000_000),
      `${' '.repeat(1_000_000)}dias vista`,
      '<b>x</b>'.repeat(125_000),
      '<div class="a">text</div>\n'.repeat(40_000),
      `${'<p>filler</p>'.repeat(70_000)}<form id="event-form"><input name="hash" value="${FAKE_HASH}"></form>`,
      `${'<p>filler</p>'.repeat(70_000)}No se puede reservar a 8 o más dias vista`,
      '>'.repeat(1_000_000),
      'name="'.repeat(100_000),
    ];
    for (const page of pages) {
      const { value, ms } = timed(() => classifyFormPage(page));
      expect(FORM_KINDS).toContain(value.kind);
      expect(ms, `${page.slice(0, 30)}... took ${Math.round(ms)} ms`).toBeLessThan(1500);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Seeded randomized (property-style) fuzzing
// ---------------------------------------------------------------------------------------------

const FRAGMENTS = [
  'dias vista', 'No se puede reservar a 8 o más dias vista', 'Ya tienes 1 reserva/s para este dia', 'El tiempo de reserva mínimo',
  'cal_event.php?id=', '100002', '0', '-5', '12abc', '9'.repeat(25), 'ok', 'error', 'status', 'data', 'msg', 'redirect', 'url',
  '<b>', '</b>', '<', '>', '<br/>', '<script>', '"', "'", '{', '}', '[', ']', '\\', '\n', '\t', ' ', '  ', 'á', 'é', 'ñ', 'Í', '́', ' ',
  '&amp;', '&nbsp;', '&aacute;', 'Hora actual comprobación:', '12/10/2026 22:33:54', 'id="event-form"', 'name="hash"', 'value="', FAKE_HASH,
  'name="username"', 'name="password"', 'login', '/login', '\u0000', '😀', '__proto__', 'constructor', ECHO_MARKER,
];
const JSON_KEYS = ['status', 'data', 'msg', 'message', 'error_msg', 'redirect', 'url', 'wait', 'title', '__proto__', 'constructor', 'prototype', 'id', 'toString'];

const randomText = (rng: Rng, maxParts: number): string => {
  const parts = rng.int(0, maxParts);
  let out = '';
  for (let i = 0; i < parts; i += 1) out += rng.pick(FRAGMENTS);
  return out;
};

const randomJsonValue = (rng: Rng, depth: number): unknown => {
  const roll = rng.int(0, depth <= 0 ? 4 : 7);
  switch (roll) {
    case 0: return null;
    case 1: return rng.bool();
    case 2: return rng.pick([0, 1, -1, 5, 100002, 1.5, 1e21, Number.MAX_SAFE_INTEGER]);
    case 3: return randomText(rng, 4);
    case 4: return rng.pick(['ok', 'error', 'OK', '']);
    case 5: return Array.from({ length: rng.int(0, 3) }, () => randomJsonValue(rng, depth - 1));
    default: {
      const target: Record<string, unknown> = {};
      for (let i = 0; i < rng.int(0, 5); i += 1) {
        Object.defineProperty(target, rng.pick(JSON_KEYS), {
          value: randomJsonValue(rng, depth - 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return target;
    }
  }
};

const randomPostResponse = (rng: Rng): HttpResponseSummary => {
  const statuses = [200, 200, 200, 201, 204, 301, 302, 400, 401, 403, 404, 419, 422, 429, 500, 502, 503, 504, 599, 0, -1, 99, 1000];
  const status = rng.pick(statuses);
  const bodyKind = rng.int(0, 5);
  let body: string;
  if (bodyKind === 0) body = randomText(rng, 12);
  else if (bodyKind === 1) body = JSON.stringify(randomJsonValue(rng, 3));
  else if (bodyKind === 2) body = JSON.stringify({ status: rng.pick(['ok', 'error']), data: { msg: randomText(rng, 6), redirect: { url: `${rng.pick(['cal_event.php?id=', 'x/cal_event.php?id=', 'cal_week.php?id='])}${rng.pick(['1', '100002', '0', 'abc', '-3', '12abc', ''])}` } } });
  else if (bodyKind === 3) body = JSON.stringify({ status: 'error', data: { msg: randomText(rng, 8) } });
  else if (bodyKind === 4) body = REAL_SUCCESS.slice(0, rng.int(0, REAL_SUCCESS.length));
  else body = `${rng.pick(['', ' ', '﻿', '<br />'])}${REAL_SUCCESS}`;
  const location = rng.pick<string | null | undefined>([undefined, null, '', '/login', '/home', 'https://x.test/login', randomText(rng, 3)]);
  return location === undefined ? { status, body } : { status, body, location };
};

describe('QA fuzz: classifyAddEventResponse never throws and keeps its hard invariants (seeded)', () => {
  it('30000 random responses', () => {
    const rng = makeRng(0xbadc0de);
    const seen = new Map<string, number>();
    for (let i = 0; i < 30_000; i += 1) {
      const response = randomPostResponse(rng);
      let outcome: ReturnType<typeof classifyAddEventResponse>;
      try {
        outcome = classifyAddEventResponse(response);
      } catch (error) {
        throw new Error(`classifier threw for ${JSON.stringify(response).slice(0, 300)}: ${String(error)}`);
      }
      seen.set(outcome.kind, (seen.get(outcome.kind) ?? 0) + 1);
      const context = JSON.stringify(response).slice(0, 300);
      expect(POST_KINDS, context).toContain(outcome.kind);
      expect(JSON.stringify(outcome), context).toBeTypeOf('string');
      expect(classifyAddEventResponse(response), `determinism ${context}`).toEqual(outcome);

      if (outcome.kind === 'ok') {
        expect(Number.isFinite(outcome.reservationId), context).toBe(true);
        const parsed = JSON.parse(response.body) as { status?: unknown; data?: { redirect?: { url?: unknown } } };
        expect(parsed.status, context).toBe('ok');
        expect(typeof parsed.data?.redirect?.url, context).toBe('string');
        expect(String(parsed.data?.redirect?.url), context).toMatch(/cal_event\.php\?id=\d+/);
      }
      if (response.status >= 500) expect(outcome, context).toEqual({ kind: 'server_error', status: response.status });
      if (response.status === 401 || response.status === 419) expect(outcome.kind, context).toBe('auth_expired');
      if (outcome.kind === 'unknown') {
        if (outcome.message !== null) {
          expect(outcome.message.length, context).toBeLessThanOrEqual(160);
          expect(outcome.message, context).not.toMatch(/<[^>]*>/);
        }
        expect(outcome.status, context).toBe(response.status);
      }
      if (outcome.kind === 'server_error') expect(JSON.stringify(outcome)).not.toContain(ECHO_MARKER);
    }
    // Make sure the fuzzer actually reached the interesting classes (otherwise the invariants above are vacuous).
    for (const kind of ['ok', 'not_open_yet', 'daily_limit', 'auth_expired', 'server_error', 'unknown']) {
      expect(seen.get(kind) ?? 0, `fuzzer never produced ${kind}: ${JSON.stringify([...seen])}`).toBeGreaterThan(0);
    }
  }, 120_000);
});

describe('QA fuzz: classifyFormPage / parseServerCheckTime never throw (seeded)', () => {
  const randomHtml = (rng: Rng): string => {
    const pieces: string[] = [];
    for (let i = 0; i < rng.int(0, 10); i += 1) {
      pieces.push(
        rng.pick([
          () => randomText(rng, 5),
          () => `<form id="event-form">${randomText(rng, 3)}</form>`,
          () => `<form id="event-form"><input name="hash" value="${rng.pick([FAKE_HASH, FAKE_HASH.slice(2), `${FAKE_HASH}f`, ''])}"></form>`,
          () => `<input value="${FAKE_HASH}" name="hash">`,
          () => '<input name="username"><input name="password">',
          () => `<div class="msg">${randomText(rng, 4)}</div>`,
          () => rng.pick(['No se puede reservar a 8 o más dias vista', 'Ya tienes 1 reserva/s para este dia', 'El tiempo de reserva mínimo']),
          () => `Hora actual comprobación:${rng.pick(['12/10/2026 22:33:54', '31/02/2026 10:00:00', '99/99/9999 99:99:99', ''])}`,
        ])(),
      );
    }
    return pieces.join(rng.pick(['', ' ', '\n']));
  };

  it('20000 random HTML snippets', () => {
    const rng = makeRng(0x5eed);
    const seen = new Map<string, number>();
    for (let i = 0; i < 20_000; i += 1) {
      const html = randomHtml(rng);
      const gate = classifyFormPage(html);
      seen.set(gate.kind, (seen.get(gate.kind) ?? 0) + 1);
      expect(FORM_KINDS, html).toContain(gate.kind);
      expect(classifyFormPage(html)).toEqual(gate);
      if (gate.kind === 'open') {
        expect(html).toContain('id="event-form"');
        expect(gate.hash).toMatch(/^[0-9a-f]{40}$/);
        expect(html.toLowerCase()).toContain(gate.hash);
      }
      if (gate.kind === 'window_closed') {
        expect(gate.serverCheckTime === null || gate.serverCheckTime.isValid).toBe(true);
      }
      const clock = parseServerCheckTime(html);
      expect(clock === null || clock.isValid).toBe(true);
    }
    for (const kind of FORM_KINDS) expect(seen.get(kind) ?? 0, `${kind} never produced`).toBeGreaterThan(0);
  }, 60_000);

  it('parseServerCheckTime / classifiers survive lone surrogates, NULs and control characters', () => {
    const rng = makeRng(31337);
    for (let i = 0; i < 5000; i += 1) {
      let text = '';
      for (let j = 0; j < rng.int(0, 40); j += 1) text += String.fromCharCode(rng.int(0, 0xffff));
      expect(() => classifyFormPage(text)).not.toThrow();
      expect(() => parseServerCheckTime(text)).not.toThrow();
      expect(() => classifyAddEventResponse({ status: 200, body: text })).not.toThrow();
      expect(() => classifyAddEventResponse({ status: 200, body: JSON.stringify({ status: 'error', data: { msg: text } }) })).not.toThrow();
    }
  });
});
