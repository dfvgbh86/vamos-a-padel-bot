import { describe, expect, it } from 'vitest';
import { parseGameDate } from '../../src/config/gameDate.js';
import type { Job } from '../../src/contracts.js';
import { AuthExpiredError } from '../../src/reservaplay/errors.js';
import { UNKNOWN_RESERVATION_ID } from '../../src/sniper/fireTypes.js';
import { gameDayEndsAtMs } from '../../src/sniper/gameDay.js';
import { recoverJobs, type RecoveryDeps } from '../../src/sniper/recovery.js';
import { createSniperRunner } from '../../src/sniper/runner.js';
import { CHOICE_A, CHOICE_B, GAME_DATE, NO_HOLIDAYS, OPENS_AT_MS, gateAt, makeDay, makeJob, makeRig, type ApiScript, type FakeClock } from './_fakes.js';

interface Setup {
  readonly jobs: readonly Partial<Job>[];
  readonly script?: (clock: FakeClock) => ApiScript;
  /** Clock start relative to the opening instant. */
  readonly nowOffsetMs?: number;
}

const setup = (options: Setup) => {
  const rig = makeRig({}, OPENS_AT_MS + (options.nowOffsetMs ?? 10_000));
  rig.api.script = { ...options.script?.(rig.clock) };
  const jobs = options.jobs.map((job, index) => rig.store.insert(makeJob({ id: index + 1, ...job })));
  const deps: RecoveryDeps = { api: rig.api, clock: rig.clock, store: rig.store, events: rig.sink, logger: rig.logger };
  return { ...rig, jobs, deps, run: () => recoverJobs(deps), stored: (id: number) => rig.store.get(id) as Job };
};

const ownCalendar: Pick<ApiScript, 'getDay'> = { getDay: (date) => makeDay(date, { own: [CHOICE_B] }) };
const emptyCalendar: Pick<ApiScript, 'getDay'> = { getDay: (date) => makeDay(date) };

describe('recovery: jobs that were only waiting', () => {
  it('warming goes back to scheduled, without any network traffic or event', async () => {
    const t = setup({ jobs: [{ state: 'warming', updatedAtMs: OPENS_AT_MS - 590_000 }], nowOffsetMs: -300_000 });
    const report = await t.run();
    expect(report).toEqual({ rescheduled: [1], booked: [], expired: [], failed: [] });
    expect(t.stored(1).state).toBe('scheduled');
    expect(t.api.calls).toEqual([]);
    expect(t.sink.events).toEqual([]);
  });

  it('scheduled jobs are left alone, even if their window opened long ago (that is a legitimate "book now")', async () => {
    const t = setup({ jobs: [{ state: 'scheduled' }], nowOffsetMs: 5 * 3_600_000 });
    const report = await t.run();
    expect(report).toEqual({ rescheduled: [], booked: [], expired: [], failed: [] });
    expect(t.stored(1).state).toBe('scheduled');
    expect(t.api.calls).toEqual([]);
  });

  it.each(['scheduled', 'warming'] as const)('a %s job whose game date has passed is expired and the owner is told', async (state) => {
    const t = setup({ jobs: [{ state }], nowOffsetMs: gameDayEndsAtMs(GAME_DATE) - OPENS_AT_MS });
    const report = await t.run();
    expect(report.expired).toEqual([1]);
    expect(t.stored(1)).toMatchObject({ state: 'expired', failureReason: 'game_date_passed' });
    expect(t.sink.kinds()).toEqual(['expired']);
    expect(t.api.calls).toEqual([]);
  });

  it('the last second of the game day is not yet expired', async () => {
    const t = setup({ jobs: [{ state: 'scheduled' }], nowOffsetMs: gameDayEndsAtMs(GAME_DATE) - OPENS_AT_MS - 1 });
    expect((await t.run()).expired).toEqual([]);
  });

  it('terminal jobs are never touched', async () => {
    const t = setup({
      jobs: [{ state: 'booked' }, { state: 'failed' }, { state: 'cancelled' }, { state: 'expired' }, { state: 'needs_payment' }],
      nowOffsetMs: 5 * 86_400_000,
    });
    expect(await t.run()).toEqual({ rescheduled: [], booked: [], expired: [], failed: [] });
    expect(t.store.transitions).toEqual([]);
  });

  it('with nothing to do it does nothing', async () => {
    const t = setup({ jobs: [] });
    expect(await t.run()).toEqual({ rescheduled: [], booked: [], expired: [], failed: [] });
    expect(t.api.calls).toEqual([]);
  });
});

