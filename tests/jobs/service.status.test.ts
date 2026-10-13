import { afterEach, describe, expect, it } from 'vitest';
import type { GameDate } from '../../src/config/gameDate.js';
import type { JobState } from '../../src/contracts.js';
import { AuthExpiredError, UnexpectedResponseError } from '../../src/reservaplay/errors.js';
import { apiCallCount, cleanupTemp, date, driveTo, emptyDay, HOUR, newJob, NOW } from './_helpers.js';
import { created, harness, request } from './_service.js';

afterEach(cleanupTemp);

describe('cancelJob', () => {
  it.each(['scheduled', 'warming'] as const)('cancels a %s job', async (state) => {
    const { service, store } = harness();
    const { job } = created(await service.createJob(request()));
    driveTo(store, job.id, state);
    const result = await service.cancelJob(job.id);
    expect(result).toMatchObject({ kind: 'cancelled', job: { id: job.id, state: 'cancelled' } });
    expect(store.get(job.id)?.state).toBe('cancelled');
  });

  it.each(['firing', 'booked', 'needs_payment', 'failed', 'cancelled', 'expired'] as const)(
    'refuses a %s job and leaves it untouched',
    async (state) => {
      const { service, store } = harness();
      const { job } = created(await service.createJob(request()));
      const before = driveTo(store, job.id, state);
      expect(await service.cancelJob(job.id)).toEqual({ kind: 'not_cancellable', state });
      expect(store.get(job.id)).toEqual(before);
    },
  );

  it('answers not_found for an unknown or malformed id', async () => {
    const { service } = harness();
    created(await service.createJob(request()));
    for (const id of [99, 0, -1, 1.5, Number.NaN]) expect(await service.cancelJob(id), String(id)).toEqual({ kind: 'not_found' });
  });

  it('never touches the site', async () => {
    const { service, api } = harness();
    const { job } = created(await service.createJob(request({ gameDate: date('2026-10-21') })));
    const before = apiCallCount(api);
    await service.cancelJob(job.id);
    await service.cancelJob(job.id);
    await service.cancelJob(404);
    expect(apiCallCount(api)).toBe(before);
  });

  it('frees the date so a new job can be created, and stamps the injected clock', async () => {
    const { service, clock } = harness();
    const { job } = created(await service.createJob(request()));
    clock.advance(5000);
    const result = await service.cancelJob(job.id);
    expect(result).toMatchObject({ kind: 'cancelled', job: { updatedAtMs: NOW + 5000 } });
    expect(created(await service.createJob(request())).job.id).toBe(job.id + 1);
  });

  it('cancelling twice reports the second attempt as not cancellable', async () => {
    const { service } = harness();
    const { job } = created(await service.createJob(request()));
    expect(await service.cancelJob(job.id)).toMatchObject({ kind: 'cancelled' });
    expect(await service.cancelJob(job.id)).toEqual({ kind: 'not_cancellable', state: 'cancelled' });
  });

  it('loses gracefully to a sniper that moved the job on between the read and the transition', async () => {
    const { service, store } = harness({
      wrapStore: (real) => ({
        create: (...args) => real.create(...args),
        get: (id) => real.get(id),
        list: (filter) => real.list(filter),
        transition: (id, from, to, nowMs, patch) => {
          driveTo(real, id, 'firing');
          return real.transition(id, from, to, nowMs, patch);
        },
        isStopped: () => real.isStopped(),
        setStopped: (stopped) => real.setStopped(stopped),
      }),
    });
    const { job } = created(await service.createJob(request()));
    expect(await service.cancelJob(job.id)).toEqual({ kind: 'not_cancellable', state: 'firing' });
    expect(store.get(job.id)?.state).toBe('firing');
  });
});

