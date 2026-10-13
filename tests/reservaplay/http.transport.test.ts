import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIMEOUT_MS, describeFetchFailure, TransportError } from '../../src/reservaplay/http.js';
import { BASE_URL } from '../fixtures/reservaplay/constants.js';
import { hangUntilAborted, networkError } from '../fixtures/reservaplay/fakeFetch.js';
import { htmlResponse } from '../fixtures/reservaplay/responses.js';
import { failureOf, get, open } from './httpHelpers.js';

describe('timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const settleWith = (promise: Promise<unknown>): { readonly state: { done: boolean; error?: unknown } } => {
    const state: { done: boolean; error?: unknown } = { done: false };
    promise.then(
      () => {
        state.done = true;
      },
      (error: unknown) => {
        state.done = true;
        state.error = error;
      },
    );
    return { state };
  };

  it('defaults to 15 seconds and reports a timeout as "may have reached the server"', async () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(15_000);
    let seenSignal: AbortSignal | undefined;
    const { session } = open((_call, signal) => {
      seenSignal = signal;
      return hangUntilAborted(signal);
    });
    const { state } = settleWith(get(session));

    await vi.advanceTimersByTimeAsync(14_999);
    expect(state.done).toBe(false);
    expect(seenSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(state.done).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
    expect(state.error).toBeInstanceOf(TransportError);
    expect(state.error).toMatchObject({ reason: 'timeout', mayHaveReachedServer: true, label: 'test' });
  });

  it('honours the session default and a per-request override', async () => {
    const { session } = open((_call, signal) => hangUntilAborted(signal), { defaultTimeoutMs: 1_000 });
    const sessionDefault = settleWith(get(session));
    const override = settleWith(get(session, '/page', { timeoutMs: 30_000 }));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessionDefault.state.done).toBe(true);
    expect(override.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(override.state.done).toBe(true);
  });

  it('times out even when the fetch implementation ignores the abort signal', async () => {
    const { session } = open(() => new Promise<Response>(() => undefined), { defaultTimeoutMs: 500 });
    const { state } = settleWith(get(session));
    await vi.advanceTimersByTimeAsync(500);
    expect(state.error).toMatchObject({ reason: 'timeout' });
  });

  it('times out while the body is still being read, after the headers arrived', async () => {
    const stalled = new ReadableStream<Uint8Array>({ start: () => undefined });
    const { session } = open(() => new Response(stalled, { status: 200 }), { defaultTimeoutMs: 500 });
    const { state } = settleWith(get(session));
    await vi.advanceTimersByTimeAsync(499);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.error).toMatchObject({ reason: 'timeout', mayHaveReachedServer: true });
  });

  it('leaves no timer behind after a success or a failure', async () => {
    const ok = open(() => htmlResponse('ok'));
    await get(ok.session);
    expect(vi.getTimerCount()).toBe(0);

    const failing = open(() => {
      throw networkError('ECONNRESET');
    });
    await failureOf(get(failing.session));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('survives the late rejection of an abandoned request (no unhandled rejection)', async () => {
    const { session } = open((_call, signal) => hangUntilAborted(signal), { defaultTimeoutMs: 100 });
    const { state } = settleWith(get(session));
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.error).toBeInstanceOf(TransportError);
  });
});

