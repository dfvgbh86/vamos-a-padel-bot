import { afterEach, describe, expect, it } from 'vitest';
import { ACTIVE_JOB_STATES, DuplicateActiveJobError, type JobState } from '../../src/contracts.js';
import { InvalidTransitionError } from '../../src/jobs/errors.js';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { ALLOWED_TRANSITIONS, canTransition, JOB_STATES, TERMINAL_JOB_STATES } from '../../src/jobs/transitions.js';
import { cleanupTemp, date, driveTo, newJob, NOW, tempDbPath, track } from './_helpers.js';

afterEach(cleanupTemp);

const OPENS = Date.UTC(2026, 9, 13, 5, 0, 0);
const openStore = (): SqliteJobStore => track(new SqliteJobStore(':memory:'));

const pairs = JOB_STATES.flatMap((from) => JOB_STATES.map((to) => [from, to] as const));

describe('store enforces the transition matrix (every from -> to pair)', () => {
  it.each(pairs)('%s -> %s', (from, to) => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    const start = driveTo(store, job.id, from);
    expect(start.state).toBe(from);

    if (canTransition(from, to)) {
      const moved = store.transition(job.id, from, to, NOW + 1_000);
      expect(moved?.state).toBe(to);
      expect(store.get(job.id)?.state).toBe(to);
      expect(moved?.updatedAtMs).toBe(NOW + 1_000);
    } else {
      expect(store.transition(job.id, from, to, NOW + 1_000)).toBeUndefined();
      expect(store.get(job.id)).toEqual(start);
    }
  });

  it('a forbidden pair never reaches the database, whatever the current state is', () => {
    for (const current of JOB_STATES) {
      for (const to of JOB_STATES) {
        const store = openStore();
        const job = store.create(newJob(), OPENS, NOW);
        const start = driveTo(store, job.id, current);
        const sources = JOB_STATES.filter((from) => !canTransition(from, to));
        if (sources.length === 0) continue;
        const tamper = { failureReason: 'tamper', attemptsDelta: 2 };
        expect(store.transition(job.id, sources, to, NOW + 5, tamper), `${current}->${to}`).toBeUndefined();
        expect(store.get(job.id), `${current}->${to}`).toEqual(start);
      }
    }
  });

  it('a finished job changes only to record a booking, even through a lying `from` list that names every state', () => {
    for (const terminal of TERMINAL_JOB_STATES) {
      for (const to of JOB_STATES) {
        const store = openStore();
        const job = store.create(newJob(), OPENS, NOW);
        const start = driveTo(store, job.id, terminal);
        const result = store.transition(job.id, [...JOB_STATES], to, NOW + 7, { failureReason: 'tamper', reservationId: 9 });
        if (to === 'booked' || to === 'needs_payment') {
          expect(result?.state, `${terminal}->${to}`).toBe(to);
          expect(result?.reservationId).toBe(9);
        } else {
          expect(result, `${terminal}->${to}`).toBeUndefined();
          expect(store.get(job.id), `${terminal}->${to}`).toEqual(start);
        }
      }
    }
  });

  it('a `from` list is intersected with the matrix: illegal sources are ignored, legal ones still apply', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    expect(store.transition(job.id, ['booked', 'scheduled', 'firing'], 'warming', NOW + 1)?.state).toBe('warming');
    expect(store.transition(job.id, ['booked', 'scheduled', 'firing'], 'warming', NOW + 2)).toBeUndefined();
  });

  it('rejects unknown state names and an empty `from` list before touching the database', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    expect(() => store.transition(job.id, 'scheduled', 'done' as JobState, NOW)).toThrow(InvalidTransitionError);
    expect(() => store.transition(job.id, 'nope' as JobState, 'warming', NOW)).toThrow(InvalidTransitionError);
    expect(() => store.transition(job.id, ['scheduled', 'nope' as JobState], 'warming', NOW)).toThrow(InvalidTransitionError);
    expect(() => store.transition(job.id, [], 'warming', NOW)).toThrow(InvalidTransitionError);
    expect(store.get(job.id)?.state).toBe('scheduled');
  });

  it('every active state can expire, and an expired job frees its date', () => {
    for (const state of ACTIVE_JOB_STATES) {
      const store = openStore();
      const job = store.create(newJob(), OPENS, NOW);
      driveTo(store, job.id, state);
      expect(store.transition(job.id, ACTIVE_JOB_STATES, 'expired', NOW + 1)?.state, state).toBe('expired');
      expect(store.create(newJob(), OPENS, NOW + 2).state).toBe('scheduled');
    }
  });

  it('warming can be re-armed to scheduled and keeps its date occupied', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    driveTo(store, job.id, 'warming');
    expect(store.transition(job.id, 'warming', 'scheduled', NOW + 1)?.state).toBe('scheduled');
    expect(() => store.create(newJob(), OPENS, NOW)).toThrow(DuplicateActiveJobError);
  });

  it('a finished job can only come back to record a booking (it cannot be revived into any other state)', () => {
    for (const from of TERMINAL_JOB_STATES) expect(ALLOWED_TRANSITIONS[from]).toEqual(['booked', 'needs_payment']);
  });
});

