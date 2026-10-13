import { describe, expect, it } from 'vitest';
import {
  parseCsrfToken,
  parseGuestPrices,
  parseHostAccountId,
  parsePaymentOptions,
} from '../../src/reservaplay/parsers/index.js';
import { ACCOUNT_ID, CSRF_TOKEN } from '../fixtures/reservaplay/constants.js';
import {
  closedWindowHtml,
  dailyLimitHtml,
  guestInfoPayload,
  loginPageHtml,
  openFormHtml,
  paymentOptionsPayload,
} from '../fixtures/reservaplay/pages.js';

describe('parseCsrfToken', () => {
  it('reads the hidden input, name before value', () => {
    expect(parseCsrfToken(loginPageHtml())).toBe(CSRF_TOKEN);
  });

  it('reads the hidden input, value before name', () => {
    expect(parseCsrfToken(loginPageHtml({ valueFirst: true }))).toBe(CSRF_TOKEN);
  });

  it('reads the csrf_token meta tag when there is no input', () => {
    expect(parseCsrfToken(loginPageHtml({ metaOnly: true }))).toBe(CSRF_TOKEN);
  });

  it('also accepts the common csrf-token spelling of the meta tag', () => {
    expect(parseCsrfToken(`<meta name="csrf-token" content="${CSRF_TOKEN}">`)).toBe(CSRF_TOKEN);
  });

  it.each([
    ['single quotes', `<input type='hidden' name='_token' value='${CSRF_TOKEN}'>`],
    ['upper-case tag and attribute names', `<INPUT TYPE="hidden" NAME="_token" VALUE="${CSRF_TOKEN}">`],
    ['unquoted attributes', `<input type=hidden name=_token value=${CSRF_TOKEN}>`],
    ['a self-closing tag', `<input type="hidden" name="_token" value="${CSRF_TOKEN}" />`],
    ['extra attributes and odd spacing', `<input\n  id="t"   name = "_token"\n class="x"  value = "${CSRF_TOKEN}"\n>`],
  ])('copes with %s', (_name, html) => {
    expect(parseCsrfToken(html)).toBe(CSRF_TOKEN);
  });

  it('prefers the form input over the meta tag', () => {
    const html = `<meta name="csrf_token" content="meta-token-0001"><input name="_token" value="${CSRF_TOKEN}">`;
    expect(parseCsrfToken(html)).toBe(CSRF_TOKEN);
  });

  it('skips an unusable `_token` input and takes the next valid one', () => {
    const html = `<input name="_token" value=""><input name="_token" value="has space in it"><input name="_token" value="${CSRF_TOKEN}">`;
    expect(parseCsrfToken(html)).toBe(CSRF_TOKEN);
  });

  it('ignores tokens inside comments, scripts and other inputs', () => {
    expect(parseCsrfToken(`<!-- <input name="_token" value="${CSRF_TOKEN}"> -->`)).toBeNull();
    expect(parseCsrfToken(`<script>document.write('<input name="_token" value="${CSRF_TOKEN}">')</script>`)).toBeNull();
    expect(parseCsrfToken(`<input name="other" value="${CSRF_TOKEN}">`)).toBeNull();
  });

  it.each([
    ['no token at all', '<form><input name="username"></form>'],
    ['an empty value', '<input name="_token" value="">'],
    ['a value without the attribute', '<input name="_token">'],
    ['a too short value', '<input name="_token" value="abc">'],
    ['markup characters in the value', '<input name="_token" value="a&quot;><script>1">'],
    ['an empty meta content', '<meta name="csrf_token" content="">'],
    ['an empty document', ''],
  ])('returns null for %s', (_name, html) => {
    expect(parseCsrfToken(html)).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseCsrfToken(undefined)).toBeNull();
    expect(parseCsrfToken({})).toBeNull();
  });
});

