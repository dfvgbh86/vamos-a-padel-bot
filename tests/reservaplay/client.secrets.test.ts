import { describe, expect, it } from 'vitest';
import { ACCOUNT_ID, CSRF_TOKEN, HASH, PASSWORD, USERNAME } from '../fixtures/reservaplay/constants.js';
import { AUTHED_SESSION, GUEST_SESSION, createFakeSite } from '../fixtures/reservaplay/fakeSite.js';
import { bookingErrorPayload } from '../fixtures/reservaplay/pages.js';
import { emptyResponse, htmlResponse, jsonResponse } from '../fixtures/reservaplay/responses.js';
import { bookRequest, captureLogger, makeClient, slotRef, switchableNetwork } from './helpers.js';

/** Values that must never reach a log line or an error message. */
const SECRETS: readonly string[] = [PASSWORD, USERNAME, CSRF_TOKEN, HASH, GUEST_SESSION, AUTHED_SESSION, 'xsrf-01', 'alb-01', 'laravel_session', 'XSRF-TOKEN', 'AWSALB'];

/** What a failure shows to the outside; successful values are the caller's business (getAccountContext returns the hash by design). */
const attempt = async (promise: Promise<unknown>, inspectResult = false): Promise<string> => {
  try {
    const value = await promise;
    return inspectResult ? (JSON.stringify(value) ?? '') : '';
  } catch (error) {
    const failure = error as Error;
    return `${failure.name} ${failure.message} ${failure.stack ?? ''} ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
  }
};

describe('no secret ever reaches a log line or an error message', () => {
  it('survives a whole session: login, reads, quote, booking outcomes, cancel and failures', async () => {
    const site = createFakeSite();
    const network = switchableNetwork(site);
    const logger = captureLogger();
    const client = makeClient(site, { logger, fetchImpl: network.fetchImpl });
    const surfaced: string[] = [];

    surfaced.push(await attempt(client.login()));
    surfaced.push(await attempt(client.keepAlive()));
    surfaced.push(await attempt(client.getDay(slotRef().gameDate)));
    surfaced.push(await attempt(client.probeForm(slotRef())));
    surfaced.push(await attempt(client.getAccountContext(slotRef())));
    surfaced.push(await attempt(client.getWallet()));
    surfaced.push(await attempt(client.quote(slotRef(), 'wallet')));
    surfaced.push(await attempt(client.book(bookRequest()), true));

    site.state.manager = () => jsonResponse(bookingErrorPayload('Ya tienes 1 reserva/s para este dia.'));
    surfaced.push(await attempt(client.book(bookRequest()), true));
    site.state.manager = () => htmlResponse(`Whoops ${HASH} ${PASSWORD} ${AUTHED_SESSION}`, { status: 500 });
    surfaced.push(await attempt(client.book(bookRequest()), true));
    site.state.manager = () => emptyResponse(504);
    surfaced.push(await attempt(client.book(bookRequest()), true));
    surfaced.push(await attempt(client.cancel(100002), true));

    network.arm('ECONNRESET');
    surfaced.push(await attempt(client.book(bookRequest()), true));
    surfaced.push(await attempt(client.cancel(100002), true));
    surfaced.push(await attempt(client.getWallet()));
    network.disarm();

    site.expireSession();
    surfaced.push(await attempt(client.keepAlive()));
    surfaced.push(await attempt(client.book(bookRequest()), true));
    site.state.acceptCredentials = false;
    surfaced.push(await attempt(client.login()));

    expect(logger.entries.length).toBeGreaterThan(5);
    expect(surfaced.filter((text) => text !== '').length).toBeGreaterThan(8);
    const everything = `${logger.dump()}\n${surfaced.join('\n')}`;
    for (const secret of SECRETS) expect(everything, `leaked ${secret}`).not.toContain(secret);
    expect(everything).not.toContain(String(ACCOUNT_ID));
  });

  it('logs only short, structured, body-free fields', async () => {
    const site = createFakeSite();
    const logger = captureLogger();
    const client = makeClient(site, { logger });
    await client.login();
    await client.getAccountContext(slotRef());
    await client.book(bookRequest());
    await client.cancel(100002);

    const allowedKeys = new Set(['label', 'status', 'ms', 'outcome', 'reason', 'code', 'timeoutMs']);
    for (const entry of logger.entries) {
      expect(typeof entry.message).toBe('string');
      expect(entry.message.length).toBeLessThan(80);
      for (const key of Object.keys(entry.fields as object)) expect(allowedKeys.has(key), `unexpected log field ${key}`).toBe(true);
    }
  });

  it('keeps the password out of every request except the login post', async () => {
    const site = createFakeSite();
    const client = makeClient(site);
    await client.login();
    await client.keepAlive();
    await client.getDay(slotRef().gameDate);
    await client.probeForm(slotRef());
    await client.getAccountContext(slotRef());
    await client.getWallet();
    await client.quote(slotRef(), 'wallet');
    await client.book(bookRequest());
    await client.cancel(100002);

    const carrying = site.calls.filter((call) => `${call.url} ${JSON.stringify(call.headers)} ${call.body ?? ''}`.includes(PASSWORD));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toMatchObject({ method: 'POST' });
    expect(new URL(carrying[0]?.url ?? '').pathname).toBe('/login');
  });

  it('keeps the hash out of URLs and out of every request except the booking post', async () => {
    const site = createFakeSite();
    const client = makeClient(site);
    await client.login();
    await client.getAccountContext(slotRef());
    await client.getWallet();
    await client.quote(slotRef(), 'wallet');
    await client.book(bookRequest());
    await client.cancel(100002);

    const carrying = site.calls.filter((call) => `${call.url} ${JSON.stringify(call.headers)} ${call.body ?? ''}`.includes(HASH));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.body).toContain('op=add_event');
  });

  it('never puts credentials or secrets in a URL query', async () => {
    const site = createFakeSite();
    const client = makeClient(site);
    await client.login();
    await client.getAccountContext(slotRef());
    await client.quote(slotRef(), 'wallet');
    for (const call of site.calls) {
      const url = decodeURIComponent(call.url);
      for (const secret of [PASSWORD, HASH, CSRF_TOKEN, AUTHED_SESSION]) expect(url).not.toContain(secret);
    }
  });
});
