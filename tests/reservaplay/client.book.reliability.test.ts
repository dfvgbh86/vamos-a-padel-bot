import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BookResult } from '../../src/contracts.js';
import { DEFAULT_BOOK_TIMEOUT_MS, MIN_BOOK_TIMEOUT_MS } from '../../src/reservaplay/client.js';
import { hangUntilAborted } from '../fixtures/reservaplay/fakeFetch.js';
import { createFakeSite } from '../fixtures/reservaplay/fakeSite.js';
import { bookingErrorPayload, bookingOkPayload } from '../fixtures/reservaplay/pages.js';
import { emptyResponse, htmlResponse, jsonResponse } from '../fixtures/reservaplay/responses.js';
import { posts, ready, respondWith } from './bookHelpers.js';
import { bookRequest, intercepting, makeClient, slotRef, switchableNetwork } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('book(): transport failures', () => {
  const failingWith = async (code: string, syscall?: string | null) => {
    const site = createFakeSite();
    const network = switchableNetwork(site);
    const client = makeClient(site, { fetchImpl: network.fetchImpl });
    await client.login();
    site.calls.length = 0;
    network.arm(code, syscall);
    return { site, client, network };
  };

  it.each([
    ['connection refused', 'ECONNREFUSED'],
    ['DNS failure', 'ENOTFOUND'],
    ['temporary DNS failure', 'EAI_AGAIN'],
    ['connect timeout', 'UND_ERR_CONNECT_TIMEOUT'],
    ['network unreachable', 'ENETUNREACH'],
    ['host unreachable', 'EHOSTUNREACH'],
    ['no local address', 'EADDRNOTAVAIL'],
  ])('%s while connecting means not_sent: safe to retry', async (_name, code) => {
    const { client } = await failingWith(code);
    expect(await client.book(bookRequest())).toEqual({ kind: 'not_sent' });
  });

  it.each([
    ['EHOSTUNREACH', 'read'],
    ['ENETUNREACH', 'read'],
    ['ENETUNREACH', 'write'],
    ['EADDRNOTAVAIL', 'read'],
    ['EHOSTUNREACH', null],
  ])('%s raised by the %s syscall (the link dropped while the POST was in flight) means ambiguous, never not_sent', async (code, syscall) => {
    const { client, network } = await failingWith(code, syscall);
    expect(await client.book(bookRequest())).toEqual({ kind: 'ambiguous' });
    expect(network.state.failedAttempts).toBe(1);
  });

  it.each([
    ['connection reset', 'ECONNRESET'],
    ['socket closed', 'UND_ERR_SOCKET'],
    ['headers timeout', 'UND_ERR_HEADERS_TIMEOUT'],
    ['body timeout', 'UND_ERR_BODY_TIMEOUT'],
    ['OS timeout', 'ETIMEDOUT'],
    ['an unknown failure', 'ESOMETHINGNEW'],
  ])('%s means ambiguous: no retry before reconciliation', async (_name, code) => {
    const { client } = await failingWith(code);
    expect(await client.book(bookRequest())).toEqual({ kind: 'ambiguous' });
  });

  it('treats a failure while reading the answer as ambiguous', async () => {
    const site = createFakeSite();
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('reset'));
      },
    });
    const client = makeClient(site, { fetchImpl: intercepting(site, (url) => (url.endsWith('manager.php') ? new Response(broken, { status: 200 }) : undefined)) });
    await client.login();
    expect(await client.book(bookRequest())).toEqual({ kind: 'ambiguous' });
  });

  it('treats an answer that is far too large as ambiguous', async () => {
    const site = createFakeSite();
    const client = makeClient(site, { fetchImpl: intercepting(site, (url) => (url.endsWith('manager.php') ? htmlResponse('x'.repeat(4_000_001)) : undefined)) });
    await client.login();
    expect(await client.book(bookRequest())).toEqual({ kind: 'ambiguous' });
  });

  it('never retries inside the client, whatever happens', async () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET']) {
      const { client, network } = await failingWith(code);
      await client.book(bookRequest());
      expect(network.state.failedAttempts).toBe(1);
    }
    const { site, client } = await ready();
    for (const response of [() => emptyResponse(500), () => emptyResponse(502), () => emptyResponse(419), () => htmlResponse('x')]) {
      site.calls.length = 0;
      respondWith(site, response);
      await client.book(bookRequest());
      expect(posts(site)).toHaveLength(1);
    }
  });
});