describe('two connections to one database file (optimistic concurrency)', () => {
  const openPair = () => {
    const path = tempDbPath();
    return [track(new SqliteJobStore(path)), track(new SqliteJobStore(path))] as const;
  };

  it('a job created through one connection is immediately visible through the other', () => {
    const [a, b] = openPair();
    const job = a.create(newJob(), OPENS, NOW);
    expect(b.get(job.id)).toEqual(job);
    expect(b.list()).toEqual([job]);
  });

  it('exactly one of two racing transitions wins, whichever connection goes first', () => {
    for (let round = 0; round < 25; round += 1) {
      const [a, b] = openPair();
      const job = a.create(newJob(), OPENS, NOW);
      const [first, second] = round % 2 === 0 ? [a, b] : [b, a];
      const results = [
        first.transition(job.id, 'scheduled', 'warming', NOW + 1, { attemptsDelta: 1 }),
        second.transition(job.id, 'scheduled', 'cancelled', NOW + 2, { attemptsDelta: 10 }),
      ];
      expect(results.filter((result) => result !== undefined).length).toBe(1);
      expect(a.get(job.id)).toEqual(b.get(job.id));
      expect(a.get(job.id)?.attempts).toBe(1);
      expect(a.get(job.id)?.state).toBe('warming');
    }
  });

  it('a stale cancel from one connection cannot undo the sniper progress made on the other', () => {
    const [sniper, bot] = openPair();
    const job = sniper.create(newJob(), OPENS, NOW);
    expect(bot.get(job.id)?.state).toBe('scheduled');
    driveTo(sniper, job.id, 'firing');
    expect(bot.transition(job.id, ['scheduled', 'warming'], 'cancelled', NOW + 5)).toBeUndefined();
    expect(sniper.transition(job.id, 'firing', 'booked', NOW + 6, { reservationId: 5 })?.state).toBe('booked');
  });

  it('only one connection can create the active job for a date', () => {
    const [a, b] = openPair();
    a.create(newJob(), OPENS, NOW);
    expect(() => b.create(newJob(), OPENS, NOW)).toThrow(DuplicateActiveJobError);
    expect(b.create(newJob({ gameDate: date('2026-10-21') }), OPENS, NOW).id).toBe(2);
    expect(a.list().length).toBe(2);
  });

  it('the emergency stop set through one connection is seen by the other at once', () => {
    const [a, b] = openPair();
    expect(b.isStopped()).toBe(false);
    a.setStopped(true);
    expect(b.isStopped()).toBe(true);
    b.setStopped(false);
    expect(a.isStopped()).toBe(false);
  });
});
