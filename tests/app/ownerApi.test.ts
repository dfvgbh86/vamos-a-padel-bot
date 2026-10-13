/** The owner-facing facade over the site: lazy login, but never in the sniper's way. */
import { describe, expect, it } from 'vitest';
import { parseGameDate } from '../../src/config/gameDate.js';
import type { Job, JobState, ReservaplayApi } from '../../src/contracts.js';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { AuthExpiredError, LoginFailedError, UnexpectedResponseError } from '../../src/reservaplay/errors.js';
import { createOwnerApi, QUIET_BEFORE_OPEN_MS } from '../../src/runtime/ownerApi.js';
import type { AppLogger } from '../../src/runtime/logger.js';
import { MINUTE, OPENS_MS } from './_rig.js';

const DAY = parseGameDate('2026-10-20');
const QUIET_LOGGER: AppLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const setup = (nowMs: number) => {
  const store = new SqliteJobStore(':memory:');
  let sessionAlive = false;
  const events: string[] = [];
  let failLogin: Error | undefined;
  const api = {
    login: async () => {
      events.push('login');
      if (failLogin !== undefined) throw failLogin;
      sessionAlive = true;
    },
    getWallet: async () => {
      events.push('getWallet:start');
      await Promise.resolve();
      if (!sessionAlive) throw new AuthExpiredError();
      events.push('getWallet:end');
      return { balanceCents: 1902 };
    },
    getDay: async () => {
      events.push('getDay:start');
      await Promise.resolve();
      if (!sessionAlive) throw new AuthExpiredError();
      events.push('getDay:end');
      return { gameDate: DAY, courts: [] };
    },
    keepAlive: async () => {
      if (!sessionAlive) throw new AuthExpiredError();
    },
    quote: async () => ({ totalCents: 1902, walletPayable: true }),
  } as unknown as ReservaplayApi;
  const owner = createOwnerApi({ api, store, clock: { nowMs: () => nowMs, monotonicMs: () => nowMs, sleep: async () => undefined }, logger: QUIET_LOGGER });
  const arm = (state: JobState = 'scheduled', opensAtMs = OPENS_MS): Job => {
    const job = store.create({ gameDate: DAY, choices: [{ courtId: 9, startMinutes: 1080 }], durationMinutes: 90, payment: 'wallet' }, opensAtMs, nowMs);
    if (state === 'warming' || state === 'firing') store.transition(job.id, 'scheduled', 'warming', nowMs);
    if (state === 'firing') store.transition(job.id, 'warming', 'firing', nowMs);
    return job;
  };
  return {
    owner,
    arm,
    events,
    store,
    expireSession: () => {
      sessionAlive = false;
    },
    breakLogin: (error: Error) => {
      failLogin = error;
    },
  };
};

describe('lazy login for owner requests', () => {
  it('logs in once when the session is gone, then repeats the request', async () => {
    const { owner, events } = setup(OPENS_MS - 3 * 60 * MINUTE);
    await expect(owner.getWallet()).resolves.toEqual({ balanceCents: 1902 });
    expect(events).toEqual(['getWallet:start', 'login', 'getWallet:start', 'getWallet:end']);
  });

  it('does not log in when the session is alive', async () => {
    const { owner, events } = setup(OPENS_MS - 3 * 60 * MINUTE);
    await owner.getWallet();
    events.length = 0;
    await owner.getDay(DAY);
    expect(events).toEqual(['getDay:start', 'getDay:end']);
  });

  it('logs in again after the session expires later', async () => {
    const { owner, events, expireSession } = setup(OPENS_MS - 3 * 60 * MINUTE);
    await owner.getWallet();
    expireSession();
    events.length = 0;
    await owner.getWallet();
    expect(events).toContain('login');
  });

  it('passes every other failure through untouched and does not log in for it', async () => {
    const store = new SqliteJobStore(':memory:');
    const failure = new UnexpectedResponseError('Calendar response is not JSON', 200);
    const logins: string[] = [];
    const api = {
      login: async () => void logins.push('login'),
      getDay: async () => {
        throw failure;
      },
    } as unknown as ReservaplayApi;
    const owner = createOwnerApi({ api, store, clock: { nowMs: () => 0, monotonicMs: () => 0, sleep: async () => undefined }, logger: QUIET_LOGGER });
    await expect(owner.getDay(DAY)).rejects.toBe(failure);
    expect(logins).toEqual([]);
  });

  it('a login that fails is what the caller sees, and the request is not repeated', async () => {
    const { owner, events, breakLogin } = setup(OPENS_MS - 3 * 60 * MINUTE);
    const failure = new LoginFailedError('Login was not accepted (HTTP 200)');
    breakLogin(failure);
    await expect(owner.getWallet()).rejects.toBe(failure);
    expect(events).toEqual(['getWallet:start', 'login']);
  });

  it('repeats the request only once: a session that is still rejected after the login is an error', async () => {
    const store = new SqliteJobStore(':memory:');
    let reads = 0;
    const api = {
      login: async () => undefined,
      getWallet: async () => {
        reads++;
        throw new AuthExpiredError();
      },
    } as unknown as ReservaplayApi;
    const owner = createOwnerApi({ api, store, clock: { nowMs: () => 0, monotonicMs: () => 0, sleep: async () => undefined }, logger: QUIET_LOGGER });
    await expect(owner.getWallet()).rejects.toBeInstanceOf(AuthExpiredError);
    expect(reads).toBe(2);
  });
});

