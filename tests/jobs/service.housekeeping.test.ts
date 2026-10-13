import { afterEach, describe, expect, it } from 'vitest';
import { buildHolidaySet } from '../../src/config/holidays.js';
import type { Job, JobState, JobStore } from '../../src/contracts.js';
import { createJobService } from '../../src/jobs/service.js';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { apiCallCount, cleanupTemp, date, DAY, driveTo, emptyDay, HOUR, makeApi, makeClock, makeLogger, newJob, NOW, track } from './_helpers.js';
import { created, harness, request } from './_service.js';

afterEach(cleanupTemp);

const OPENED = NOW - 7 * DAY;

const addJob = (store: SqliteJobStore, day: string, state: JobState): Job => {
  const job = store.create(newJob({ gameDate: date(day) }), OPENED, NOW);
  return driveTo(store, job.id, state);
};

describe('past bookings stop occupying the active set', () => {
  it.each(['booked', 'needs_payment'] as const)('a %s job whose game day is over is retired by listJobs()', (state) => {
    const { service, store } = harness();
    const past = addJob(store, '2026-10-12', state);
    expect(service.listJobs().map((job) => [job.id, job.state])).toEqual([[past.id, 'expired']]);
    expect(store.get(past.id)?.updatedAtMs).toBe(NOW);
  });

  it('keeps the reservation data of a retired booking and gives the job the expired state', async () => {
    const { service, store } = harness();
    const job = store.create(newJob({ gameDate: date('2026-10-12') }), OPENED, NOW);
    driveTo(store, job.id, 'firing');
    store.transition(job.id, 'firing', 'booked', NOW, { reservationId: 7, bookedChoice: { courtId: 9, startMinutes: 1080 } });
    service.listJobs();
    expect(store.get(job.id)).toMatchObject({ state: 'expired', reservationId: 7, bookedChoice: { courtId: 9, startMinutes: 1080 }, failureReason: null });
  });

  it.each(['booked', 'needs_payment'] as const)('status() drops a past %s job from activeJobs', async (state) => {
    const { service, store } = harness();
    const past = addJob(store, '2026-10-12', state);
    const upcoming = addJob(store, '2026-10-20', state);
    const report = await service.status();
    expect(report.activeJobs.map((job) => job.id)).toEqual([upcoming.id]);
    expect(store.get(past.id)?.state).toBe('expired');
  });

  it('createJob() retires it too, so a stale row can never block anything', async () => {
    const { service, store } = harness();
    const past = addJob(store, '2026-10-12', 'booked');
    created(await service.createJob(request()));
    expect(store.get(past.id)?.state).toBe('expired');
  });

  it('retires past bookings when the service starts', () => {
    const store = track(new SqliteJobStore(':memory:'));
    const past = addJob(store, '2026-10-12', 'booked');
    const today = addJob(store, '2026-10-13', 'needs_payment');
    createJobService({ store, api: makeApi(), clock: makeClock(), holidays: buildHolidaySet(undefined), logger: makeLogger() });
    expect(store.get(past.id)?.state).toBe('expired');
    expect(store.get(today.id)?.state).toBe('needs_payment');
  });

  it('keeps a booking for today and for the future, and retires it exactly at club midnight', async () => {
    const day = Date.UTC(2026, 9, 13, 22, 0, 0);
    const { service, store, clock } = harness({ now: day - 1000 });
    const today = addJob(store, '2026-10-13', 'booked');
    const tomorrow = addJob(store, '2026-10-14', 'booked');
    await service.status();
    expect([today, tomorrow].map((job) => store.get(job.id)?.state)).toEqual(['booked', 'booked']);
    clock.set(day);
    expect((await service.status()).activeJobs.map((job) => job.id)).toEqual([tomorrow.id]);
    expect(store.get(today.id)?.state).toBe('expired');
  });

  it('never touches jobs that are not booked or waiting for payment', async () => {
    const { service, store } = harness();
    const jobs = (['scheduled', 'warming', 'firing', 'failed', 'cancelled'] as const).map((state, index) =>
      addJob(store, `2026-10-0${index + 1}`, state),
    );
    await service.status();
    service.listJobs();
    expect(jobs.map((job) => store.get(job.id)?.state)).toEqual(['scheduled', 'warming', 'firing', 'failed', 'cancelled']);
  });

  it('does not touch the site', async () => {
    const { service, store, api } = harness();
    addJob(store, '2026-10-12', 'booked');
    const before = apiCallCount(api);
    service.listJobs();
    expect(apiCallCount(api)).toBe(before);
  });

  it('is idempotent: a second pass changes nothing', async () => {
    const { service, store, clock } = harness();
    const past = addJob(store, '2026-10-12', 'booked');
    service.listJobs();
    const once = store.get(past.id);
    clock.advance(HOUR);
    service.listJobs();
    await service.status();
    expect(store.get(past.id)).toEqual(once);
  });

  it('never breaks a read: a store that fails during housekeeping still lets status() and listJobs() answer, without leaking the error text', async () => {
    const { service, store, logger } = harness({
      wrapStore: (real): JobStore => ({
        create: (...args) => real.create(...args),
        get: (id) => real.get(id),
        list: (filter) => real.list(filter),
        transition: (id, from, to, nowMs, patch) => {
          if (to === 'expired') throw new Error('SECRET-DISK-ERROR');
          return real.transition(id, from, to, nowMs, patch);
        },
        isStopped: () => real.isStopped(),
        setStopped: (stopped) => real.setStopped(stopped),
      }),
    });
    const past = addJob(store, '2026-10-12', 'booked');
    expect(service.listJobs().map((job) => job.id)).toEqual([past.id]);
    expect((await service.status()).activeJobs).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.dump()).not.toContain('SECRET-DISK-ERROR');
  });
});

