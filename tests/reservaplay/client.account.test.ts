import { describe, expect, it } from 'vitest';
import { parseGameDate } from '../../src/config/gameDate.js';
import { AccountUnknownError } from '../../src/reservaplay/client.js';
import { AuthExpiredError, UnexpectedResponseError } from '../../src/reservaplay/errors.js';
import { ACCOUNT_ID, BASE_URL, HASH } from '../fixtures/reservaplay/constants.js';
import { networkError } from '../fixtures/reservaplay/fakeFetch.js';
import { createFakeSite } from '../fixtures/reservaplay/fakeSite.js';
import {
  closedWindowHtml,
  dailyLimitHtml,
  guestInfoPayload,
  loginPageHtml,
  openFormHtml,
  paymentOptionsPayload,
  tooShortHtml,
  walletPageHtml,
} from '../fixtures/reservaplay/pages.js';
import { emptyResponse, htmlResponse, jsonResponse, redirectResponse, textResponse } from '../fixtures/reservaplay/responses.js';
import { failureOf, intercepting, lastCall, loggedIn, makeClient, slotRef } from './helpers.js';

describe('getAccountContext()', () => {
  it('returns the host account id and the hash of the open form, from the same URL as probeForm', async () => {
    const { site, client } = await loggedIn();
    expect(await client.getAccountContext(slotRef())).toEqual({ accountId: ACCOUNT_ID, hash: HASH });
    expect(lastCall(site)?.url).toBe(
      `${BASE_URL}/reserves/cal_event.php?data=2026-10-19%2000:00:00&hora=1080&hora_fin=1170&resource=9&date=26-10-12&diaheader19`,
    );
    expect(site.calls).toHaveLength(1);
  });

  it.each([
    ['window_closed', () => htmlResponse(closedWindowHtml())],
    ['daily_limit', () => htmlResponse(dailyLimitHtml())],
    ['too_short', () => htmlResponse(tooShortHtml())],
    ['unknown', () => htmlResponse('<p>nope</p>')],
  ])('throws UnexpectedResponseError naming only the gate kind (%s)', async (kind, respond) => {
    const { site, client } = await loggedIn();
    site.state.form = respond;
    const error = await failureOf(client.getAccountContext(slotRef()));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as Error).message).toBe(`The booking form is not open (${kind})`);
  });

  it('throws AuthExpiredError when the form request returns the login page', async () => {
    const { site, client } = await loggedIn();
    site.state.form = () => htmlResponse(loginPageHtml());
    await expect(client.getAccountContext(slotRef())).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('throws UnexpectedResponseError when an open form has no recognisable host', async () => {
    const { site, client } = await loggedIn();
    site.state.form = () => htmlResponse(openFormHtml().replace('msg-primary', 'msg-other').replace('Anfitrión', 'Anfitrion-x'));
    const error = await failureOf(client.getAccountContext(slotRef()));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as Error).message).not.toContain(HASH);
  });

  it('does not remember an account id from a failed attempt', async () => {
    const { site, client } = await loggedIn();
    site.state.form = () => htmlResponse(closedWindowHtml());
    await failureOf(client.getAccountContext(slotRef()));
    await expect(client.quote(slotRef(), 'wallet')).rejects.toBeInstanceOf(AccountUnknownError);
  });

  it('never puts the hash into an error', async () => {
    const { site, client } = await loggedIn();
    site.state.form = () => htmlResponse(openFormHtml().replace('socis-list', 'other-list'));
    const error = (await failureOf(client.getAccountContext(slotRef()))) as Error;
    expect(`${error.message}${error.stack ?? ''}`).not.toContain(HASH);
  });
});