describe('parseHostAccountId', () => {
  it('reads the id of the host item of a rendered booking form', () => {
    expect(parseHostAccountId(openFormHtml())).toBe(ACCOUNT_ID);
    expect(parseHostAccountId(openFormHtml({ accountId: 987654 }))).toBe(987654);
  });

  const list = (items: string): string => `<ul class="participants" id="socis-list">${items}</ul>`;

  it('finds the host by the msg-primary class alone', () => {
    expect(parseHostAccountId(list('<li class="msg msg-info" id="3">Invitado</li><li class="msg msg-primary" id="77">Someone</li>'))).toBe(77);
  });

  it('finds the host by the (Anfitrión) marker alone, with or without the accent', () => {
    expect(parseHostAccountId(list('<li class="msg" id="78">Someone <strong>(Anfitrión)</strong></li>'))).toBe(78);
    expect(parseHostAccountId(list('<li class="msg" id="79">Someone <strong>(anfitrion)</strong></li>'))).toBe(79);
  });

  it('does not depend on attribute order or quoting', () => {
    expect(parseHostAccountId(list('<li id="80" class="msg-primary">x</li>'))).toBe(80);
    expect(parseHostAccountId(list("<li id='81' class='msg msg-primary'>x</li>"))).toBe(81);
  });

  it('never returns a guest: the guests carry the shared guest id', () => {
    expect(parseHostAccountId(list('<li class="msg msg-info" id="3">Invitado</li><li class="msg msg-info" id="3">Invitado</li>'))).toBeNull();
  });

  it('takes the first host item', () => {
    expect(parseHostAccountId(list('<li class="msg-primary" id="81">a</li><li class="msg-primary" id="82">b</li>'))).toBe(81);
  });

  it('does not let an unclosed item swallow the next one', () => {
    expect(parseHostAccountId(list('<li class="msg" id="3">Invitado<li class="msg msg-primary" id="83">Host (Anfitrión)'))).toBe(83);
    expect(parseHostAccountId(list('<li class="msg" id="3">Invitado<li class="msg" id="84">Host (Anfitrión)'))).toBe(84);
  });

  it.each(['0', '-5', 'abc', '12 3', '012345', '12.5', '', '1e3', '99999999999999999999'])('returns null for the invalid id %j', (id) => {
    expect(parseHostAccountId(list(`<li class="msg msg-primary" id="${id}">x</li>`))).toBeNull();
  });

  it('returns null when the host item has no id', () => {
    expect(parseHostAccountId(list('<li class="msg msg-primary">x</li>'))).toBeNull();
  });

  it('returns null when the list is missing or is not the participants list', () => {
    expect(parseHostAccountId('<ul id="other"><li class="msg-primary" id="5">x</li></ul>')).toBeNull();
    expect(parseHostAccountId('<li class="msg-primary" id="5">x</li>')).toBeNull();
    expect(parseHostAccountId(dailyLimitHtml())).toBeNull();
    expect(parseHostAccountId(closedWindowHtml())).toBeNull();
    expect(parseHostAccountId('')).toBeNull();
  });

  it('ignores a decoy host item outside the participants list or inside comments', () => {
    const html = `<li class="msg-primary" id="5">decoy</li><!-- ${list('<li class="msg-primary" id="6">c</li>')} -->`;
    expect(parseHostAccountId(html)).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseHostAccountId(null)).toBeNull();
    expect(parseHostAccountId(12345)).toBeNull();
  });
});

