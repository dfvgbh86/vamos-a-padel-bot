import { afterEach, describe, expect, it } from 'vitest';
import { DuplicateActiveJobError, type CreateJobInput, type JobStore } from '../../src/contracts.js';
import { cleanupTemp, date, driveTo, emptyDay, NOW, OPENS_20_OCT } from './_helpers.js';
import { created, harness, request } from './_service.js';

afterEach(cleanupTemp);

describe('createJob: happy path', () => {
  it('creates a scheduled job with the defaults (90 minutes, wallet) for an already open date', async () => {
    const { service, store, api } = harness();
    const result = created(await service.createJob(request()));
    expect(result.job).toMatchObject({
      id: 1,
      state: 'scheduled',
      gameDate: '2026-10-20',
      choices: [{ courtId: 9, startMinutes: 1080 }],
      durationMinutes: 90,
      payment: 'wallet',
      opensAtMs: OPENS_20_OCT,
      attempts: 0,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    expect(store.get(1)).toEqual(result.job);
    expect(api.getDay).toHaveBeenCalledTimes(1);
    expect(api.getDay).toHaveBeenCalledWith('2026-10-20');
  });

  it('keeps explicit duration, payment and the priority order of the choices', async () => {
    const { service } = harness();
    const choices = [
      { courtId: 10, startMinutes: 1170 },
      { courtId: 9, startMinutes: 1080 },
      { courtId: 4, startMinutes: 540 },
    ];
    const { job } = created(await service.createJob(request({ choices, durationMinutes: 120, payment: 'card' })));
    expect(job.choices).toEqual(choices);
    expect(job.durationMinutes).toBe(120);
    expect(job.payment).toBe('card');
  });

  it.each([60, 90, 120, 180])('accepts a duration of %i minutes', async (durationMinutes) => {
    const { service } = harness();
    expect(created(await service.createJob(request({ durationMinutes }))).job.durationMinutes).toBe(durationMinutes);
  });

  it('computes the opening instant with the booking rule (D-7 07:00 club time), also for a date that is not open yet', async () => {
    const { service } = harness();
    const future = created(await service.createJob(request({ gameDate: date('2026-10-21') })));
    expect(future.job.opensAtMs).toBe(Date.UTC(2026, 9, 14, 5, 0, 0));
    const winter = harness({ now: Date.UTC(2026, 9, 25, 6, 0, 0) });
    const dst = created(await winter.service.createJob(request({ gameDate: date('2026-11-01') })));
    expect(dst.job.opensAtMs).toBe(Date.UTC(2026, 9, 25, 6, 0, 0));
  });

  it('honours a custom open rule', async () => {
    const { service } = harness({ openRule: { daysAhead: 3, hour: 9 } });
    const { job } = created(await service.createJob(request({ gameDate: date('2026-10-20') })));
    expect(job.opensAtMs).toBe(Date.UTC(2026, 9, 17, 7, 0, 0));
  });

  it('takes every timestamp from the injected clock and does not mutate the input', async () => {
    const { service, clock } = harness();
    clock.advance(12_345);
    const input = request({ choices: [{ courtId: 9, startMinutes: 1080 }] });
    const snapshot = JSON.stringify(input);
    expect(created(await service.createJob(input)).job.createdAtMs).toBe(NOW + 12_345);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('does not touch the site when the date is not open yet (nothing to check, nothing to quote)', async () => {
    const { service, api } = harness();
    created(await service.createJob(request({ gameDate: date('2026-10-21') })));
    expect(api.getDay).not.toHaveBeenCalled();
    expect(api.quote).not.toHaveBeenCalled();
  });

  it('creating a job is allowed while the emergency stop is on (the stop only blocks booking requests)', async () => {
    const { service } = harness();
    service.stopAll();
    expect(created(await service.createJob(request())).job.state).toBe('scheduled');
  });
});

describe('createJob: invalid_input', () => {
  const cases: readonly [string, Partial<CreateJobInput> | unknown][] = [
    ['an empty choice list', { choices: [] }],
    ['choices that are not a list', { choices: { courtId: 9, startMinutes: 1080 } }],
    ['a missing choice list', { choices: undefined }],
    ['a null choice', { choices: [null] }],
    ['a choice without a court', { choices: [{ startMinutes: 1080 }] }],
    ['a fractional court id', { choices: [{ courtId: 9.5, startMinutes: 1080 }] }],
    ['a string court id', { choices: [{ courtId: '9', startMinutes: 1080 }] }],
    ['a negative court id', { choices: [{ courtId: -9, startMinutes: 1080 }] }],
    ['a NaN start', { choices: [{ courtId: 9, startMinutes: Number.NaN }] }],
    ['a negative start', { choices: [{ courtId: 9, startMinutes: -1 }] }],
    ['a start of 1440', { choices: [{ courtId: 9, startMinutes: 1440 }] }],
    ['a fractional start', { choices: [{ courtId: 9, startMinutes: 1080.5 }] }],
    ['a string start', { choices: [{ courtId: 9, startMinutes: '1080' }] }],
    ['the same court and time twice', { choices: [{ courtId: 9, startMinutes: 1080 }, { courtId: 9, startMinutes: 1080 }] }],
    ['a malformed date', { gameDate: 'tomorrow' }],
    ['an impossible date', { gameDate: '2026-02-30' }],
    ['a date with a time part', { gameDate: '2026-10-20T10:00' }],
    ['a missing date', { gameDate: undefined }],
    ['a numeric date', { gameDate: 20261020 }],
    ['a duration below the minimum', { durationMinutes: 59 }],
    ['a duration above the maximum', { durationMinutes: 181 }],
    ['a fractional duration', { durationMinutes: 90.5 }],
    ['a null duration', { durationMinutes: null }],
    ['a string duration', { durationMinutes: '90' }],
    ['an unknown payment mode', { payment: 'cash' }],
    ['a null payment mode', { payment: null }],
    ['an uppercase payment mode', { payment: 'WALLET' }],
    ['no input at all', null],
    ['a string instead of an input object', 'hello'],
  ];

  it.each(cases)('rejects %s without touching the site or the store', async (_label, patch) => {
    const { service, store, api } = harness();
    const input = patch !== null && typeof patch === 'object' ? { ...request(), ...patch } : patch;
    const result = await service.createJob(input as CreateJobInput);
    expect(result).toMatchObject({ kind: 'rejected', reason: 'invalid_input' });
    expect(typeof (result as { detail: string }).detail).toBe('string');
    expect(store.list()).toEqual([]);
    expect(api.getDay).not.toHaveBeenCalled();
    expect(api.getWallet).not.toHaveBeenCalled();
    expect(api.quote).not.toHaveBeenCalled();
  });

  it('one bad choice rejects the whole request even when the others are fine', async () => {
    const { service, store } = harness();
    const result = await service.createJob(request({ choices: [{ courtId: 9, startMinutes: 1080 }, { courtId: 10, startMinutes: 5000 }] }));
    expect(result).toMatchObject({ kind: 'rejected', reason: 'invalid_input' });
    expect(store.list()).toEqual([]);
  });
});

describe('createJob: date range in club time', () => {
  it('rejects yesterday as date_in_past and allows today', async () => {
    const { service } = harness();
    expect(await service.createJob(request({ gameDate: date('2026-10-12') }))).toMatchObject({ kind: 'rejected', reason: 'date_in_past' });
    expect(created(await service.createJob(request({ gameDate: date('2026-10-13') }))).job.gameDate).toBe('2026-10-13');
  });

  it('allows exactly 20 days ahead and rejects 21 as date_too_far', async () => {
    const { service } = harness();
    expect(created(await service.createJob(request({ gameDate: date('2026-11-02') }))).job.gameDate).toBe('2026-11-02');
    expect(await service.createJob(request({ gameDate: date('2026-11-03') }))).toMatchObject({ kind: 'rejected', reason: 'date_too_far' });
    expect(await service.createJob(request({ gameDate: date('2027-10-20') }))).toMatchObject({ kind: 'rejected', reason: 'date_too_far' });
  });

  it('uses the club calendar day, not the UTC day (00:30 in Madrid is still the previous day in UTC)', async () => {
    const { service } = harness({ now: Date.UTC(2026, 9, 12, 22, 30, 0) });
    expect(await service.createJob(request({ gameDate: date('2026-10-12') }))).toMatchObject({ reason: 'date_in_past' });
    expect(created(await service.createJob(request({ gameDate: date('2026-10-13') }))).job.gameDate).toBe('2026-10-13');
  });

  it('keeps the last club minute of a day on that day (only its start times are gone), and rolls over at local midnight', async () => {
    const lateEvening = harness({ now: Date.UTC(2026, 9, 13, 21, 59, 59) });
    expect(await lateEvening.service.createJob(request({ gameDate: date('2026-10-13') }))).toMatchObject({ reason: 'invalid_input' });
    expect(created(await lateEvening.service.createJob(request({ gameDate: date('2026-10-14') }))).job.gameDate).toBe('2026-10-14');
    const midnight = harness({ now: Date.UTC(2026, 9, 13, 22, 0, 0) });
    expect(await midnight.service.createJob(request({ gameDate: date('2026-10-13') }))).toMatchObject({ reason: 'date_in_past' });
  });

  it('measures the 20-day limit in calendar days across the end of daylight saving time (25 Oct 2026)', async () => {
    const { service } = harness({ now: Date.UTC(2026, 9, 24, 12, 0, 0) });
    expect(created(await service.createJob(request({ gameDate: date('2026-11-13') }))).job.gameDate).toBe('2026-11-13');
    expect(await service.createJob(request({ gameDate: date('2026-11-14') }))).toMatchObject({ reason: 'date_too_far' });
  });

  it('checks the date before the courts and before any network call', async () => {
    const { service, api } = harness();
    const result = await service.createJob(request({ gameDate: date('2026-10-12'), choices: [{ courtId: 1, startMinutes: 600 }] }));
    expect(result).toMatchObject({ reason: 'date_in_past' });
    expect(api.getDay).not.toHaveBeenCalled();
  });
});

describe('createJob: court_not_allowed', () => {
  it.each([1, 2, 3, 7, 8])('rejects academy court %i on a weekday', async (courtId) => {
    const { service, store } = harness();
    const result = await service.createJob(request({ choices: [{ courtId, startMinutes: 600 }] }));
    expect(result).toMatchObject({ kind: 'rejected', reason: 'court_not_allowed' });
    expect(store.list()).toEqual([]);
  });

  it.each([4, 9, 10, 11, 12])('allows court %i on a weekday', async (courtId) => {
    const { service } = harness();
    created(await service.createJob(request({ choices: [{ courtId, startMinutes: 600 }] })));
  });

  it('rejects ids that are not courts at all', async () => {
    const { service } = harness();
    for (const courtId of [5, 6, 13, 999]) {
      expect(await service.createJob(request({ choices: [{ courtId, startMinutes: 600 }] }))).toMatchObject({ reason: 'court_not_allowed' });
    }
  });

  it('allows every court on a weekend', async () => {
    const { service } = harness();
    const choices = [1, 2, 3, 4, 7, 8, 9, 10, 11, 12].map((courtId) => ({ courtId, startMinutes: 600 }));
    expect(created(await service.createJob(request({ gameDate: date('2026-10-17'), choices }))).job.choices.length).toBe(10);
  });

  it('allows every court on an official holiday but not on the ordinary day before it', async () => {
    const { service } = harness({ now: Date.UTC(2026, 10, 25, 6, 0, 0) });
    const academy = [{ courtId: 1, startMinutes: 600 }];
    expect(created(await service.createJob(request({ gameDate: date('2026-12-08'), choices: academy }))).job.gameDate).toBe('2026-12-08');
    expect(await service.createJob(request({ gameDate: date('2026-12-07'), choices: academy }))).toMatchObject({ reason: 'court_not_allowed' });
  });

  it('follows the injected holiday set (EXTRA_HOLIDAYS)', async () => {
    const withHoliday = harness({ holidays: new Set([date('2026-10-21')]) });
    expect(created(await withHoliday.service.createJob(request({ gameDate: date('2026-10-21'), choices: [{ courtId: 1, startMinutes: 600 }] }))).job.id).toBe(1);
    const without = harness({ holidays: new Set() });
    expect(await without.service.createJob(request({ gameDate: date('2026-10-21'), choices: [{ courtId: 1, startMinutes: 600 }] }))).toMatchObject({
      reason: 'court_not_allowed',
    });
  });

  it('one forbidden court rejects the whole request and names it', async () => {
    const { service, store } = harness();
    const result = await service.createJob(request({ choices: [{ courtId: 9, startMinutes: 600 }, { courtId: 7, startMinutes: 600 }] }));
    expect(result).toMatchObject({ kind: 'rejected', reason: 'court_not_allowed' });
    expect((result as { detail: string }).detail).toContain('7');
    expect(store.list()).toEqual([]);
  });
});

describe('createJob: duplicate_active_job', () => {
  it('rejects a second job for a date that already has an active one, without calling the site', async () => {
    const { service, store, api } = harness();
    created(await service.createJob(request({ gameDate: date('2026-10-21') })));
    const result = await service.createJob(request({ gameDate: date('2026-10-21'), choices: [{ courtId: 10, startMinutes: 600 }] }));
    expect(result).toMatchObject({ kind: 'rejected', reason: 'duplicate_active_job' });
    expect(store.list().length).toBe(1);
    expect(api.getWallet).toHaveBeenCalledTimes(1);
  });

  it.each(['scheduled', 'warming', 'firing', 'booked', 'needs_payment'] as const)('a %s job blocks its date', async (state) => {
    const { service, store, api } = harness();
    const { job } = created(await service.createJob(request()));
    driveTo(store, job.id, state);
    api.getDay.mockResolvedValue(emptyDay(date('2026-10-20'), true));
    expect(await service.createJob(request())).toMatchObject({ reason: 'duplicate_active_job' });
    expect(store.get(job.id)?.state).toBe(state);
  });

  it.each(['failed', 'cancelled', 'expired'] as const)('a %s job does not block its date', async (state) => {
    const { service, store } = harness();
    const { job } = created(await service.createJob(request()));
    driveTo(store, job.id, state);
    expect(created(await service.createJob(request())).job.id).toBe(job.id + 1);
  });

  it('maps a DuplicateActiveJobError raised by the store (lost race) to the same rejection', async () => {
    const { service, store } = harness({
      wrapStore: (real): JobStore => ({
        create: () => {
          throw new DuplicateActiveJobError(date('2026-10-20'));
        },
        get: (id) => real.get(id),
        list: () => [],
        transition: (...args) => real.transition(...args),
        isStopped: () => real.isStopped(),
        setStopped: (stopped) => real.setStopped(stopped),
      }),
    });
    expect(await service.createJob(request())).toMatchObject({ kind: 'rejected', reason: 'duplicate_active_job' });
    expect(store.list()).toEqual([]);
  });

  it('lets unexpected store failures through instead of masking them as a rejection', async () => {
    const { service } = harness({
      wrapStore: (real): JobStore => ({
        create: () => {
          throw new Error('disk is full');
        },
        get: (id) => real.get(id),
        list: () => real.list(),
        transition: (...args) => real.transition(...args),
        isStopped: () => real.isStopped(),
        setStopped: (stopped) => real.setStopped(stopped),
      }),
    });
    await expect(service.createJob(request())).rejects.toThrow('disk is full');
  });
});

describe('createJob: own_booking_exists', () => {
  it('rejects when the account already holds a booking on that open day', async () => {
    const { service, store, api } = harness();
    api.getDay.mockResolvedValue(emptyDay(date('2026-10-20'), true));
    const result = await service.createJob(request());
    expect(result).toMatchObject({ kind: 'rejected', reason: 'own_booking_exists' });
    expect(store.list()).toEqual([]);
    expect(api.getWallet).not.toHaveBeenCalled();
    expect(api.quote).not.toHaveBeenCalled();
  });

  it('is satisfied by a booking on any court of that day', async () => {
    const { service, api } = harness();
    const day = emptyDay(date('2026-10-20'));
    api.getDay.mockResolvedValue({
      ...day,
      courts: day.courts.map((court) => ({
        ...court,
        slots: court.slots.map((slot) => (court.courtId === 10 ? { ...slot, free: false, ownBooking: true } : slot)),
      })),
    });
    expect(await service.createJob(request())).toMatchObject({ reason: 'own_booking_exists' });
  });

  it('ignores other people\'s bookings (taken but not ours)', async () => {
    const { service, api } = harness();
    const day = emptyDay(date('2026-10-20'));
    api.getDay.mockResolvedValue({
      ...day,
      courts: day.courts.map((court) => ({ ...court, slots: court.slots.map((slot) => ({ ...slot, free: false, ownBooking: false })) })),
    });
    created(await service.createJob(request()));
  });

  it('is only checked for a date that is already open', async () => {
    const { service, api } = harness();
    api.getDay.mockResolvedValue(emptyDay(date('2026-10-21'), true));
    created(await service.createJob(request({ gameDate: date('2026-10-21') })));
    expect(api.getDay).not.toHaveBeenCalled();
  });

  it('does not block creation when the check itself fails (the form gate decides later) and logs only the error class', async () => {
    const { service, api, logger } = harness();
    api.getDay.mockRejectedValue(new Error('SECRET-RESPONSE-BODY'));
    created(await service.createJob(request()));
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.dump()).not.toContain('SECRET-RESPONSE-BODY');
  });
});
