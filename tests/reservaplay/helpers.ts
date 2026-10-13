import { DateTime } from 'luxon';
import { parseGameDate } from '../../src/config/gameDate.js';
import type { BookRequest, SlotRef } from '../../src/contracts.js';
import { createReservaplayClient, type ReservaplayClientConfig } from '../../src/reservaplay/client.js';
import type { HttpLogger } from '../../src/reservaplay/http.js';
import { ACCOUNT_ID, BASE_URL, HASH, PASSWORD, USERNAME } from '../fixtures/reservaplay/constants.js';
import { networkError } from '../fixtures/reservaplay/fakeFetch.js';
import { createFakeSite, type FakeSite } from '../fixtures/reservaplay/fakeSite.js';

export interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly fields: unknown;
  readonly message: string;
}

export interface CapturedLogger extends HttpLogger {
  readonly entries: LogEntry[];
  /** Everything that was logged, serialised: for "this must never appear" assertions. */
  dump(): string;
}

export const captureLogger = (): CapturedLogger => {
  const entries: LogEntry[] = [];
  const write = (level: LogEntry['level']) => (fields: object, message: string) => {
    entries.push({ level, fields, message });
  };
  return {
    entries,
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    dump: () => JSON.stringify(entries),
  };
};

export const silentLogger: HttpLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/** Monday 2026-10-19, court id 9 (allowed on weekdays), 18:00, 90 minutes. */
export const slotRef = (overrides: Partial<SlotRef> = {}): SlotRef => ({
  gameDate: parseGameDate('2026-10-19'),
  courtId: 9,
  startMinutes: 1080,
  durationMinutes: 90,
  ...overrides,
});

export const clubNow = (iso = '2026-10-12T06:55:00'): DateTime => DateTime.fromISO(iso, { zone: 'Europe/Madrid' });

export const makeClient = (site: Pick<FakeSite, 'fetchImpl'>, overrides: Partial<ReservaplayClientConfig> = {}) =>
  createReservaplayClient({
    baseUrl: BASE_URL,
    username: USERNAME,
    password: PASSWORD,
    logger: silentLogger,
    now: () => clubNow(),
    fetchImpl: site.fetchImpl,
    ...overrides,
  });

export const bookRequest = (overrides: Partial<BookRequest> = {}): BookRequest => ({
  slot: slotRef(),
  account: { accountId: ACCOUNT_ID, hash: HASH },
  payment: 'wallet',
  holidays: new Set(),
  ...overrides,
});

export type Interceptor = (url: string, init: RequestInit | undefined) => Response | undefined;

/** A fetch that lets the interceptor answer (or throw) first and otherwise falls through to the fake site. */
export const intercepting = (site: Pick<FakeSite, 'fetchImpl'>, interceptor: Interceptor): typeof fetch =>
  ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const answer = interceptor(String(input), init);
    return answer === undefined ? site.fetchImpl(input, init) : Promise.resolve(answer);
  }) as typeof fetch;

/** Network that works until `arm(code)`: then every request fails like undici does, with that error code (and syscall). */
export const switchableNetwork = (site: Pick<FakeSite, 'fetchImpl'>) => {
  let code: string | null = null;
  let syscall: string | null | undefined;
  const state = { failedAttempts: 0 };
  return {
    state,
    fetchImpl: intercepting(site, () => {
      if (code === null) return undefined;
      state.failedAttempts += 1;
      throw networkError(code, syscall);
    }),
    arm: (failureCode: string, failingSyscall?: string | null): void => {
      code = failureCode;
      syscall = failingSyscall;
    },
    disarm: (): void => {
      code = null;
    },
  };
};

export const failureOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
};

/** A client that has logged in; the recorded calls start empty, so tests see only their own requests. */
export const loggedIn = async (site: FakeSite = createFakeSite(), overrides: Partial<ReservaplayClientConfig> = {}) => {
  const client = makeClient(site, overrides);
  await client.login();
  site.calls.length = 0;
  return { site, client };
};

export const lastCall = (site: FakeSite) => site.calls[site.calls.length - 1];
