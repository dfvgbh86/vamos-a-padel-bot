import { describe, expect, it } from 'vitest';
import { parseGameDate } from '../../src/config/gameDate.js';
import { MAX_HTML_LENGTH } from '../../src/reservaplay/parsers/html.js';
import {
  parseCalendar,
  parseCsrfToken,
  parseGuestPrices,
  parseHostAccountId,
  parsePaymentOptions,
  parseWalletCents,
} from '../../src/reservaplay/parsers/index.js';
import { courtJson } from '../fixtures/reservaplay/calendar.js';

/**
 * Every parser runs on the single-threaded bot just before the booking window opens: a page crafted (or merely broken)
 * to be as slow as possible must not stall it. Inputs sit just under the 2 MB cap, so the cap does not hide a slow path.
 * Quadratic code needs minutes here; the limit only has to tell "linear" from "not linear".
 */
const LIMIT_MS = 3_000;
const SIZE = MAX_HTML_LENGTH - 1_000;
const TEST_TIMEOUT_MS = 30_000;

const repeatTo = (unit: string, size = SIZE): string => unit.repeat(Math.floor(size / unit.length));

const elapsedMs = (run: () => void): number => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

const slowestOf = (inputs: readonly string[], run: (input: string) => unknown): number =>
  Math.max(...inputs.map((input) => elapsedMs(() => run(input))));

describe('parseHostAccountId on hostile pages', () => {
  const list = '<ul class="participants" id="socis-list">';

  it('stays linear for a list of a quarter of a million items', () => {
    const inputs = [`${list}${repeatTo('<li>x')}`, `${list}${repeatTo('<li>x</li>')}`, `${list}${repeatTo('<li class="a" id="1">')}`];
    expect(slowestOf(inputs, parseHostAccountId)).toBeLessThan(LIMIT_MS);
    for (const input of inputs) expect(parseHostAccountId(input)).toBeNull();
  }, TEST_TIMEOUT_MS);

  it('stays linear for a huge unterminated tag, a huge item and a huge number of lists', () => {
    const inputs = [
      `${list}<li ${repeatTo('a', SIZE - 100)}`,
      `${list}<li class="msg" id="5">${repeatTo('x', SIZE - 100)}`,
      `${repeatTo('<ul>')}${list}<li class="msg-primary" id="7">x</li></ul>`,
      repeatTo('<ul id="socis-list">'),
    ];
    expect(slowestOf(inputs, parseHostAccountId)).toBeLessThan(LIMIT_MS);
  }, TEST_TIMEOUT_MS);

  it('still finds a host among the first items of a very long list, and ignores one far beyond them', () => {
    const filler = repeatTo('<li class="msg" id="3">Invitado</li>', SIZE - 1_000);
    expect(parseHostAccountId(`${list}<li class="msg-primary" id="12345">x</li>${filler}`)).toBe(12345);
    expect(parseHostAccountId(`${list}${filler}<li class="msg-primary" id="12345">x</li>`)).toBeNull();
  });

  it('examines the first twenty items and no more', () => {
    const items = (count: number): string => Array.from({ length: count }, () => '<li class="msg" id="3">Invitado</li>').join('');
    expect(parseHostAccountId(`${list}${items(19)}<li class="msg-primary" id="55">x</li>`)).toBe(55);
    expect(parseHostAccountId(`${list}${items(20)}<li class="msg-primary" id="55">x</li>`)).toBeNull();
  });
});

describe('parseCsrfToken on hostile pages', () => {
  it('stays linear', () => {
    const inputs = [
      repeatTo('<input name="_token" value="bad">'),
      repeatTo('<input '),
      repeatTo('<meta name="csrf_token" content="x">'),
      `<input name=_token value=${repeatTo('a', SIZE - 100)}`,
      `<input ${repeatTo('a=b ', SIZE - 100)}>`,
      `<input ${repeatTo('a = = ', SIZE - 100)}>`,
      `<input name="_token" value="${repeatTo('a', SIZE - 100)}">`,
    ];
    expect(slowestOf(inputs, parseCsrfToken)).toBeLessThan(LIMIT_MS);
    for (const input of inputs) expect(parseCsrfToken(input)).toBeNull();
  }, TEST_TIMEOUT_MS);
});

