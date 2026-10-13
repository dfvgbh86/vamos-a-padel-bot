import { describe, expect, it } from 'vitest';
import { BASE_URL, ACCOUNT_ID } from '../fixtures/reservaplay/constants.js';
import { bodyParams } from '../fixtures/reservaplay/fakeFetch.js';
import { AUTHED_SESSION, createFakeSite, type FakeSite } from '../fixtures/reservaplay/fakeSite.js';
import { bookingErrorPayload, cancelOkPayload, closedWindowHtml, openFormHtml } from '../fixtures/reservaplay/pages.js';
import { emptyResponse, htmlResponse, jsonResponse, redirectResponse, textResponse } from '../fixtures/reservaplay/responses.js';
import { captureLogger, makeClient, slotRef, switchableNetwork } from './helpers.js';

/** Logged in, with the account id known from an open booking form: the state in which cancel() works. */
const ready = async () => {
  const site = createFakeSite();
  const client = makeClient(site);
  await client.login();
  await client.getAccountContext(slotRef());
  site.calls.length = 0;
  return { site, client };
};

const respondWith = (site: FakeSite, response: () => Response): void => {
  site.state.manager = () => response();
};

describe('cancel()', () => {
  it('posts del_event for the reservation, asking for the refund into the wallet', async () => {
    const { site, client } = await ready();
    expect(await client.cancel(100002)).toEqual({ kind: 'cancelled' });

    expect(site.calls).toHaveLength(1);
    const call = site.calls[0];
    expect(call).toMatchObject({
      method: 'POST',
      url: `${BASE_URL}/sportssuite/manager.php`,
      body: 'id_reserva=100002&op=del_event&eliminarReservaPermiso=1&pasar_a_monedero=1&socis=12345%2C3%2C3%2C3',
      redirect: 'manual',
    });
    expect(call?.headers['content-type']).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    expect(call?.headers['x-requested-with']).toBe('XMLHttpRequest');
    expect(call?.headers['cookie']).toContain(`laravel_session=${AUTHED_SESSION}`);
  });

  it('always sends the participants of the captured request', async () => {
    const { site, client } = await ready();
    await client.cancel(100002);
    expect(bodyParams(site.calls[0]!).get('socis')).toBe(`${ACCOUNT_ID},3,3,3`);
  });

  describe('before the account id is known (fail closed)', () => {
    const loggedInOnly = async () => {
      const site = createFakeSite();
      const logger = captureLogger();
      const client = makeClient(site, { logger });
      await client.login();
      site.calls.length = 0;
      return { site, client, logger };
    };

    it('refuses without sending anything: the refund of a cancel without `socis` is unverified', async () => {
      const { site, client } = await loggedInOnly();
      expect(await client.cancel(100002)).toEqual({ kind: 'failed', reason: 'account id not known yet' });
      expect(site.calls).toHaveLength(0);
    });

    it('warns once, without the reservation id', async () => {
      const { client, logger } = await loggedInOnly();
      await client.cancel(100002);
      const warnings = logger.entries.filter((entry) => entry.level === 'warn');
      expect(warnings).toEqual([{ level: 'warn', fields: {}, message: 'refused to cancel before the account id was known' }]);
      expect(logger.dump()).not.toContain('100002');
    });

    it('still treats an impossible reservation id as a programming error', async () => {
      const { site, client } = await loggedInOnly();
      await expect(client.cancel(0)).rejects.toThrow(/reservation id/);
      await expect(client.cancel(Number.NaN)).rejects.toThrow(/reservation id/);
      expect(site.calls).toHaveLength(0);
    });

    it('stays refused after a failed attempt to learn the account id, and works once it is learnt', async () => {
      const { site, client } = await loggedInOnly();
      site.state.form = () => htmlResponse(closedWindowHtml());
      await expect(client.getAccountContext(slotRef())).rejects.toThrow();
      expect(await client.cancel(100002)).toEqual({ kind: 'failed', reason: 'account id not known yet' });

      site.state.form = () => htmlResponse(openFormHtml());
      await client.getAccountContext(slotRef());
      expect(await client.cancel(100002)).toEqual({ kind: 'cancelled' });
    });
  });

  it('sends exactly one request and never cancels anything else', async () => {
    const { site, client } = await ready();
    await client.cancel(5);
    await client.cancel(6);
    expect(site.calls.map((call) => bodyParams(call).get('id_reserva'))).toEqual(['5', '6']);
    expect(site.calls.every((call) => bodyParams(call).get('op') === 'del_event')).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])('refuses the reservation id %s before sending anything', async (id) => {
    const { site, client } = await ready();
    await expect(client.cancel(id)).rejects.toThrow(/reservation id/);
    expect(site.calls).toHaveLength(0);
  });

  describe('anything but the documented success is a failure with a short reason', () => {
    const reasonOf = async (response: () => Response): Promise<string> => {
      const { site, client } = await ready();
      respondWith(site, response);
      const result = await client.cancel(100002);
      expect(result.kind).toBe('failed');
      expect(site.calls).toHaveLength(1);
      return result.kind === 'failed' ? result.reason : '';
    };

    it('quotes the site\'s own error message, without markup', async () => {
      expect(await reasonOf(() => jsonResponse(bookingErrorPayload('<b>No se puede cancelar</b> con menos de 24 horas.')))).toBe(
        'No se puede cancelar con menos de 24 horas.',
      );
    });

    it('reads the message from any of the usual places', async () => {
      expect(await reasonOf(() => jsonResponse({ status: 'error', msg: 'plain msg' }))).toBe('plain msg');
      expect(await reasonOf(() => jsonResponse({ status: 'error', message: 'plain message' }))).toBe('plain message');
      expect(await reasonOf(() => jsonResponse({ status: 'error', error_msg: 'plain error_msg' }))).toBe('plain error_msg');
    });

    it('truncates a long message to 120 characters', async () => {
      const reason = await reasonOf(() => jsonResponse(bookingErrorPayload('x'.repeat(5_000))));
      expect(reason).toHaveLength(120);
    });

    it('truncates by code points, never in the middle of a character', async () => {
      const reason = await reasonOf(() => jsonResponse(bookingErrorPayload('\u{1F3BE}'.repeat(300))));
      expect(Array.from(reason)).toHaveLength(120);
      expect(reason).not.toContain('�');
    });

    it('does not accept status ok with a message that is not a cancellation', async () => {
      expect(await reasonOf(() => jsonResponse({ status: 'ok', data: { msg: 'Reserva actualizada' } }))).toBe('Reserva actualizada');
    });

    it('does not accept the cancellation text without status ok', async () => {
      await reasonOf(() => jsonResponse({ status: 'error', data: { msg: 'Su reserva ha sido cancelada.' } }));
    });

    it('does not accept a success payload on a non-2xx status', async () => {
      await reasonOf(() => jsonResponse(cancelOkPayload(), { status: 400 }));
    });

    it('does not accept status ok without any message', async () => {
      expect(await reasonOf(() => jsonResponse({ status: 'ok' }))).toBe('unrecognised response (HTTP 200)');
    });

    it.each([
      ['an HTML page', () => htmlResponse('<html>BODY-MARKER</html>'), 'unrecognised response (HTTP 200)'],
      ['plain text', () => textResponse('BODY-MARKER'), 'unrecognised response (HTTP 200)'],
      ['an empty answer', () => emptyResponse(200), 'unrecognised response (HTTP 200)'],
      ['a JSON array', () => jsonResponse([1, 2, 3]), 'unrecognised response (HTTP 200)'],
      ['a redirect elsewhere', () => redirectResponse('/elsewhere'), 'unrecognised response (HTTP 302)'],
    ])('returns a generic reason for %s and never echoes the body', async (_name, response, expected) => {
      const reason = await reasonOf(response);
      expect(reason).toBe(expected);
      expect(reason).not.toContain('BODY-MARKER');
    });

    it('reports a server error without exposing the page', async () => {
      const reason = await reasonOf(() => htmlResponse('Whoops DEBUG-PAGE-MARKER', { status: 500 }));
      expect(reason).toBe('the site answered with a server error (HTTP 500)');
    });

    it.each([
      ['HTTP 401', () => emptyResponse(401)],
      ['HTTP 419', () => emptyResponse(419)],
      ['a redirect to /login', () => redirectResponse('/login')],
    ])('reports an expired session for %s, without logging in again', async (_name, response) => {
      expect(await reasonOf(response)).toBe('the session expired');
    });

    it('reports an expired session on the real site', async () => {
      const { site, client } = await ready();
      site.expireSession();
      expect(await client.cancel(100002)).toEqual({ kind: 'failed', reason: 'the session expired' });
      expect(site.calls).toHaveLength(1);
    });
  });

  describe('network failures are reported, never thrown', () => {
    it('says the request was not sent when it provably did not leave the machine', async () => {
      const site = createFakeSite();
      const network = switchableNetwork(site);
      const client = makeClient(site, { fetchImpl: network.fetchImpl });
      await client.login();
      await client.getAccountContext(slotRef());
      network.arm('ECONNREFUSED');
      expect(await client.cancel(100002)).toEqual({ kind: 'failed', reason: 'the request was not sent' });
      expect(network.state.failedAttempts).toBe(1);
    });

    it('says the outcome is unknown when the request may have reached the site, and does not retry', async () => {
      const site = createFakeSite();
      const network = switchableNetwork(site);
      const client = makeClient(site, { fetchImpl: network.fetchImpl });
      await client.login();
      await client.getAccountContext(slotRef());
      network.arm('ECONNRESET');
      expect(await client.cancel(100002)).toEqual({
        kind: 'failed',
        reason: 'no usable answer, the cancellation may or may not have happened',
      });
      expect(network.state.failedAttempts).toBe(1);
    });
  });
});