describe('never in the way of the sniper', () => {
  it('does not log in within 15 minutes of an opening that an armed job waits for', async () => {
    const { owner, arm, events } = setup(OPENS_MS - 14 * MINUTE);
    arm();
    await expect(owner.getWallet()).rejects.toBeInstanceOf(AuthExpiredError);
    expect(events).not.toContain('login');
  });

  it('logs in when the armed job opens in more than 15 minutes', async () => {
    const { owner, arm, events } = setup(OPENS_MS - 16 * MINUTE);
    arm();
    await expect(owner.getWallet()).resolves.toBeDefined();
    expect(events).toContain('login');
  });

  it('the quiet period is 15 minutes, longer than the 10 minute preparation of the sniper', () => {
    expect(QUIET_BEFORE_OPEN_MS).toBe(15 * MINUTE);
  });

  it.each(['warming', 'firing'] as const)('does not log in while a job is %s, however far its opening is', async (state) => {
    const { owner, arm, events } = setup(OPENS_MS - 5 * 60 * MINUTE);
    arm(state, OPENS_MS + 24 * 60 * MINUTE);
    await expect(owner.getDay(DAY)).rejects.toBeInstanceOf(AuthExpiredError);
    expect(events).not.toContain('login');
  });

  it('does not log in after the opening while the job has not been picked up yet', async () => {
    const { owner, arm, events } = setup(OPENS_MS + 30_000);
    arm('scheduled');
    await expect(owner.getWallet()).rejects.toBeInstanceOf(AuthExpiredError);
    expect(events).not.toContain('login');
  });

  it('ignores jobs that are finished', async () => {
    const { owner, arm, store, events } = setup(OPENS_MS - 5 * 60 * MINUTE);
    const job = arm();
    store.transition(job.id, 'scheduled', 'cancelled', 0);
    await expect(owner.getWallet()).resolves.toBeDefined();
    expect(events).toContain('login');
  });

  it('assumes the sniper needs the session when the jobs cannot be read', async () => {
    const { owner, store, events } = setup(OPENS_MS - 5 * 60 * MINUTE);
    store.close();
    await expect(owner.getWallet()).rejects.toBeInstanceOf(AuthExpiredError);
    expect(events).not.toContain('login');
  });
});

describe('one owner request at a time', () => {
  it('runs concurrent requests one after the other, so none overlaps a login', async () => {
    const { owner, events } = setup(OPENS_MS - 3 * 60 * MINUTE);
    await Promise.all([owner.getWallet(), owner.getDay(DAY), owner.getWallet()]);
    const starts = events.filter((event) => event.endsWith(':start') || event === 'login');
    const ends = events.filter((event) => event.endsWith(':end'));
    expect(ends).toHaveLength(3);
    // between the start of a request and its end nothing else starts; the request that finds the session gone ends in the login
    let open = 0;
    for (const event of events) {
      if (event === 'login') open = 0;
      if (event.endsWith(':start')) open++;
      if (event.endsWith(':end')) open--;
      expect(open).toBeLessThanOrEqual(1);
    }
    expect(starts.filter((event) => event === 'login')).toHaveLength(1);
  });

  it('a failed request does not block the ones behind it', async () => {
    const { owner, breakLogin } = setup(OPENS_MS - 3 * 60 * MINUTE);
    breakLogin(new LoginFailedError());
    const first = owner.getWallet().catch((error: unknown) => error);
    const second = owner.getDay(DAY).catch((error: unknown) => error);
    expect(await first).toBeInstanceOf(LoginFailedError);
    expect(await second).toBeInstanceOf(LoginFailedError);
  });
});
