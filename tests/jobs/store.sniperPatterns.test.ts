/**
 * The exact calls the sniper makes (src/sniper/fire.ts, fireFinish.ts, recovery.ts), replayed on the real store.
 * A lost race is `undefined`; only unknown state names throw.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JobState } from '../../src/contracts.js';
import { InvalidJobInputError } from '../../src/jobs/errors.js';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { cleanupTemp, date, driveTo, newJob, NOW, track } from './_helpers.js';

afterEach(cleanupTemp);

const OPENS = Date.UTC(2026, 9, 13, 5, 0, 0);
const openStore = (): SqliteJobStore => track(new SqliteJobStore(':memory:'));

/** fireFinish.ts LATE_BOOKING_FROM: where a booking that exists on the site may be recorded from. */
const LATE_BOOKING_FROM: readonly JobState[] = ['scheduled', 'warming', 'cancelled', 'failed', 'expired'];

describe('counting attempts (firing -> firing)', () => {
  it('adds the delta and keeps the job firing', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    driveTo(store, job.id, 'firing');
    expect(store.transition(job.id, 'firing', 'firing', NOW + 1, { attemptsDelta: 1 })).toMatchObject({ state: 'firing', attempts: 1 });
    expect(store.transition(job.id, 'firing', 'firing', NOW + 2, { attemptsDelta: 1 })).toMatchObject({ state: 'firing', attempts: 2 });
    expect(store.get(job.id)).toMatchObject({ state: 'firing', attempts: 2, updatedAtMs: NOW + 2 });
  });

  it('on a job that is no longer firing it is a lost race (undefined), never an exception', () => {
    for (const state of ['scheduled', 'warming', 'failed', 'booked'] as const) {
      const store = openStore();
      const job = store.create(newJob(), OPENS, NOW);
      driveTo(store, job.id, state);
      expect(store.transition(job.id, 'firing', 'firing', NOW + 1, { attemptsDelta: 1 }), state).toBeUndefined();
      expect(store.get(job.id)?.attempts, state).toBe(0);
    }
  });
});

describe('re-arming an interrupted job (firing -> scheduled)', () => {
  it('keeps the attempts and the date occupied', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    driveTo(store, job.id, 'firing');
    store.transition(job.id, 'firing', 'firing', NOW + 1, { attemptsDelta: 1 });
    expect(store.transition(job.id, 'firing', 'scheduled', NOW + 2)).toMatchObject({ state: 'scheduled', attempts: 1 });
    expect(store.list({ states: ['scheduled'] })).toHaveLength(1);
  });
});

describe('recording a booking that exists on the site', () => {
  it.each(['booked', 'needs_payment'] as const)('records a late %s from every state the sniper tries', (target) => {
    for (const from of LATE_BOOKING_FROM) {
      const store = openStore();
      const job = store.create(newJob(), OPENS, NOW);
      driveTo(store, job.id, from);
      const recorded = store.transition(job.id, LATE_BOOKING_FROM, target, NOW + 9, {
        reservationId: 7,
        bookedChoice: { courtId: 9, startMinutes: 1080 },
      });
      expect(recorded, from).toMatchObject({ state: target, reservationId: 7, bookedChoice: { courtId: 9, startMinutes: 1080 } });
    }
  });

  it('is refused (undefined, nothing changed) while another active job holds the date', () => {
    for (const from of ['failed', 'cancelled', 'expired'] as const) {
      const store = openStore();
      const old = store.create(newJob(), OPENS, NOW);
      const start = driveTo(store, old.id, from);
      const holder = store.create(newJob(), OPENS, NOW);
      expect(store.transition(old.id, LATE_BOOKING_FROM, 'booked', NOW + 9, { reservationId: 7 }), from).toBeUndefined();
      expect(store.get(old.id), from).toEqual(start);
      expect(store.get(holder.id)?.state).toBe('scheduled');
    }
  });

  it('is not repeated: a booked job stays booked and nothing else is recorded over it', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    const booked = driveTo(store, job.id, 'booked');
    const everything: readonly JobState[] = [...LATE_BOOKING_FROM, 'firing', 'booked', 'needs_payment'];
    for (const to of ['booked', 'needs_payment', 'failed', 'cancelled', 'scheduled', 'warming', 'firing'] as const) {
      expect(store.transition(job.id, everything, to, NOW + 9, { reservationId: 3 }), to).toBeUndefined();
    }
    expect(store.get(job.id)).toEqual(booked);
  });
});

describe('a fractional clock reading never vetoes a record', () => {
  it('rounds nowMs on the booking transition instead of throwing before the database is touched', () => {
    const store = openStore();
    const job = store.create(newJob(), OPENS, NOW);
    driveTo(store, job.id, 'firing');
    const booked = store.transition(job.id, 'firing', 'booked', NOW + 0.5, { reservationId: 7 });
    expect(booked).toMatchObject({ state: 'booked', reservationId: 7, updatedAtMs: NOW + 1 });
  });

  it('rounds nowMs on create too, but still rejects non-finite and negative readings', () => {
    const store = openStore();
    expect(store.create(newJob(), OPENS, NOW + 0.4)).toMatchObject({ createdAtMs: NOW, updatedAtMs: NOW });
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => store.create(newJob({ gameDate: date('2026-10-21') }), OPENS, bad), String(bad)).toThrow(InvalidJobInputError);
    }
    expect(store.list()).toHaveLength(1);
  });
});