describe('parsePaymentOptions', () => {
  it('reads an enabled wallet radio and the host price', () => {
    expect(parsePaymentOptions(paymentOptionsPayload())).toEqual({ walletPayable: true, hostPriceCents: 300 });
  });

  it.each([
    ['disabled="disabled"', ' disabled="disabled"'],
    ['a bare disabled attribute', ' disabled'],
    ['an upper-case DISABLED', ' DISABLED'],
    ['an empty disabled value', ' disabled=""'],
  ])('flags the wallet as not payable with %s', (_name, attribute) => {
    const view = `<p>Precio reserva: 3.00 €</p><input type="radio" name="tipo_pago_anticipado_socio" value="2"><input type="radio" name="tipo_pago_anticipado_socio" value="5"${attribute}>`;
    expect(parsePaymentOptions({ error: false, view })).toEqual({ walletPayable: false, hostPriceCents: 300 });
  });

  it('reads the disabled radio fixture', () => {
    expect(parsePaymentOptions(paymentOptionsPayload({ walletPayable: false }))).toEqual({ walletPayable: false, hostPriceCents: 300 });
  });

  it('reads a comma decimal price and a price inside markup', () => {
    const view = '<p>Precio reserva: <b>3,50 €</b></p><input type="radio" name="tipo_pago_anticipado_socio" value="5">';
    expect(parsePaymentOptions({ error: 0, view })).toEqual({ walletPayable: true, hostPriceCents: 350 });
  });

  it('returns a null price when the site shows none', () => {
    expect(parsePaymentOptions(paymentOptionsPayload({ hostPriceCents: null }))).toEqual({ walletPayable: true, hostPriceCents: null });
  });

  it('returns a null price when the shown price is garbled', () => {
    const view = '<p>Precio reserva: 3.0.0 €</p><input type="radio" name="tipo_pago_anticipado_socio" value="5">';
    expect(parsePaymentOptions({ error: false, view })?.hostPriceCents).toBeNull();
  });

  it('treats a card-only form as wallet not payable', () => {
    const view = '<input type="radio" name="tipo_pago_anticipado_socio" value="2">';
    expect(parsePaymentOptions({ error: false, view })).toEqual({ walletPayable: false, hostPriceCents: null });
  });

  it('ignores radios of other groups, including a value 5 in another group', () => {
    const view = '<input type="radio" name="otra_cosa" value="5"><input type="radio" name="tipo_pago_anticipado_socio" value="2">';
    expect(parsePaymentOptions({ error: false, view })?.walletPayable).toBe(false);
  });

  it('ignores a value-5 input that is not a radio', () => {
    const view = '<input type="radio" name="tipo_pago_anticipado_socio" value="2"><input type="hidden" name="tipo_pago_anticipado_socio" value="5">';
    expect(parsePaymentOptions({ error: false, view })?.walletPayable).toBe(false);
  });

  it.each([
    ['an error flag', paymentOptionsPayload({ error: true })],
    ['a string error flag', { ...paymentOptionsPayload(), error: '1' }],
    ['no view', { error: false }],
    ['a non-string view', { error: false, view: ['<input>'] }],
    ['a view without payment radios', { error: false, view: '<p>Precio reserva: 3.00 €</p>' }],
    ['an array', []],
    ['null', null],
    ['a string', 'x'],
  ])('returns null for %s', (_name, payload) => {
    expect(parsePaymentOptions(payload)).toBeNull();
  });

  it('accepts the usual "no error" spellings', () => {
    for (const error of [false, 0, '0', '', 'false', null, undefined]) {
      expect(parsePaymentOptions({ ...paymentOptionsPayload(), error })).not.toBeNull();
    }
  });
});

describe('parseGuestPrices', () => {
  it('reads one price per guest from an HTML fragment', () => {
    const html = '<li>Invitado Invitado - 5.34€</li><li>Invitado Invitado - 5.34€</li><li>Invitado Invitado - 5.34€</li>';
    expect(parseGuestPrices(html)).toEqual([534, 534, 534]);
  });

  it('reads prices wherever a JSON document keeps its HTML', () => {
    expect(parseGuestPrices(JSON.stringify(guestInfoPayload()))).toEqual([534, 534, 534]);
    expect(parseGuestPrices(JSON.stringify({ a: { b: ['x', { view: '<p>Invitado Invitado - 6,10 €</p>' }] } }))).toEqual([610]);
  });

  it('handles different prices, comma decimals and spacing', () => {
    const html = 'Invitado  Invitado -  5,34 €  <br> invitado invitado - 4.00€ <br> Invitado Invitado-5.00 EUR';
    expect(parseGuestPrices(html)).toEqual([534, 400, 500]);
  });

  it('returns null when no price is present', () => {
    expect(parseGuestPrices('<p>nada</p>')).toBeNull();
    expect(parseGuestPrices('')).toBeNull();
    expect(parseGuestPrices('{}')).toBeNull();
    expect(parseGuestPrices('[]')).toBeNull();
    expect(parseGuestPrices('"just a string"')).toBeNull();
  });

  it('returns null when any price is garbled (a partial list would understate the total)', () => {
    expect(parseGuestPrices('Invitado Invitado - 5.34€ Invitado Invitado - 5.3.4€')).toBeNull();
    expect(parseGuestPrices('Invitado Invitado - 5.021€')).toBeNull();
  });

  it('returns null for non-string input and falls back to plain text for malformed JSON', () => {
    expect(parseGuestPrices(undefined)).toBeNull();
    expect(parseGuestPrices(42)).toBeNull();
    expect(parseGuestPrices('{"view": "Invitado Invitado - 5.34€"')).toEqual([534]);
  });

  it('does not recurse without bound into deeply nested JSON', () => {
    const deep = `${'['.repeat(5_000)}"Invitado Invitado - 5.34€"${']'.repeat(5_000)}`;
    expect(() => parseGuestPrices(deep)).not.toThrow();
  });
});