describe('status().activeJobs puts what is coming first', () => {
  it('orders by game date, then by id', async () => {
    const { service, store } = harness();
    const late = addJob(store, '2026-10-25', 'scheduled');
    const soon = addJob(store, '2026-10-20', 'booked');
    const middle = addJob(store, '2026-10-22', 'warming');
    const report = await service.status();
    expect(report.activeJobs.map((job) => job.id)).toEqual([soon.id, middle.id, late.id]);
  });

  it('a pile of finished bookings no longer pushes the newest jobs out of the first ten', async () => {
    const { service, store } = harness();
    for (let day = 1; day <= 12; day += 1) addJob(store, `2026-10-${String(day).padStart(2, '0')}`, 'booked');
    const armed = created(await service.createJob(request({ gameDate: date('2026-10-21') }))).job;
    const report = await service.status();
    expect(report.activeJobs.map((job) => job.id)).toEqual([armed.id]);
  });
});

describe('createJob releases a booking that is no longer on the club calendar', () => {
  const bookedOn20Oct = (state: 'booked' | 'needs_payment' = 'booked', options?: Parameters<typeof harness>[0]) => {
    const h = harness(options);
    const job = addJob(h.store, '2026-10-20', state);
    return { ...h, job };
  };

  it.each(['booked', 'needs_payment'] as const)(
    'a %s job whose booking has vanished (cancelled on the site) no longer blocks its date',
    async (state) => {
      const { service, store, api, job } = bookedOn20Oct(state);
      api.getDay.mockResolvedValue(emptyDay(date('2026-10-20'), false));
      const result = created(await service.createJob(request()));
      expect(result.job.id).toBe(job.id + 1);
      expect(store.get(job.id)).toMatchObject({ state: 'expired', failureReason: 'booking_not_on_calendar' });
      expect(api.getDay).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['booked', 'needs_payment'] as const)('a %s job whose booking is still on the calendar keeps blocking its date', async (state) => {
    const { service, store, api, job } = bookedOn20Oct(state);
    api.getDay.mockResolvedValue(emptyDay(date('2026-10-20'), true));
    expect(await service.createJob(request())).toMatchObject({ kind: 'rejected', reason: 'duplicate_active_job' });
    expect(store.get(job.id)?.state).toBe(state);
    expect(store.list()).toHaveLength(1);
  });

  it('keeps blocking when the calendar cannot be read (nothing is released on a guess)', async () => {
    const { service, store, api, job } = bookedOn20Oct();
    api.getDay.mockRejectedValue(new Error('SECRET-RESPONSE-BODY'));
    expect(await service.createJob(request())).toMatchObject({ reason: 'duplicate_active_job' });
    expect(store.get(job.id)?.state).toBe('booked');
  });

  it('keeps blocking when the calendar came back without any slot (an empty answer proves nothing)', async () => {
    const { service, store, api, job } = bookedOn20Oct();
    api.getDay.mockResolvedValue({ gameDate: date('2026-10-20'), courts: [] });
    expect(await service.createJob(request())).toMatchObject({ reason: 'duplicate_active_job' });
    api.getDay.mockResolvedValue({ gameDate: date('2026-10-20'), courts: [{ courtId: 9, name: 'Pista', slots: [] }] });
    expect(await service.createJob(request())).toMatchObject({ reason: 'duplicate_active_job' });
    expect(store.get(job.id)?.state).toBe('booked');
  });

  it('a booking on any court of that day keeps the date blocked', async () => {
    const { service, api } = bookedOn20Oct();
    const day = emptyDay(date('2026-10-20'));
    api.getDay.mockResolvedValue({
      ...day,
      courts: day.courts.map((court) => ({
        ...court,
        slots: court.slots.map((slot) => (court.courtId === 10 ? { ...slot, free: false, ownBooking: true } : slot)),
      })),
    });
    expect(await service.createJob(request())).toMatchObject({ reason: 'duplicate_active_job' });
  });

  it.each(['scheduled', 'warming', 'firing'] as const)('a %s job is never released and the site is not asked', async (state) => {
    const h = harness();
    addJob(h.store, '2026-10-20', state);
    expect(await h.service.createJob(request())).toMatchObject({ reason: 'duplicate_active_job' });
    expect(apiCallCount(h.api)).toBe(0);
  });

  it('loses gracefully when the job changes state between the calendar read and the release', async () => {
    const { service, store, api, job } = bookedOn20Oct('booked', {
      wrapStore: (real): JobStore => ({
        create: (...args) => real.create(...args),
        get: (id) => real.get(id),
        list: (filter) => real.list(filter),
        transition: () => undefined,
        isStopped: () => real.isStopped(),
        setStopped: (stopped) => real.setStopped(stopped),
      }),
    });
    api.getDay.mockResolvedValue(emptyDay(date('2026-10-20'), false));
    expect(await service.createJob(request())).toMatchObject({ reason: 'duplicate_active_job' });
    expect(store.get(job.id)?.state).toBe('booked');
  });

  it('after a release the new job still goes through the own-booking and funds checks with ONE calendar read', async () => {
    const { service, api } = bookedOn20Oct();
    api.getDay.mockResolvedValue(emptyDay(date('2026-10-20'), false));
    const result = created(await service.createJob(request()));
    expect(result).toMatchObject({ walletCents: 5000, requiredCents: 1902, fundsOk: true });
    expect(api.getDay).toHaveBeenCalledTimes(1);
    expect(api.quote).toHaveBeenCalledTimes(1);
  });

  it('logs no response text', async () => {
    const { service, api, logger } = bookedOn20Oct();
    api.getDay.mockRejectedValue(new Error('SECRET-RESPONSE-BODY'));
    await service.createJob(request());
    expect(logger.dump()).not.toContain('SECRET-RESPONSE-BODY');
  });
});