describe('stopAll / resumeAll', () => {
  it('toggles the persisted flag and is idempotent', () => {
    const { service, store } = harness();
    expect(store.isStopped()).toBe(false);
    service.stopAll();
    service.stopAll();
    expect(store.isStopped()).toBe(true);
    service.resumeAll();
    service.resumeAll();
    expect(store.isStopped()).toBe(false);
  });

  it('does not cancel or change any job', async () => {
    const { service, store } = harness();
    const { job } = created(await service.createJob(request()));
    service.stopAll();
    expect(store.get(job.id)).toEqual(job);
  });

  it('is reflected by status()', async () => {
    const { service } = harness();
    expect((await service.status()).stopped).toBe(false);
    service.stopAll();
    expect((await service.status()).stopped).toBe(true);
    service.resumeAll();
    expect((await service.status()).stopped).toBe(false);
  });
});

describe('status', () => {
  it('reports session, wallet, stop flag and an empty plan on a fresh install', async () => {
    const { service } = harness();
    expect(await service.status()).toEqual({
      stopped: false,
      sessionAlive: true,
      walletCents: 5000,
      activeJobs: [],
      upcomingHolidays: [],
      nextWindowOpensAtMs: null,
    });
  });

  it('session: true when keepAlive works, false when the session expired, null when it cannot be told', async () => {
    const { service, api } = harness();
    expect((await service.status()).sessionAlive).toBe(true);
    api.keepAlive.mockRejectedValue(new AuthExpiredError());
    expect((await service.status()).sessionAlive).toBe(false);
    api.keepAlive.mockRejectedValue(new UnexpectedResponseError('weird', 503));
    expect((await service.status()).sessionAlive).toBeNull();
    api.keepAlive.mockRejectedValue(new Error('ECONNRESET'));
    expect((await service.status()).sessionAlive).toBeNull();
  });

  it('wallet: the balance, or null when it cannot be read', async () => {
    const { service, api } = harness();
    api.getWallet.mockResolvedValue({ balanceCents: 1234 });
    expect((await service.status()).walletCents).toBe(1234);
    api.getWallet.mockRejectedValue(new Error('down'));
    expect((await service.status()).walletCents).toBeNull();
  });

  it('never throws, even when everything on the site fails, and logs no error messages', async () => {
    const { service, api, logger } = harness();
    api.keepAlive.mockRejectedValue(new Error('SECRET-COOKIE-VALUE'));
    api.getWallet.mockRejectedValue(new Error('SECRET-COOKIE-VALUE'));
    const report = await service.status();
    expect(report).toMatchObject({ sessionAlive: null, walletCents: null });
    expect(logger.dump()).not.toContain('SECRET-COOKIE-VALUE');
  });

  it('lists exactly the active jobs (scheduled, warming, firing, booked, needs_payment), oldest first', async () => {
    const { service, store } = harness();
    const all: readonly JobState[] = ['scheduled', 'warming', 'firing', 'booked', 'needs_payment', 'failed', 'cancelled', 'expired'];
    all.forEach((state, index) => {
      const job = store.create(newJob({ gameDate: date(`2026-10-${20 + index}`) }), NOW + HOUR, NOW);
      driveTo(store, job.id, state);
    });
    const report = await service.status();
    expect(report.activeJobs.map((job) => job.state)).toEqual(['scheduled', 'warming', 'firing', 'booked', 'needs_payment']);
    expect(report.activeJobs.map((job) => job.id)).toEqual([1, 2, 3, 4, 5]);
  });

  describe('upcomingHolidays', () => {
    const set = (...days: string[]): ReadonlySet<GameDate> => new Set(days.map(date));

    it('lists holidays in the next 30 club days, sorted, including today and excluding day 30 and the past', async () => {
      const { service } = harness({ holidays: set('2026-11-12', '2026-11-11', '2026-10-13', '2026-10-12', '2026-12-25') });
      expect((await service.status()).upcomingHolidays).toEqual(['2026-10-13', '2026-11-11']);
    });

    it('counts from the club date, not the UTC date', async () => {
      const { service } = harness({ now: Date.UTC(2026, 9, 12, 22, 30, 0), holidays: set('2026-10-12', '2026-10-13') });
      expect((await service.status()).upcomingHolidays).toEqual(['2026-10-13']);
    });

    it('uses the built-in official holidays by default (8 Dec 2026 is 56 days away: not listed yet; 9 Oct 2026 is past)', async () => {
      const { service } = harness();
      expect((await service.status()).upcomingHolidays).toEqual([]);
      const later = harness({ now: Date.UTC(2026, 10, 20, 6, 0, 0) });
      expect((await later.service.status()).upcomingHolidays).toEqual(['2026-12-08']);
    });
  });
});

