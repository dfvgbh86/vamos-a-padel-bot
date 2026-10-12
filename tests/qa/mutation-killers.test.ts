/**
 * Tests added after a manual mutation run (scratch copy, ~40 hand-made mutants). Each test names the
 * surviving mutant it was written to kill. They all PASS against the current code.
 */
import { Settings } from 'luxon';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidGameDateError, parseGameDate } from '../../src/config/gameDate.js';
import { classifyAddEventResponse, classifyFormPage } from '../../src/reservaplay/classify.js';
import { FAKE_HASH } from './_helpers.js';

const saved = { locale: Settings.defaultLocale, numbering: Settings.defaultNumberingSystem };
afterEach(() => {
  Settings.defaultLocale = saved.locale;
  Settings.defaultNumberingSystem = saved.numbering;
});

const errBody = (msg: string): string => JSON.stringify({ status: 'error', data: { msg } });

describe('mutant M13 (classify.ts: `status < 400` -> `<= 400`, HTTP 400 treated as a redirect)', () => {
  it('HTTP 400 is classified by its JSON message and its Location header is ignored', () => {
    expect(classifyAddEventResponse({ status: 400, body: errBody('No se puede reservar a 8 o más dias vista') }).kind).toBe('not_open_yet');
    expect(classifyAddEventResponse({ status: 422, body: errBody('Ya tienes 1 reserva/s para este dia') }).kind).toBe('daily_limit');
    expect(classifyAddEventResponse({ status: 400, body: '', location: '/login' })).toEqual({ kind: 'unknown', status: 400, message: null });
  });

  it('HTTP 399 is still a redirect: /login means auth_expired, anything else unknown', () => {
    expect(classifyAddEventResponse({ status: 399, body: '', location: '/login' })).toEqual({ kind: 'auth_expired' });
    expect(classifyAddEventResponse({ status: 399, body: errBody('dias vista') })).toEqual({ kind: 'unknown', status: 399, message: null });
  });
});

describe('mutant M39 (classify.ts form gate: `ya tienes && reserva` -> `ya tienes`)', () => {
  it('"Ya tienes" without "reserva", or "reserva" without "Ya tienes", is not daily_limit on a form page', () => {
    expect(classifyFormPage('<div class="msg">Ya tienes saldo suficiente</div>').kind).toBe('unknown');
    expect(classifyFormPage('<div class="msg">Su reserva ha sido publicada</div>').kind).toBe('unknown');
    expect(classifyFormPage('<div class="msg">Ya tienes 1 reserva/s para este dia</div>').kind).toBe('daily_limit');
  });
});

describe('mutant M29 (classify.ts: form marker `id="event-form"` loosened to the substring `event-form`)', () => {
  it('the substring in a class name, an anchor or a look-alike id does not open the gate', () => {
    const hashInput = `<input name="hash" value="${FAKE_HASH}">`;
    expect(classifyFormPage(`<div class="event-form-wrapper">${hashInput}</div>`).kind).toBe('unknown');
    expect(classifyFormPage(`<a href="#event-form">top</a>${hashInput}`).kind).toBe('unknown');
    // a single-quoted id is the same valid HTML attribute: it opens the gate; only look-alikes must not
    expect(classifyFormPage(`<form id='event-form'>${hashInput}</form>`)).toEqual({ kind: 'open', hash: FAKE_HASH });
    expect(classifyFormPage(`<form id="event-form-2">${hashInput}</form>`).kind).toBe('unknown');
    expect(classifyFormPage(`<form id="event-form">${hashInput}</form>`)).toEqual({ kind: 'open', hash: FAKE_HASH });
  });
});

describe('mutant M32 (classify.ts: 3xx Location `/login` loosened to `login`)', () => {
  it('a redirect whose Location merely contains the letters "login" without a "/login" path is not auth_expired', () => {
    for (const location of ['https://club.example/sso?return=login', '/relogin', '/home?next=blogin', 'login']) {
      expect(classifyAddEventResponse({ status: 302, body: '', location }), location).toEqual({ kind: 'unknown', status: 302, message: null });
    }
    for (const location of ['/login', '/login?next=%2F', 'https://club.example/login']) {
      expect(classifyAddEventResponse({ status: 302, body: '', location }), location).toEqual({ kind: 'auth_expired' });
    }
  });
});

describe('mutant M28 (gameDate.ts: STRICT_PATTERN anchors removed) - EQUIVALENT today, luxon alone rejects all of these', () => {
  it('regression guard: non-ASCII digits and padded/overlong dates are never accepted, even with another numbering system', () => {
    Settings.defaultLocale = 'ar-EG';
    Settings.defaultNumberingSystem = 'arab';
    for (const input of ['٢٠٢٦-١٠-٢٠', '۲۰۲۶-۱۰-۲۰', '2026-10-20 ', ' 2026-10-20', '2026-10-20\n', '12026-10-20']) {
      expect(() => parseGameDate(input), input).toThrow(InvalidGameDateError);
    }
  });
});

describe('mutant M47 (classify.ts stripTags: a removed tag leaves no space behind)', () => {
  it('words separated only by a tag are still separate words', () => {
    expect(classifyAddEventResponse({ status: 200, body: errBody('No se puede reservar a 8 o más dias<br/>vista') }).kind).toBe('not_open_yet');
    expect(classifyFormPage('<div>No se puede reservar a 8 o más dias<br>vista</div>').kind).toBe('window_closed');
    expect(classifyFormPage('<p>Ya tienes<b>1</b>reserva/s para este dia</p>').kind).toBe('daily_limit');
  });
});