describe('getWallet()', () => {
  it('requests the wallet page and returns the balance in integer cents', async () => {
    const { site, client } = await loggedIn();
    expect(await client.getWallet()).toEqual({ balanceCents: 1902 });
    expect(lastCall(site)).toMatchObject({ method: 'GET', url: `${BASE_URL}/view/reserves/compra-moneder` });
    expect(lastCall(site)?.headers['cookie']).toContain('laravel_session=');
  });

  it.each([
    [0, 0],
    [5, 5],
    [123456, 123456],
  ])('reads %i cents', async (cents, expected) => {
    const { site, client } = await loggedIn();
    site.state.wallet = () => walletPageHtml(cents);
    expect(await client.getWallet()).toEqual({ balanceCents: expected });
  });

  it('throws UnexpectedResponseError when the balance cannot be found, without echoing the page', async () => {
    const { site, client } = await loggedIn();
    site.state.wallet = () => '<html>BODY-MARKER</html>';
    const error = await failureOf(client.getWallet());
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as Error).message).not.toContain('BODY-MARKER');
  });

  it('throws AuthExpiredError for a login page and for an expired session', async () => {
    const { site, client } = await loggedIn();
    site.state.wallet = () => loginPageHtml();
    await expect(client.getWallet()).rejects.toBeInstanceOf(AuthExpiredError);
    site.state.wallet = () => walletPageHtml(100);
    site.expireSession();
    await expect(client.getWallet()).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('throws UnexpectedResponseError on a server error', async () => {
    const client = makeClient({ fetchImpl: (() => Promise.resolve(htmlResponse('x', { status: 500 }))) as unknown as typeof fetch });
    await expect(client.getWallet()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});

describe('quote()', () => {
  const PAYMENT_URL =
    `${BASE_URL}/view/reserves/load_content/pago_anticipado_select/socio/${ACCOUNT_ID}/recurso/9` +
    '/fecha/2026-10-19%2000:00:00/fecha_ini/2026-10-19%2018:00/duracion/90/id_mst_socios_responsable/0' +
    `/participantes/${ACCOUNT_ID},3,3,3/id_reg_reserva/0?no_radio=0`;
  const GUEST_URL =
    `${BASE_URL}/api/reserves/socios/3,3,3/prepago_show_info/recurso/9/fecha/2026-10-19%2000:00:00` +
    `/fecha_ini/2026-10-19%2018:00/duracion/90/id_mst_socios_responsable/${ACCOUNT_ID}/socios/${ACCOUNT_ID},3,3,3`;

  const ready = async () => {
    const context = await loggedIn();
    await context.client.getAccountContext(slotRef());
    context.site.calls.length = 0;
    return context;
  };

  it('needs the account id first and sends nothing without it', async () => {
    const { site, client } = await loggedIn();
    await expect(client.quote(slotRef(), 'wallet')).rejects.toBeInstanceOf(AccountUnknownError);
    expect(site.calls).toHaveLength(0);
  });

  it('requests the payment options and the guest prices with the exact URLs', async () => {
    const { site, client } = await ready();
    await client.quote(slotRef(), 'wallet');
    expect(site.calls.map((call) => call.url)).toEqual([PAYMENT_URL, GUEST_URL]);
    for (const call of site.calls) {
      expect(call.method).toBe('GET');
      expect(call.headers['x-requested-with']).toBe('XMLHttpRequest');
      expect(call.headers['accept']).toContain('application/json');
      expect(call.headers['cookie']).toContain('laravel_session=');
    }
  });

  it('adds the host price and three guest prices into the total, in integer cents', async () => {
    const { client } = await ready();
    expect(await client.quote(slotRef(), 'wallet')).toEqual({ totalCents: 1902, walletPayable: true });
  });

  it('reports a disabled wallet option as not payable but still prices the booking', async () => {
    const { site, client } = await ready();
    site.state.paymentOptions = () => paymentOptionsPayload({ walletPayable: false });
    expect(await client.quote(slotRef(), 'wallet')).toEqual({ totalCents: 1902, walletPayable: false });
  });

  it('follows the slot: court, date, start and duration go into both URLs', async () => {
    const { site, client } = await ready();
    await client.quote(slotRef({ courtId: 4, gameDate: parseGameDate('2026-11-03'), startMinutes: 570, durationMinutes: 60 }), 'wallet');
    expect(site.calls[0]?.url).toContain('/recurso/4/fecha/2026-11-03%2000:00:00/fecha_ini/2026-11-03%2009:30/duracion/60/');
    expect(site.calls[1]?.url).toContain('/recurso/4/fecha/2026-11-03%2000:00:00/fecha_ini/2026-11-03%2009:30/duracion/60/');
  });

  it('uses different guest prices when the site shows them', async () => {
    const { site, client } = await ready();
    site.state.guestInfo = () => jsonResponse(guestInfoPayload(['5.34', '4.00', '6,10']));
    expect(await client.quote(slotRef(), 'wallet')).toMatchObject({ totalCents: 300 + 534 + 400 + 610 });
  });

  it('accepts guest prices delivered as an HTML page', async () => {
    const { site, client } = await ready();
    site.state.guestInfo = () => htmlResponse('<li>Invitado Invitado - 5.34€</li>'.repeat(3));
    expect((await client.quote(slotRef(), 'wallet')).totalCents).toBe(1902);
  });

  it.each([
    ['a server error', () => htmlResponse('x', { status: 500 })],
    ['a not-found page', () => emptyResponse(404)],
    ['a body without prices', () => jsonResponse({ error: false, view: '<p>nada</p>' })],
    ['only two prices', () => jsonResponse(guestInfoPayload(['5.34', '5.34']))],
    ['four prices', () => jsonResponse(guestInfoPayload(['5.34', '5.34', '5.34', '5.34']))],
    ['a garbled price', () => jsonResponse(guestInfoPayload(['5.34', '5.3.4', '5.34']))],
    ['text that is not JSON or HTML', () => textResponse('???')],
    ['an unexpected redirect', () => redirectResponse('/elsewhere')],
  ])('still answers, with an unknown total, when the guest prices come back as %s', async (_name, respond) => {
    const { site, client } = await ready();
    site.state.guestInfo = respond;
    expect(await client.quote(slotRef(), 'wallet')).toEqual({ totalCents: null, walletPayable: true });
  });

  it('still answers, with an unknown total, when the guest price request fails at the network level', async () => {
    const site = createFakeSite();
    const flaky = intercepting(site, (url) => {
      if (url.includes('prepago_show_info')) throw networkError('ECONNRESET');
      return undefined;
    });
    const { client } = await loggedIn(site, { fetchImpl: flaky });
    await client.getAccountContext(slotRef());
    expect(await client.quote(slotRef(), 'wallet')).toEqual({ totalCents: null, walletPayable: true });
  });

  it('does not ask for guest prices when the host price is unknown', async () => {
    const { site, client } = await ready();
    site.state.paymentOptions = () => paymentOptionsPayload({ hostPriceCents: null });
    expect(await client.quote(slotRef(), 'wallet')).toEqual({ totalCents: null, walletPayable: true });
    expect(site.calls).toHaveLength(1);
  });

  it('propagates an expired session from the guest price request', async () => {
    const { site, client } = await ready();
    site.state.guestInfo = () => emptyResponse(419);
    await expect(client.quote(slotRef(), 'wallet')).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('throws AuthExpiredError for an expired session on the payment options request', async () => {
    const { site, client } = await ready();
    site.expireSession();
    await expect(client.quote(slotRef(), 'wallet')).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it.each([
    ['an error answer', () => paymentOptionsPayload({ error: true })],
    ['an answer without payment radios', () => ({ error: false, view: '<p>Precio reserva: 3.00 €</p>' })],
    ['a JSON array', () => []],
  ])('throws UnexpectedResponseError on %s', async (_name, payload) => {
    const { site, client } = await ready();
    site.state.paymentOptions = payload;
    await expect(client.quote(slotRef(), 'wallet')).rejects.toBeInstanceOf(UnexpectedResponseError);
    expect(site.calls).toHaveLength(1);
  });

  it('throws UnexpectedResponseError when the payment options are not JSON, and AuthExpiredError for a login page', async () => {
    const answer = { current: () => htmlResponse('<html>BODY-MARKER</html>') };
    const site = createFakeSite();
    const { client } = await loggedIn(site, {
      fetchImpl: intercepting(site, (url) => (url.includes('pago_anticipado_select') ? answer.current() : undefined)),
    });
    await client.getAccountContext(slotRef());

    const error = await failureOf(client.quote(slotRef(), 'wallet'));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as Error).message).not.toContain('BODY-MARKER');

    answer.current = () => htmlResponse(loginPageHtml());
    await expect(client.quote(slotRef(), 'wallet')).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('refuses an impossible slot before sending anything', async () => {
    const { site, client } = await ready();
    await expect(client.quote(slotRef({ courtId: -1 }), 'wallet')).rejects.toThrow();
    expect(site.calls).toHaveLength(0);
  });
});