describe('thin delegations', () => {
  it('allowedCourts follows weekday / weekend / holiday rules', () => {
    const { service } = harness();
    expect(service.allowedCourts(date('2026-10-20'))).toEqual([4, 9, 10, 11, 12]);
    expect(service.allowedCourts(date('2026-10-17'))).toEqual([1, 2, 3, 4, 7, 8, 9, 10, 11, 12]);
    expect(service.allowedCourts(date('2026-12-08'))).toEqual([1, 2, 3, 4, 7, 8, 9, 10, 11, 12]);
    const custom = harness({ holidays: new Set([date('2026-10-20')]) });
    expect(custom.service.allowedCourts(date('2026-10-20'))).toHaveLength(10);
  });

  it('allowedCourts refuses a date that is not a real game date', () => {
    const { service } = harness();
    expect(() => service.allowedCourts('2026-02-30' as GameDate)).toThrow();
  });

  it('getDay delegates to the api and passes failures through', async () => {
    const { service, api } = harness();
    const day = emptyDay(date('2026-10-20'));
    api.getDay.mockResolvedValueOnce(day);
    expect(await service.getDay(date('2026-10-20'))).toBe(day);
    expect(api.getDay).toHaveBeenCalledWith('2026-10-20');
    api.getDay.mockRejectedValueOnce(new AuthExpiredError());
    await expect(service.getDay(date('2026-10-20'))).rejects.toBeInstanceOf(AuthExpiredError);
    await expect(service.getDay('nonsense' as GameDate)).rejects.toThrow();
  });

  it('wallet delegates to the api', async () => {
    const { service, api } = harness();
    api.getWallet.mockResolvedValueOnce({ balanceCents: 777 });
    expect(await service.wallet()).toEqual({ balanceCents: 777 });
    api.getWallet.mockRejectedValueOnce(new AuthExpiredError());
    await expect(service.wallet()).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('listJobs returns every job, finished ones included, oldest first', async () => {
    const { service, store } = harness();
    const first = created(await service.createJob(request({ gameDate: date('2026-10-22') }))).job;
    created(await service.createJob(request({ gameDate: date('2026-10-21') })));
    driveTo(store, first.id, 'failed');
    expect(service.listJobs().map((job) => [job.id, job.state])).toEqual([
      [1, 'failed'],
      [2, 'scheduled'],
    ]);
  });
});

describe('cancelJob does not rely on the store matrix', () => {
  it('refuses a firing job without even attempting a transition', async () => {
    const attempts: unknown[] = [];
    const { service, store } = harness({
      wrapStore: (real) => ({
        create: (...args) => real.create(...args),
        get: (id) => real.get(id),
        list: (filter) => real.list(filter),
        transition: (...args) => {
          attempts.push(args);
          return real.transition(...args);
        },
        isStopped: () => real.isStopped(),
        setStopped: (stopped) => real.setStopped(stopped),
      }),
    });
    const { job } = created(await service.createJob(request()));
    driveTo(store, job.id, 'firing');
    expect(await service.cancelJob(job.id)).toEqual({ kind: 'not_cancellable', state: 'firing' });
    expect(attempts).toEqual([]);
  });

  it('only ever asks the store to cancel from scheduled or warming', async () => {
    const asked: unknown[] = [];
    const { service } = harness({
      wrapStore: (real) => ({
        create: (...args) => real.create(...args),
        get: (id) => real.get(id),
        list: (filter) => real.list(filter),
        transition: (id, from, to, nowMs, patch) => {
          asked.push([from, to]);
          return real.transition(id, from, to, nowMs, patch);
        },
        isStopped: () => real.isStopped(),
        setStopped: (stopped) => real.setStopped(stopped),
      }),
    });
    const { job } = created(await service.createJob(request()));
    await service.cancelJob(job.id);
    expect(asked).toEqual([[['scheduled', 'warming'], 'cancelled']]);
  });
});
