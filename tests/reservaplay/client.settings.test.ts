import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BookResult } from '../../src/contracts.js';
import { createReservaplayClient } from '../../src/reservaplay/client.js';
import { MAX_TIMER_MS } from '../../src/reservaplay/http.js';
import { BASE_URL, PASSWORD, USERNAME } from '../fixtures/reservaplay/constants.js';
import { hangUntilAborted } from '../fixtures/reservaplay/fakeFetch.js';
import { bookingOkPayload } from '../fixtures/reservaplay/pages.js';
import { jsonResponse } from '../fixtures/reservaplay/responses.js';
import { posts, ready } from './bookHelpers.js';
import { bookRequest, clubNow, silentLogger } from './helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

/** Delays setTimeout cannot honour: it fires after about 1 ms, which would cut a booking POST short and report "ambiguous". */
const BAD_DELAYS: readonly [string, number][] = [
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['a fraction', 20_000.5],
  ['just above 2^31-1', MAX_TIMER_MS + 1],
  ['three billion', 3e9],
  ['zero', 0],
  ['a negative number', -20_000],
];

const config = { baseUrl: BASE_URL, username: USERNAME, password: PASSWORD, logger: silentLogger, now: () => clubNow() };

describe('createReservaplayClient: timeout settings', () => {
  it.each(BAD_DELAYS)('refuses %s as bookTimeoutMs, instead of aborting the booking after 1 ms', (_name, value) => {
    expect(() => createReservaplayClient({ ...config, bookTimeoutMs: value })).toThrow(/bookTimeoutMs must be an integer between 1 and 2147483647/);
  });

  it.each(BAD_DELAYS)('refuses %s as timeoutMs', (_name, value) => {
    expect(() => createReservaplayClient({ ...config, timeoutMs: value })).toThrow(/timeoutMs must be an integer between 1 and 2147483647/);
  });

  it('accepts the usual and the extreme valid values', () => {
    for (const bookTimeoutMs of [1, 20_000, 25_000, MAX_TIMER_MS]) {
      expect(() => createReservaplayClient({ ...config, bookTimeoutMs })).not.toThrow();
    }
    for (const timeoutMs of [1, 15_000, MAX_TIMER_MS]) expect(() => createReservaplayClient({ ...config, timeoutMs })).not.toThrow();
  });

  it('does not put credentials in the error', () => {
    try {
      createReservaplayClient({ ...config, bookTimeoutMs: Number.NaN });
    } catch (error) {
      expect((error as Error).message).not.toContain(PASSWORD);
      expect((error as Error).message).not.toContain(USERNAME);
    }
  });

  describe('the booking POST with the settings that used to defeat the 20 second floor', () => {
    const hanging = async (bookTimeoutMs: number) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { site, client } = await ready({ bookTimeoutMs });
      site.state.manager = (_call, signal) => hangUntilAborted(signal);
      const state: { result?: BookResult } = {};
      void client.book(bookRequest()).then((result) => {
        state.result = result;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(posts(site)).toHaveLength(1);
      return state;
    };

    it('waits for the largest delay setTimeout supports, to the millisecond', async () => {
      const state = await hanging(MAX_TIMER_MS);
      await vi.advanceTimersByTimeAsync(MAX_TIMER_MS - 1);
      expect(state.result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(state.result).toEqual({ kind: 'ambiguous' });
    });

    it('lets a slow answer through (real timers): a 150 ms POST is neither aborted nor re-sent', async () => {
      vi.useRealTimers();
      for (const bookTimeoutMs of [undefined, 1_000]) {
        const { site, client } = await ready(bookTimeoutMs === undefined ? {} : { bookTimeoutMs });
        site.state.manager = () => new Promise<Response>((resolve) => setTimeout(() => resolve(jsonResponse(bookingOkPayload(100002))), 150));
        expect(await client.book(bookRequest())).toEqual({ kind: 'booked', reservationId: 100002 });
        expect(posts(site)).toHaveLength(1);
      }
    });
  });
});