describe('recovery: a job found in `firing`', () => {
  it('no booking request was started (attempts 0) and the window is still plausible: back to scheduled, no network needed', async () => {
    const t = setup({ jobs: [{ state: 'firing', attempts: 0, updatedAtMs: OPENS_AT_MS - 3000 }], nowOffsetMs: 10_000 });
    const report = await t.run();
    expect(report.rescheduled).toEqual([1]);
    expect(t.stored(1).state).toBe('scheduled');
    expect(t.api.calls).toEqual([]);
    expect(t.sink.events).toEqual([]);
  });

  it('no booking request was started but the window is long gone: expired with a note, not re-armed', async () => {
    const t = setup({ jobs: [{ state: 'firing', attempts: 0, updatedAtMs: OPENS_AT_MS - 3000 }], nowOffsetMs: 10 * 60_000 });
    const report = await t.run();
    expect(report.expired).toEqual([1]);
    expect(t.stored(1)).toMatchObject({ state: 'expired', failureReason: 'restart_window_passed' });
    expect(t.sink.kinds()).toEqual(['expired']);
  });

  it('the plausibility window is 90 s after the opening (or after the last update, for a job picked up late)', async () => {
    const edge = setup({ jobs: [{ state: 'firing', updatedAtMs: OPENS_AT_MS - 3000 }], nowOffsetMs: 90_000 });
    expect((await edge.run()).rescheduled).toEqual([1]);
    const past = setup({ jobs: [{ state: 'firing', updatedAtMs: OPENS_AT_MS - 3000 }], nowOffsetMs: 90_001 });
    expect((await past.run()).expired).toEqual([1]);

    const late = setup({ jobs: [{ state: 'firing', updatedAtMs: OPENS_AT_MS + 5 * 3_600_000 }], nowOffsetMs: 5 * 3_600_000 + 30_000 });
    expect((await late.run()).rescheduled).toEqual([1]);
  });

  it('a booking request WAS started and the calendar shows an own booking: booked (id unknown), never fired again', async () => {
    const t = setup({
      jobs: [{ state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS + 1000 }],
      script: () => ownCalendar,
      nowOffsetMs: 60_000,
    });
    const report = await t.run();
    expect(report.booked).toEqual([1]);
    expect(t.stored(1)).toMatchObject({ state: 'booked', reservationId: null, bookedChoice: CHOICE_B, attempts: 1 });
    expect(t.sink.kinds()).toEqual(['booked']);
    expect(t.sink.ofKind('booked')[0]).toMatchObject({ reservationId: UNKNOWN_RESERVATION_ID, choice: CHOICE_B });
    expect(t.api.count('login')).toBe(1);
    expect(t.api.count('book')).toBe(0);
  });

  it('an own booking elsewhere on that day (no wished slot) is NOT claimed: failed with an explicit reason, the owner is told to check', async () => {
    const t = setup({
      jobs: [{ state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS }],
      script: () => ({ getDay: (date) => makeDay(date, { own: [{ courtId: 12, startMinutes: 1170 }] }) }),
    });
    const report = await t.run();
    expect(report.failed).toEqual([1]);
    expect(report.booked).toEqual([]);
    expect(t.stored(1)).toMatchObject({ state: 'failed', failureReason: 'own_booking_elsewhere', bookedChoice: null });
    expect(t.sink.kinds()).toEqual(['ambiguous', 'failed']);
    expect(t.sink.ofKind('ambiguous')[0]?.detail).toContain('not on a wished slot');
    expect(t.api.count('book')).toBe(0);
  });

  it('the same for a card job: no needs_payment is announced for a booking that is not the wished one', async () => {
    const t = setup({
      jobs: [{ state: 'firing', attempts: 1, payment: 'card', updatedAtMs: OPENS_AT_MS }],
      script: () => ({ getDay: (date) => makeDay(date, { own: [{ courtId: 12, startMinutes: 1170 }] }) }),
    });
    await t.run();
    expect(t.stored(1)).toMatchObject({ state: 'failed', failureReason: 'own_booking_elsewhere' });
    expect(t.sink.ofKind('needs_payment')).toEqual([]);
  });

  it('a card job found booked becomes needs_payment', async () => {
    const t = setup({ jobs: [{ state: 'firing', attempts: 1, payment: 'card', updatedAtMs: OPENS_AT_MS }], script: () => ownCalendar });
    await t.run();
    expect(t.stored(1).state).toBe('needs_payment');
    expect(t.sink.kinds()).toEqual(['needs_payment']);
  });

  it('a request may have been in flight when the PC died: it is given 20 s (from the last update) before the calendar is read', async () => {
    const t = setup({
      jobs: [{ state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS + 5000 }],
      script: () => emptyCalendar,
      nowOffsetMs: 7000,
    });
    await t.run();
    expect(t.api.callsOf('getDay')[0]?.atMs).toBeGreaterThanOrEqual(OPENS_AT_MS + 25_000);
    expect(t.clock.maxSleepMs()).toBeLessThanOrEqual(1000);
    expect(t.stored(1).state).toBe('scheduled');
  });

  it('a settle time from the future (clock oddity) never makes it wait longer than 20 s', async () => {
    const t = setup({
      jobs: [{ state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS + 3_600_000 }],
      script: () => emptyCalendar,
      nowOffsetMs: 7000,
    });
    const before = t.clock.nowMs();
    await t.run();
    expect(t.clock.nowMs() - before).toBeLessThanOrEqual(21_000);
  });

  it('request started, nothing in the calendar, window still plausible: back to scheduled (attempts are kept for the cap)', async () => {
    const t = setup({
      jobs: [{ state: 'firing', attempts: 2, updatedAtMs: OPENS_AT_MS }],
      script: () => emptyCalendar,
      nowOffsetMs: 20_000,
    });
    const report = await t.run();
    expect(report.rescheduled).toEqual([1]);
    expect(t.stored(1)).toMatchObject({ state: 'scheduled', attempts: 2 });
  });

  it('request started, nothing in the calendar, window gone: expired', async () => {
    const t = setup({
      jobs: [{ state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS }],
      script: () => emptyCalendar,
      nowOffsetMs: 20 * 60_000,
    });
    expect((await t.run()).expired).toEqual([1]);
    expect(t.stored(1).failureReason).toBe('restart_window_passed');
  });

  it('request started and the calendar cannot be read (login fails): failed, the owner is told to check, NEVER re-armed', async () => {
    const t = setup({
      jobs: [{ state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS }],
      script: () => ({
        login: () => {
          throw new Error('network down');
        },
      }),
      nowOffsetMs: 30_000,
    });
    const report = await t.run();
    expect(report.failed).toEqual([1]);
    expect(t.stored(1)).toMatchObject({ state: 'failed', failureReason: 'recovery_unverified' });
    expect(t.sink.kinds()).toEqual(['ambiguous', 'failed']);
    expect(t.api.count('login')).toBe(3);
    expect(t.api.count('getDay')).toBe(0);
    expect(t.api.count('book')).toBe(0);
  });

  it('a network that is not up yet at boot: the login is tried three times, four seconds apart, before the job is given up on', async () => {
    const t = setup({
      jobs: [{ state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS }],
      script: () => ({
        login: () => {
          throw new Error('getaddrinfo ENOTFOUND');
        },
      }),
      nowOffsetMs: 30_000,
    });
    await t.run();
    const logins = t.api.callsOf('login').map((call) => call.monoMs);
    expect(logins).toHaveLength(3);
    expect((logins[1] ?? 0) - (logins[0] ?? 0)).toBeGreaterThanOrEqual(4000);
    expect((logins[2] ?? 0) - (logins[1] ?? 0)).toBeGreaterThanOrEqual(4000);
    expect(t.clock.maxSleepMs()).toBeLessThanOrEqual(1000);
  });

  it('one transient login failure at boot no longer fails the job: the second login works and the booking is found', async () => {
    const t = setup({
      jobs: [{ state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS }],
      script: () => ({
        login: (nth) => {
          if (nth === 0) throw new Error('getaddrinfo ENOTFOUND');
        },
        ...ownCalendar,
      }),
      nowOffsetMs: 30_000,
    });
    expect((await t.run()).booked).toEqual([1]);
    expect(t.api.count('login')).toBe(2);
    expect(t.stored(1).state).toBe('booked');
  });

  it('a failed login is remembered for the whole run: several jobs do not each retry it', async () => {
    const t = setup({
      jobs: [
        { state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS, gameDate: parseGameDate('2026-10-20') },
        { state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS, gameDate: parseGameDate('2026-10-21') },
      ],
      script: () => ({
        login: () => {
          throw new Error('down');
        },
      }),
      nowOffsetMs: 30_000,
    });
    expect((await t.run()).failed).toEqual([1, 2]);
    expect(t.api.count('login')).toBe(3);
  });

  it('events that cannot be delivered (hung sink) delay the startup by the flush limit at most', async () => {
    const t = setup({ jobs: [{ state: 'scheduled' }], nowOffsetMs: gameDayEndsAtMs(GAME_DATE) - OPENS_AT_MS });
    t.sink.emit = () => new Promise<void>(() => undefined);
    const started = Date.now();
    const report = await recoverJobs({ ...t.deps, events: t.sink, options: { flushTimeoutMs: 30 } });
    expect(report.expired).toEqual([1]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(t.stored(1).state).toBe('expired');
  });

  it('the calendar read is retried three times, three seconds apart, before giving up', async () => {
    const t = setup({
      jobs: [{ state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS }],
      script: () => ({
        getDay: () => {
          throw new Error('timeout');
        },
      }),
      nowOffsetMs: 30_000,
    });
    const report = await t.run();
    expect(report.failed).toEqual([1]);
    const reads = t.api.callsOf('getDay').map((call) => call.monoMs);
    expect(reads).toHaveLength(3);
    expect((reads[1] ?? 0) - (reads[0] ?? 0)).toBeGreaterThanOrEqual(3000);
    expect((reads[2] ?? 0) - (reads[1] ?? 0)).toBeGreaterThanOrEqual(3000);
  });

  it('a calendar read on a dead session logs in once more and goes on', async () => {
    const t = setup({
      jobs: [{ state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS }],
      script: () => ({
        getDay: (date, nth) => {
          if (nth === 0) throw new AuthExpiredError();
          return makeDay(date, { own: [CHOICE_A] });
        },
      }),
      nowOffsetMs: 30_000,
    });
    expect((await t.run()).booked).toEqual([1]);
    expect(t.api.count('login')).toBe(2);
  });

  it('logs in only once for several jobs, and only if one of them needs the calendar', async () => {
    const t = setup({
      jobs: [
        { state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS, gameDate: parseGameDate('2026-10-20') },
        { state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS, gameDate: parseGameDate('2026-10-21') },
        { state: 'firing', attempts: 0, updatedAtMs: OPENS_AT_MS, gameDate: parseGameDate('2026-10-22') },
      ],
      script: () => emptyCalendar,
      nowOffsetMs: 30_000,
    });
    const report = await t.run();
    expect(report.rescheduled).toEqual([1, 2, 3]);
    expect(t.api.count('login')).toBe(1);
    expect(t.api.callsOf('getDay').map((call) => call.gameDate)).toEqual(['2026-10-20', '2026-10-21']);
  });

  it('events that fail to deliver do not matter: the store is already right and recovery completes', async () => {
    const t = setup({ jobs: [{ state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS }], script: () => ownCalendar, nowOffsetMs: 30_000 });
    t.sink.failWith = new Error('telegram down');
    expect((await t.run()).booked).toEqual([1]);
    expect(t.stored(1).state).toBe('booked');
  });

  it('a job that cannot be recovered because of a store error stays as it is, the rest are recovered', async () => {
    const t = setup({
      jobs: [
        { state: 'firing', attempts: 0, updatedAtMs: OPENS_AT_MS, gameDate: parseGameDate('2026-10-20') },
        { state: 'warming', gameDate: parseGameDate('2026-10-21') },
      ],
      nowOffsetMs: 20_000,
    });
    const original = t.store.transition.bind(t.store);
    t.store.transition = (id, from, to, nowMs, patch) => {
      if (id === 1) throw new Error('database is locked');
      return original(id, from, to, nowMs, patch);
    };
    const report = await t.run();
    expect(report.rescheduled).toEqual([2]);
    expect(t.stored(1).state).toBe('firing');
    expect(t.logger.entries.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('never touches the emergency stop flag', async () => {
    const t = setup({ jobs: [{ state: 'warming' }] });
    t.store.setStopped(true);
    await t.run();
    expect(t.store.isStopped()).toBe(true);
  });
});

describe('recovery then runner: nothing that may already have booked is fired again', () => {
  const restart = (t: ReturnType<typeof setup>) =>
    createSniperRunner({
      api: t.api,
      clock: t.clock,
      store: t.store,
      events: t.sink,
      holidays: NO_HOLIDAYS,
      logger: t.logger,
    });

  it('found booked: the runner ignores the job, no booking request is ever sent', async () => {
    const t = setup({ jobs: [{ state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS }], script: (clock) => ({ ...ownCalendar, probeForm: gateAt(clock, OPENS_AT_MS) }), nowOffsetMs: 30_000 });
    await t.run();
    const runner = restart(t);
    for (let i = 0; i < 30; i++) {
      await runner.tick();
      await t.clock.sleep(1000);
    }
    expect(t.api.count('book')).toBe(0);
    expect(t.api.count('probeForm')).toBe(0);
  });

  it('re-armed after an interrupted request that left no booking: fires again once (the attempt cap still counts the first)', async () => {
    const t = setup({
      jobs: [{ state: 'firing', attempts: 1, updatedAtMs: OPENS_AT_MS }],
      script: (clock) => ({ ...emptyCalendar, probeForm: gateAt(clock, OPENS_AT_MS) }),
      nowOffsetMs: 30_000,
    });
    await t.run();
    expect(t.stored(1).state).toBe('scheduled');
    const runner = restart(t);
    for (let i = 0; i < 40 && t.stored(1).state !== 'booked'; i++) {
      await runner.tick();
      await t.clock.sleep(1000);
    }
    await runner.flushEvents();
    expect(t.stored(1)).toMatchObject({ state: 'booked', attempts: 2 });
    expect(t.api.count('book')).toBe(1);
  });

  it('a job whose attempts are used up fails at the cap instead of sending more', async () => {
    const t = setup({
      jobs: [{ state: 'firing', attempts: 3, updatedAtMs: OPENS_AT_MS }],
      script: (clock) => ({ ...emptyCalendar, probeForm: gateAt(clock, OPENS_AT_MS) }),
      nowOffsetMs: 30_000,
    });
    await t.run();
    const runner = restart(t);
    for (let i = 0; i < 40 && t.stored(1).state === 'scheduled'; i++) {
      await runner.tick();
      await t.clock.sleep(1000);
    }
    expect(t.stored(1)).toMatchObject({ state: 'failed', failureReason: 'max_attempts' });
    expect(t.api.count('book')).toBe(0);
  });
});
