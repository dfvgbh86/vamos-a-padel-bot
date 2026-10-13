import { afterEach, describe, expect, it } from 'vitest';
import { ACTIVE_JOB_STATES, DuplicateActiveJobError, type JobState } from '../../src/contracts.js';
import { InvalidJobInputError } from '../../src/jobs/errors.js';
import { MAX_FAILURE_REASON_LENGTH } from '../../src/jobs/rows.js';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { cleanupTemp, date, driveTo, newJob, NOW, track } from './_helpers.js';

afterEach(cleanupTemp);

const openStore = (): SqliteJobStore => track(new SqliteJobStore(':memory:'));
const OPENS = Date.UTC(2026, 9, 13, 5, 0, 0);

describe('SqliteJobStore.create / get / list', () => {
  it('creates a scheduled job and reads it back unchanged', () => {
    const store = openStore();
    const input = newJob({
      choices: [
        { courtId: 10, startMinutes: 1170 },
        { courtId: 4, startMinutes: 540 },
      ],
      durationMinutes: 120,
      payment: 'card',
    });
    const job = store.create(input, OPENS, NOW);
    expect(job).toEqual({
      id: 1,
      gameDate: '2026-10-20',
      choices: [
        { courtId: 10, startMinutes: 1170 },
        { courtId: 4, startMinutes: 540 },
      ],
      durationMinutes: 120,
      payment: 'card',
      state: 'scheduled',
      opensAtMs: OPENS,
      reservationId: null,
      bookedChoice: null,
      failureReason: null,
      attempts: 0,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    });
    expect(store.get(job.id)).toEqual(job);
  });

  it('keeps the priority order of the choices', () => {
    const store = openStore();
    const choices = [4, 12, 9, 10].map((courtId, index) => ({ courtId, startMinutes: 600 + index * 30 }));
    expect(store.create(newJob({ choices }), OPENS, NOW).choices).toEqual(choices);
  });

  it('ignores extra properties on the input instead of persisting them', () => {
    const store = openStore();
    const polluted = { ...newJob(), password: 'x', choices: [{ courtId: 9, startMinutes: 1080, note: 'x' }] };
    const job = store.create(polluted as never, OPENS, NOW);
    expect(Object.keys(job).sort()).toEqual(
      ['attempts', 'bookedChoice', 'choices', 'createdAtMs', 'durationMinutes', 'failureReason', 'gameDate', 'id', 'opensAtMs', 'payment', 'reservationId', 'state', 'updatedAtMs'],
    );
    expect(job.choices).toEqual([{ courtId: 9, startMinutes: 1080 }]);
  });

  it('assigns increasing ids', () => {
    const store = openStore();
    const ids = ['2026-10-20', '2026-10-21', '2026-10-22'].map((day) => store.create(newJob({ gameDate: date(day) }), OPENS, NOW).id);
    expect(ids).toEqual([1, 2, 3]);
  });

  it('returns undefined for a missing or malformed id', () => {
    const store = openStore();
    store.create(newJob(), OPENS, NOW);
    for (const id of [0, 2, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1' as unknown as number, undefined as unknown as number]) {
      expect(store.get(id), String(id)).toBeUndefined();
    }
  });

  it('lists everything oldest first, newest last', () => {
    const store = openStore();
    for (const day of ['2026-10-22', '2026-10-20', '2026-10-21']) store.create(newJob({ gameDate: date(day) }), OPENS, NOW);
    expect(store.list().map((job) => job.gameDate)).toEqual(['2026-10-22', '2026-10-20', '2026-10-21']);
    expect(store.list().map((job) => job.id)).toEqual([1, 2, 3]);
    expect(store.list({}).length).toBe(3);
  });

  it('filters by states (any of them) and returns an empty list for an empty filter', () => {
    const store = openStore();
    const jobs = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'].map((day) => store.create(newJob({ gameDate: date(day) }), OPENS, NOW));
    driveTo(store, jobs[1]!.id, 'warming');
    driveTo(store, jobs[2]!.id, 'cancelled');
    driveTo(store, jobs[3]!.id, 'booked');
    expect(store.list({ states: ['scheduled'] }).map((job) => job.id)).toEqual([1]);
    expect(store.list({ states: ['warming', 'cancelled'] }).map((job) => job.id)).toEqual([2, 3]);
    expect(store.list({ states: ['warming', 'warming'] }).map((job) => job.id)).toEqual([2]);
    expect(store.list({ states: [] })).toEqual([]);
    expect(store.list({ states: ACTIVE_JOB_STATES }).map((job) => job.id)).toEqual([1, 2, 4]);
    expect(store.list({ states: ['expired'] })).toEqual([]);
  });

  it('rejects unknown states in a filter', () => {
    const store = openStore();
    expect(() => store.list({ states: ['done' as JobState] })).toThrow(InvalidJobInputError);
    expect(() => store.list({ states: 'scheduled' as unknown as JobState[] })).toThrow(InvalidJobInputError);
  });
});

describe('SqliteJobStore.create validation', () => {
  const cases: readonly [string, () => Parameters<SqliteJobStore['create']>][] = [
    ['an empty choice list', () => [newJob({ choices: [] }), OPENS, NOW]],
    [
      'duplicate choices',
      () => [newJob({ choices: [{ courtId: 9, startMinutes: 1080 }, { courtId: 9, startMinutes: 1080 }] }), OPENS, NOW],
    ],
    ['a start time out of range', () => [newJob({ choices: [{ courtId: 9, startMinutes: 1440 }] }), OPENS, NOW]],
    ['a negative start time', () => [newJob({ choices: [{ courtId: 9, startMinutes: -1 }] }), OPENS, NOW]],
    ['a fractional start time', () => [newJob({ choices: [{ courtId: 9, startMinutes: 10.5 }] }), OPENS, NOW]],
    ['a non-positive court id', () => [newJob({ choices: [{ courtId: 0, startMinutes: 600 }] }), OPENS, NOW]],
    ['an unknown payment mode', () => [newJob({ payment: 'cash' as never }), OPENS, NOW]],
    ['a missing payment mode', () => [newJob({ payment: undefined as never }), OPENS, NOW]],
    ['a malformed game date', () => [newJob({ gameDate: '2026-2-30' as never }), OPENS, NOW]],
    ['an impossible game date', () => [newJob({ gameDate: '2026-02-30' as never }), OPENS, NOW]],
    ['a zero duration', () => [newJob({ durationMinutes: 0 }), OPENS, NOW]],
    ['a duration longer than a day', () => [newJob({ durationMinutes: 1441 }), OPENS, NOW]],
    ['a NaN opening time', () => [newJob(), Number.NaN, NOW]],
    ['a negative opening time', () => [newJob(), -5, NOW]],
    ['an infinite now', () => [newJob(), OPENS, Number.POSITIVE_INFINITY]],
    ['a string now', () => [newJob(), OPENS, String(NOW) as never]],
    ['null instead of a job', () => [null as never, OPENS, NOW]],
  ];

  it.each(cases)('rejects %s and stores nothing', (_label, args) => {
    const store = openStore();
    expect(() => store.create(...args())).toThrow(InvalidJobInputError);
    expect(store.list()).toEqual([]);
  });

  it('names the offending fields but never echoes the offending values', () => {
    const store = openStore();
    try {
      store.create(newJob({ payment: 'SECRET-PAYMENT-VALUE' as never, gameDate: 'SECRET-DATE-VALUE' as never }), OPENS, NOW);
      expect.unreachable('create must throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('job.payment');
      expect(message).toContain('job.gameDate');
      expect(message).not.toContain('SECRET');
    }
  });
});

describe('one active job per game date (partial unique index)', () => {
  it('rejects a second active job for the same date with DuplicateActiveJobError', () => {
    const store = openStore();
    store.create(newJob(), OPENS, NOW);
    const attempt = (): unknown => store.create(newJob({ choices: [{ courtId: 4, startMinutes: 600 }] }), OPENS, NOW);
    expect(attempt).toThrow(DuplicateActiveJobError);
    try {
      attempt();
    } catch (error) {
      expect((error as DuplicateActiveJobError).gameDate).toBe('2026-10-20');
    }
    expect(store.list().length).toBe(1);
  });

  it.each(ACTIVE_JOB_STATES)('a job in state %s still occupies its date', (state) => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    driveTo(store, job.id, state);
    expect(() => store.create(newJob(), OPENS, NOW)).toThrow(DuplicateActiveJobError);
    expect(store.list().length).toBe(1);
  });

  it.each(['failed', 'cancelled', 'expired'] as const)('a %s job frees its date for a new job', (state) => {
    const store = openStore();
    const first = store.create(newJob(), OPENS, NOW);
    driveTo(store, first.id, state);
    const second = store.create(newJob(), OPENS, NOW);
    expect(second.id).toBe(first.id + 1);
    expect(second.state).toBe('scheduled');
    expect(() => store.create(newJob(), OPENS, NOW)).toThrow(DuplicateActiveJobError);
  });

  it('allows any number of finished jobs for one date next to one active job', () => {
    const store = openStore();
    for (const state of ['failed', 'cancelled', 'expired', 'failed'] as const) {
      driveTo(store, store.create(newJob(), OPENS, NOW).id, state);
    }
    store.create(newJob(), OPENS, NOW);
    expect(store.list().length).toBe(5);
    expect(store.list({ states: ACTIVE_JOB_STATES }).length).toBe(1);
  });

  it('does not block different dates', () => {
    const store = openStore();
    store.create(newJob({ gameDate: date('2026-10-20') }), OPENS, NOW);
    expect(store.create(newJob({ gameDate: date('2026-10-21') }), OPENS, NOW).id).toBe(2);
  });

  it('a failed create burns no data: the next id continues and nothing half-written remains', () => {
    const store = openStore();
    store.create(newJob(), OPENS, NOW);
    expect(() => store.create(newJob(), OPENS, NOW)).toThrow(DuplicateActiveJobError);
    expect(store.create(newJob({ gameDate: date('2026-10-21') }), OPENS, NOW).id).toBe(2);
    expect(store.list().map((job) => job.gameDate)).toEqual(['2026-10-20', '2026-10-21']);
  });
});

describe('SqliteJobStore.transition', () => {
  it('applies the transition, returns the updated job and bumps only updatedAtMs', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    const moved = store.transition(job.id, 'scheduled', 'warming', NOW + 5000);
    expect(moved).toEqual({ ...job, state: 'warming', updatedAtMs: NOW + 5000 });
    expect(store.get(job.id)).toEqual(moved);
  });

  it('accepts a list of source states', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    expect(store.transition(job.id, ['warming', 'scheduled'], 'cancelled', NOW + 1)?.state).toBe('cancelled');
  });

  it('returns undefined and changes nothing when the job is in another state', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    driveTo(store, job.id, 'warming');
    const before = store.get(job.id);
    const result = store.transition(job.id, 'scheduled', 'cancelled', NOW + 99, { attemptsDelta: 5, failureReason: 'nope' });
    expect(result).toBeUndefined();
    expect(store.get(job.id)).toEqual(before);
  });

  it('returns undefined for a missing job or a malformed id', () => {
    const store = openStore();
    store.create(newJob(), OPENS, NOW);
    for (const id of [99, 0, -1, 1.5, Number.NaN]) {
      expect(store.transition(id, 'scheduled', 'warming', NOW), String(id)).toBeUndefined();
    }
    expect(store.get(1)?.state).toBe('scheduled');
  });

  it('stores reservation id, booked choice and failure reason from the patch', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    driveTo(store, job.id, 'firing');
    const booked = store.transition(job.id, 'firing', 'booked', NOW + 10, {
      reservationId: 100002,
      bookedChoice: { courtId: 10, startMinutes: 1080 },
    });
    expect(booked?.reservationId).toBe(100002);
    expect(booked?.bookedChoice).toEqual({ courtId: 10, startMinutes: 1080 });
    expect(booked?.failureReason).toBeNull();

    const second = store.create(newJob({ gameDate: date('2026-10-21') }), OPENS, NOW);
    driveTo(store, second.id, 'firing');
    const failed = store.transition(second.id, 'firing', 'failed', NOW + 10, { failureReason: 'window closed' });
    expect(failed?.failureReason).toBe('window closed');
    expect(failed?.reservationId).toBeNull();
    expect(failed?.bookedChoice).toBeNull();
  });

  it('adds attemptsDelta to attempts across transitions and keeps other fields when the patch omits them', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    expect(store.transition(job.id, 'scheduled', 'warming', NOW, { attemptsDelta: 0 })?.attempts).toBe(0);
    expect(store.transition(job.id, 'warming', 'firing', NOW, { attemptsDelta: 1 })?.attempts).toBe(1);
    expect(store.transition(job.id, 'firing', 'needs_payment', NOW, { attemptsDelta: 2, reservationId: 7 })?.attempts).toBe(3);
    const paid = store.transition(job.id, 'needs_payment', 'booked', NOW + 1, { bookedChoice: { courtId: 9, startMinutes: 1080 } });
    expect(paid?.attempts).toBe(3);
    expect(paid?.reservationId).toBe(7);
  });

  it('treats explicit undefined patch fields like absent ones', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    const moved = store.transition(job.id, 'scheduled', 'warming', NOW, {
      reservationId: undefined,
      bookedChoice: undefined,
      failureReason: undefined,
      attemptsDelta: undefined,
    });
    expect(moved?.attempts).toBe(0);
    expect(moved?.reservationId).toBeNull();
  });

  it('truncates an oversized failure reason', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    const failed = store.transition(job.id, 'scheduled', 'failed', NOW, { failureReason: 'x'.repeat(5000) });
    expect(failed?.failureReason).toBe('x'.repeat(MAX_FAILURE_REASON_LENGTH));
  });

  const badPatches: readonly [string, Record<string, unknown>][] = [
    ['a negative attemptsDelta', { attemptsDelta: -1 }],
    ['a fractional attemptsDelta', { attemptsDelta: 0.5 }],
    ['a NaN attemptsDelta', { attemptsDelta: Number.NaN }],
    ['a zero reservationId', { reservationId: 0 }],
    ['a string reservationId', { reservationId: '12' }],
    ['a malformed bookedChoice', { bookedChoice: { courtId: 'x', startMinutes: 5 } }],
    ['an out-of-range bookedChoice', { bookedChoice: { courtId: 9, startMinutes: 2000 } }],
    ['a non-string failureReason', { failureReason: 42 }],
  ];

  it.each(badPatches)('rejects %s without touching the row', (_label, patch) => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    expect(() => store.transition(job.id, 'scheduled', 'warming', NOW + 1, patch as never)).toThrow(InvalidJobInputError);
    expect(store.get(job.id)).toEqual(job);
  });

  it('rejects a bad nowMs or a null patch without touching the row', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, '5' as unknown as number]) {
      expect(() => store.transition(job.id, 'scheduled', 'warming', bad), String(bad)).toThrow(InvalidJobInputError);
    }
    expect(() => store.transition(job.id, 'scheduled', 'warming', NOW, null as never)).toThrow(InvalidJobInputError);
    expect(store.get(job.id)).toEqual(job);
  });

  it('is optimistic: of two competing transitions from the same state exactly one wins', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    const first = store.transition(job.id, 'scheduled', 'warming', NOW + 1);
    const second = store.transition(job.id, 'scheduled', 'cancelled', NOW + 2);
    expect(first?.state).toBe('warming');
    expect(second).toBeUndefined();
    expect(store.get(job.id)?.state).toBe('warming');
  });

  it('a stale reader cannot overwrite a newer state (cancel after the sniper moved on)', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    const staleView = store.get(job.id);
    driveTo(store, job.id, 'firing');
    expect(staleView?.state).toBe('scheduled');
    expect(store.transition(job.id, ['scheduled', 'warming'], 'cancelled', NOW + 3)).toBeUndefined();
    expect(store.get(job.id)?.state).toBe('firing');
  });
});
