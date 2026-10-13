import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkedTimeoutMs, createHttpSession, MAX_TIMER_MS } from '../../src/reservaplay/http.js';
import { BASE_URL } from '../fixtures/reservaplay/constants.js';
import { hangUntilAborted } from '../fixtures/reservaplay/fakeFetch.js';
import { htmlResponse } from '../fixtures/reservaplay/responses.js';
import { captureLogger } from './helpers.js';
import { failureOf, get, open } from './httpHelpers.js';

/** A delay setTimeout cannot honour: it fires after about 1 ms, which would turn a slow booking into a false "timeout". */
const BAD_DELAYS: readonly [string, number][] = [
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['zero', 0],
  ['a negative number', -1],
  ['a fraction', 1.5],
  ['just above 2^31-1', MAX_TIMER_MS + 1],
  ['three billion', 3e9],
];

describe('checkedTimeoutMs', () => {
  it('returns every integer from 1 to 2^31-1 unchanged', () => {
    for (const value of [1, 2, 1_000, 15_000, MAX_TIMER_MS - 1, MAX_TIMER_MS]) expect(checkedTimeoutMs('x', value)).toBe(value);
  });

  it.each(BAD_DELAYS)('refuses %s', (_name, value) => {
    expect(() => checkedTimeoutMs('someTimeout', value)).toThrow(/someTimeout must be an integer between 1 and 2147483647/);
  });

  it('knows the real limit of setTimeout', () => {
    expect(MAX_TIMER_MS).toBe(2 ** 31 - 1);
  });
});

describe('timeout settings of the HTTP session', () => {
  it.each(BAD_DELAYS)('refuses %s as the session default', (_name, value) => {
    expect(() => createHttpSession({ baseUrl: BASE_URL, logger: captureLogger(), defaultTimeoutMs: value })).toThrow(/defaultTimeoutMs/);
  });

  it.each(BAD_DELAYS)('refuses %s as the timeout of one request, and sends nothing', async (_name, value) => {
    const { session, calls } = open(() => htmlResponse('ok'));
    const error = await failureOf(get(session, '/page', { timeoutMs: value }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/timeoutMs must be an integer/);
    expect(calls).toHaveLength(0);
  });

  it('accepts the smallest and the largest usable delay, and leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (const timeoutMs of [1, MAX_TIMER_MS]) {
        const { session } = open(() => htmlResponse('ok'));
        expect((await get(session, '/page', { timeoutMs })).text).toBe('ok');
      }
      const { session } = open(() => htmlResponse('ok'), { defaultTimeoutMs: MAX_TIMER_MS });
      expect((await get(session)).text).toBe('ok');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the timeout log line', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const expectOneTimeoutLine = (logger: ReturnType<typeof captureLogger>): void => {
    expect(logger.entries).toEqual([{ level: 'warn', fields: { label: 'test', timeoutMs: 500 }, message: 'request timed out' }]);
  };

  it('is written once with the label and the limit only, when the answer never starts', async () => {
    const { session, logger } = open((_call, signal) => hangUntilAborted(signal), { defaultTimeoutMs: 500 });
    const pending = failureOf(get(session, '/path?token=SECRET-MARKER', { body: 'password=SECRET-MARKER' }));
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ reason: 'timeout' });
    expectOneTimeoutLine(logger);
    expect(logger.dump()).not.toContain('SECRET-MARKER');
  });

  it('is written once too when the timeout hits while the body is being read', async () => {
    const stalled = new ReadableStream<Uint8Array>({ start: () => undefined });
    const { session, logger } = open(() => new Response(stalled, { status: 200 }), { defaultTimeoutMs: 500 });
    const pending = failureOf(get(session));
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ reason: 'timeout', mayHaveReachedServer: true });
    expectOneTimeoutLine(logger);
  });

  it('is not written for requests that finish in time', async () => {
    const { session, logger } = open(() => htmlResponse('ok'), { defaultTimeoutMs: 500 });
    await get(session);
    expect(logger.entries.map((entry) => entry.level)).toEqual(['debug']);
  });
});