describe('parsePaymentOptions on hostile payloads', () => {
  const viewOf = (view: string): { error: boolean; view: string } => ({ error: false, view });
  const radio = '<input type="radio" name="tipo_pago_anticipado_socio" value="2">';

  it('stays linear', () => {
    const views = [
      repeatTo(radio),
      `${radio}${repeatTo('Precio reserva: ')}`,
      `${radio}Precio reserva${repeatTo(' ', SIZE - 100)}x`,
      `${radio}Precio reserva: 1${repeatTo('.', SIZE - 100)}`,
      `${radio}${repeatTo('<p>Precio reserva:')}`,
      `${radio}<!--${repeatTo('x', SIZE - 100)}`,
    ];
    expect(slowestOf(views, (view) => parsePaymentOptions(viewOf(view)))).toBeLessThan(LIMIT_MS);
  }, TEST_TIMEOUT_MS);

  it('answers sensibly for the hostile inputs it does understand', () => {
    expect(parsePaymentOptions(viewOf(repeatTo(radio)))).toEqual({ walletPayable: false, hostPriceCents: null });
    expect(parsePaymentOptions(viewOf(repeatTo('x')))).toBeNull();
  });
});

describe('parseGuestPrices on hostile bodies', () => {
  it('stays linear', () => {
    const bodies = [
      repeatTo('Invitado Invitado - 5.34€ '),
      repeatTo('Invitado '),
      repeatTo('invitado   '),
      `Invitado Invitado - 1${repeatTo('.', SIZE - 100)}`,
      JSON.stringify(Array.from({ length: Math.floor(SIZE / 40) }, () => 'Invitado Invitado - 5.34€')),
      JSON.stringify([repeatTo('Invitado Invitado - 5.34€ ', SIZE - 100)]),
      repeatTo('['),
      `${repeatTo('[', SIZE / 2)}"Invitado Invitado - 5.34€"${repeatTo(']', SIZE / 2 - 100)}`,
      repeatTo('{"a":'),
      `{"view": "${repeatTo('<li>', SIZE - 100)}`,
    ];
    expect(slowestOf(bodies, parseGuestPrices)).toBeLessThan(LIMIT_MS);
  }, TEST_TIMEOUT_MS);
});

describe('parseWalletCents on hostile pages', () => {
  it('stays linear', () => {
    const pages = [
      repeatTo('Actualmente dispones de '),
      `Actualmente dispones de ${repeatTo('1.', SIZE - 100)}`,
      `Actualmente dispones de${repeatTo(' ', SIZE - 100)}x`,
      repeatTo('Actualmente dispones de 5 € '),
      repeatTo('<'),
      repeatTo('<!--'),
      repeatTo('<script>'),
    ];
    expect(slowestOf(pages, parseWalletCents)).toBeLessThan(LIMIT_MS);
  }, TEST_TIMEOUT_MS);
});

describe('parseCalendar on hostile payloads', () => {
  const gameDate = parseGameDate('2026-10-19');
  const slot = { hora_ini: 540, hora_fin: 630, duracion: 90, reserva: null };

  it('copes with the largest calendar it accepts', () => {
    const court = { ...courtJson({ id: 9, slots: [] }), horari: Array.from({ length: 1_000 }, () => slot) };
    const payload = [[Array.from({ length: 100 }, (_unused, index) => ({ ...court, id_mst_recurso: index + 1 }))]];
    let parsed = 0;
    expect(elapsedMs(() => (parsed = parseCalendar(payload, gameDate).courts.length))).toBeLessThan(LIMIT_MS);
    expect(parsed).toBe(100);
  }, TEST_TIMEOUT_MS);

  it('rejects very wide and very deep payloads quickly', () => {
    const wide = Array.from({ length: 1_000_000 }, () => []);
    const deep = Array.from({ length: 200_000 }).reduce<unknown>((inner) => [inner], []);
    const manyCourts = Array.from({ length: 200_000 }, () => ({ id_mst_recurso: 1 }));
    const manySlots = [[[{ ...courtJson({ id: 9, slots: [] }), horari: Array.from({ length: 1_000_000 }, () => slot) }]]];
    const elapsed = elapsedMs(() => {
      expect(parseCalendar(wide, gameDate).courts).toEqual([]);
      expect(() => parseCalendar(deep, gameDate)).toThrow();
      expect(() => parseCalendar(manyCourts, gameDate)).toThrow();
      expect(() => parseCalendar(manySlots, gameDate)).toThrow();
    });
    expect(elapsed).toBeLessThan(LIMIT_MS * 2);
  }, TEST_TIMEOUT_MS);
});