describe('book(): timeout', () => {
  const hanging = async (overrides: Parameters<typeof makeClient>[1] = {}) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { site, client } = await ready(overrides);
    site.state.manager = (_call, signal) => hangUntilAborted(signal);
    const state: { result?: BookResult } = {};
    void client.book(bookRequest()).then((result) => {
      state.result = result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(posts(site)).toHaveLength(1);
    return { site, state };
  };

  it('is at least 20 seconds (default 25) and ends as ambiguous', async () => {
    expect(MIN_BOOK_TIMEOUT_MS).toBe(20_000);
    expect(DEFAULT_BOOK_TIMEOUT_MS).toBe(25_000);
    const { state } = await hanging();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(state.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(state.result).toEqual({ kind: 'ambiguous' });
  });

  it('can never be configured below 20 seconds', async () => {
    const { state } = await hanging({ bookTimeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(state.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.result).toEqual({ kind: 'ambiguous' });
  });

  it('can be configured above 20 seconds, independently of the ordinary request timeout', async () => {
    const { state } = await hanging({ bookTimeoutMs: 40_000, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(39_999);
    expect(state.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.result).toEqual({ kind: 'ambiguous' });
  });

  it('does not re-send after a timeout', async () => {
    const { site } = await hanging();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(posts(site)).toHaveLength(1);
  });

  it('keeps the ordinary 15 second timeout for other requests', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { site, client } = await ready();
    site.state.form = (_call, signal) => hangUntilAborted(signal);
    let failure: unknown;
    void client.probeForm(slotRef()).catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(failure).toMatchObject({ name: 'TransportError', reason: 'timeout' });
  });
});

describe('book(): a single add_event in flight', () => {
  const gated = async () => {
    const { site, client } = await ready();
    const gate: { release: (response: Response) => void } = { release: () => undefined };
    site.state.manager = () =>
      new Promise<Response>((resolve) => {
        gate.release = resolve;
      });
    return { site, client, gate };
  };

  it('rejects a second call immediately, without a request, while the first one is in flight', async () => {
    const { site, client, gate } = await gated();
    const first = client.book(bookRequest());
    await vi.waitFor(() => expect(posts(site)).toHaveLength(1));

    await expect(client.book(bookRequest())).rejects.toThrow(/already in flight/);
    await expect(client.book(bookRequest({ slot: slotRef({ courtId: 10 }) }))).rejects.toThrow(/already in flight/);
    expect(posts(site)).toHaveLength(1);

    gate.release(jsonResponse(bookingOkPayload(100002)));
    expect(await first).toEqual({ kind: 'booked', reservationId: 100002 });
  });

  it('refuses a second call made in the same tick as the first', async () => {
    const { site, client } = await ready();
    const first = client.book(bookRequest());
    const second = client.book(bookRequest());
    await expect(second).rejects.toThrow(/already in flight/);
    expect(await first).toMatchObject({ kind: 'booked' });
    expect(posts(site)).toHaveLength(1);
  });

  it('allows the next booking once the previous one has finished, whichever way it ended', async () => {
    const { site, client } = await ready();
    const endings: (() => Response)[] = [
      () => jsonResponse(bookingOkPayload(100002)),
      () => jsonResponse(bookingErrorPayload('Ya tienes 1 reserva/s para este dia.')),
      () => emptyResponse(500),
      () => emptyResponse(504),
    ];
    for (const ending of endings) {
      respondWith(site, ending);
      await client.book(bookRequest());
    }
    expect(posts(site)).toHaveLength(endings.length);

    const flaky = switchableNetwork(site);
    const other = makeClient(site, { fetchImpl: flaky.fetchImpl });
    await other.login();
    flaky.arm('ECONNRESET');
    expect(await other.book(bookRequest())).toEqual({ kind: 'ambiguous' });
    flaky.disarm();
    respondWith(site, () => jsonResponse(bookingOkPayload(100004)));
    expect(await other.book(bookRequest())).toEqual({ kind: 'booked', reservationId: 100004 });
  });

  it('releases the guard when the first call times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { site, client } = await ready();
    site.state.manager = (_call, signal) => hangUntilAborted(signal);
    const first = client.book(bookRequest());
    await vi.advanceTimersByTimeAsync(0);
    await expect(client.book(bookRequest())).rejects.toThrow(/already in flight/);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await first).toEqual({ kind: 'ambiguous' });
    respondWith(site, () => jsonResponse(bookingOkPayload(100003)));
    expect(await client.book(bookRequest())).toEqual({ kind: 'booked', reservationId: 100003 });
  });
});