describe('transport failures: did the request reach the server?', () => {
  it.each([
    ['connection refused', 'ECONNREFUSED'],
    ['DNS: not found', 'ENOTFOUND'],
    ['DNS: temporary failure', 'EAI_AGAIN'],
    ['DNS: permanent failure', 'EAI_FAIL'],
    ['network unreachable while connecting', 'ENETUNREACH'],
    ['host unreachable while connecting', 'EHOSTUNREACH'],
    ['no local address while connecting', 'EADDRNOTAVAIL'],
    ['connect timeout (undici)', 'UND_ERR_CONNECT_TIMEOUT'],
    ['invalid URL', 'ERR_INVALID_URL'],
    ['unknown certificate authority', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
    ['self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'],
    ['expired certificate', 'CERT_HAS_EXPIRED'],
    ['certificate for another host', 'ERR_TLS_CERT_ALTNAME_INVALID'],
  ])('%s (%s): the request was NOT sent', async (_name, code) => {
    const { session } = open(() => {
      throw networkError(code);
    });
    const error = await failureOf(get(session));
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ mayHaveReachedServer: false, code, reason: 'network' });
  });

  it.each([
    ['connection reset', 'ECONNRESET'],
    ['socket closed by the other side', 'UND_ERR_SOCKET'],
    ['response headers timeout', 'UND_ERR_HEADERS_TIMEOUT'],
    ['response body timeout', 'UND_ERR_BODY_TIMEOUT'],
    ['OS level timeout', 'ETIMEDOUT'],
    ['broken pipe', 'EPIPE'],
    ['an unknown code', 'ESOMETHINGNEW'],
  ])('%s (%s): the request MAY have reached the server', async (_name, code) => {
    const { session } = open(() => {
      throw networkError(code);
    });
    expect(await failureOf(get(session))).toMatchObject({ mayHaveReachedServer: true, code });
  });

  it('treats a failure without any error code as "may have reached the server"', () => {
    for (const error of [new Error('boom'), new TypeError('fetch failed'), 'a string', null, undefined, new DOMException('x', 'AbortError')]) {
      expect(describeFetchFailure(error)).toEqual({ mayHaveReachedServer: true, code: null });
    }
  });

  it('finds the code anywhere in the cause chain', () => {
    const deep = new Error('a', { cause: new Error('b', { cause: Object.assign(new Error('c'), { code: 'ECONNREFUSED' }) }) });
    expect(describeFetchFailure(deep)).toEqual({ mayHaveReachedServer: false, code: 'ECONNREFUSED' });
  });

  it('treats a dual-stack connect failure (AggregateError) as not sent only when every attempt was refused', () => {
    const refused = (): Error => Object.assign(new Error('r'), { code: 'ECONNREFUSED' });
    const allRefused = Object.assign(new AggregateError([refused(), refused()], 'x'), { code: 'ECONNREFUSED' });
    expect(describeFetchFailure(new TypeError('fetch failed', { cause: allRefused })).mayHaveReachedServer).toBe(false);

    const mixed = new AggregateError([refused(), Object.assign(new Error('r'), { code: 'ECONNRESET' })], 'x');
    expect(describeFetchFailure(new TypeError('fetch failed', { cause: mixed })).mayHaveReachedServer).toBe(true);
  });

  it('is not fooled by a cyclic cause chain', () => {
    const loop: { cause?: unknown; code?: string } = { code: 'ECONNRESET' };
    loop.cause = loop;
    expect(describeFetchFailure(loop)).toMatchObject({ mayHaveReachedServer: true });
  });

  it('wraps a failure while reading the body as "may have reached the server"', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(Object.assign(new Error('reset'), { code: 'ECONNREFUSED' }));
      },
    });
    const { session } = open(() => new Response(broken, { status: 200 }));
    expect(await failureOf(get(session))).toMatchObject({ reason: 'network', mayHaveReachedServer: true });
  });

  it('keeps hostnames, URLs and original messages out of the error message', async () => {
    const { session } = open(() => {
      throw Object.assign(new TypeError('connect to club.example.test:443 failed'), { cause: Object.assign(new Error('secret detail'), { code: 'ECONNRESET' }) });
    });
    const error = (await failureOf(get(session, '/page?token=abc'))) as TransportError;
    expect(error.message).toBe('Transport failure on test: network (ECONNRESET)');
    expect(error.cause).toBeUndefined();
  });
});

describe('response size limit', () => {
  const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });

  it('accepts a body exactly at the limit and rejects one byte more', async () => {
    const fit = open(() => new Response('12345'), { maxResponseBytes: 5 });
    expect((await get(fit.session)).text).toBe('12345');

    const over = open(() => new Response('123456'), { maxResponseBytes: 5 });
    expect(await failureOf(get(over.session))).toMatchObject({ reason: 'response_too_large', mayHaveReachedServer: true });
  });

  it('counts bytes across chunks and stops reading', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('xxxxxxxxxx'));
      },
    });
    const { session } = open(() => new Response(endless), { maxResponseBytes: 100 });
    expect(await failureOf(get(session))).toMatchObject({ reason: 'response_too_large' });
    expect(pulled).toBeLessThan(50);
  });

  it('measures bytes, not characters', async () => {
    const { session } = open(() => new Response(streamOf('€€')), { maxResponseBytes: 5 });
    expect(await failureOf(get(session))).toMatchObject({ reason: 'response_too_large' });
  });

  it('has a generous default for real pages', async () => {
    const { session } = open(() => htmlResponse('x'.repeat(2_000_000)));
    expect((await get(session)).text).toHaveLength(2_000_000);
  });
});

describe('logging', () => {
  it('logs only a label, the status and the duration: no URL, query, body, header or cookie', async () => {
    const { session, logger } = open(() => htmlResponse('RESPONSE-BODY-MARKER', { cookies: ['sid=COOKIE-MARKER; Path=/'], headers: { 'x-leak': 'HEADER-MARKER' } }));
    await session.request({
      method: 'POST',
      url: `${BASE_URL}/path-marker?query=QUERY-MARKER`,
      label: 'test',
      headers: { 'X-Custom': 'REQUEST-HEADER-MARKER' },
      body: 'password=BODY-MARKER',
    });
    await session.request({ method: 'GET', url: `${BASE_URL}/again`, label: 'test' });

    const dump = logger.dump();
    for (const marker of ['MARKER', 'path-marker', 'password', 'sid=', BASE_URL, 'club.example.test']) expect(dump).not.toContain(marker);
    expect(logger.entries.length).toBeGreaterThan(0);
    for (const entry of logger.entries) {
      expect(Object.keys(entry.fields as object).sort()).toEqual(['label', 'ms', 'status']);
    }
  });

  it('logs failures with the reason and code only', async () => {
    const { session, logger } = open(() => {
      throw networkError('ECONNREFUSED');
    });
    await failureOf(get(session, '/page?secret=1', { body: 'password=BODY-MARKER' }));
    expect(logger.entries).toEqual([
      { level: 'warn', fields: { label: 'test', reason: 'network', code: 'ECONNREFUSED' }, message: 'request failed' },
    ]);
  });
});
