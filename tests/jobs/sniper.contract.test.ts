/**
 * The sniper and the store must agree on the transition matrix: every state change the sniper makes has to be
 * legal for the REAL store, and a lost race has to come back as `undefined`, never as an exception.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, JobState } from '../../src/contracts.js';
import { cleanupTemp, date, emptyDay } from './_helpers.js';
import { makeSniperRig } from './_sniperRig.js';

afterEach(cleanupTemp);

const kinds = (events: readonly { readonly kind: string }[]): string[] => events.map((event) => event.kind);

describe('runFiring against the real store: counting attempts and recording the booking', () => {
  it('counts the attempt (firing -> firing) BEFORE the request leaves, then records the booking', async () => {
    const seen: number[] = [];
    const rig = makeSniperRig({
      book: async () => {
        seen.push(rig.stored(1).attempts);
        return { kind: 'booked', reservationId: 7 };
      },
    });
    const job = rig.job('firing');
    const result = await rig.fire(job);
    expect(result).toMatchObject({ kind: 'booked', reservationId: 7, choice: { courtId: 9, startMinutes: 1080 } });
    expect(seen).toEqual([1]);
    expect(rig.api.booked).toHaveLength(1);
    expect(rig.stored(job.id)).toMatchObject({
      state: 'booked',
      attempts: 1,
      reservationId: 7,
      bookedChoice: { courtId: 9, startMinutes: 1080 },
    });
    expect(kinds(rig.events)).toEqual(['window_open', 'booked']);
    expect(rig.logger.error).not.toHaveBeenCalled();
  });

  it('counts every request when the first answers "not open yet" and the second books', async () => {
    const rig = makeSniperRig({
      book: async (_request, call) =>
        call === 1 ? { kind: 'rejected', outcome: { kind: 'not_open_yet' } } : { kind: 'booked', reservationId: 8 },
    });
    const job = rig.job('firing');
    expect(await rig.fire(job)).toMatchObject({ kind: 'booked', reservationId: 8 });
    expect(rig.api.booked).toHaveLength(2);
    expect(rig.stored(job.id)).toMatchObject({ state: 'booked', attempts: 2, reservationId: 8 });
  });

  it('a card job (when allowed) is recorded as needs_payment', async () => {
    const rig = makeSniperRig();
    const job = rig.job('firing', { payment: 'card' });
    expect(await rig.fire(job, { allowCardPayment: true })).toMatchObject({ kind: 'needs_payment', reservationId: 7 });
    expect(rig.stored(job.id)).toMatchObject({ state: 'needs_payment', attempts: 1, reservationId: 7 });
    expect(kinds(rig.events)).toEqual(['window_open', 'needs_payment']);
  });

  it('a failure after the attempt is recorded as failed, with the attempt still counted', async () => {
    const rig = makeSniperRig({ book: async () => ({ kind: 'rejected', outcome: { kind: 'unknown', status: 200, message: null } }) });
    const job = rig.job('firing');
    expect(await rig.fire(job)).toEqual({ kind: 'failed', reason: 'unknown_response' });
    expect(rig.stored(job.id)).toMatchObject({ state: 'failed', attempts: 1, failureReason: 'unknown_response' });
    expect(rig.api.booked).toHaveLength(1);
  });

  it('a job that is no longer firing makes the sniper send nothing (lost race = undefined, not an exception)', async () => {
    const rig = makeSniperRig();
    const job = rig.job('firing');
    expect(rig.store.transition(job.id, 'firing', 'failed', rig.clock.nowMs(), { failureReason: 'stopped' })?.state).toBe('failed');
    expect(await rig.fire(job)).toEqual({ kind: 'job_changed' });
    expect(rig.api.booked).toEqual([]);
    expect(rig.stored(job.id).attempts).toBe(0);
    expect(rig.logger.error).not.toHaveBeenCalled();
  });
});

describe('runFiring against the real store: a booking that exists on the site is always recorded', () => {
  it.each(['failed', 'expired', 'scheduled'] as const)(
    'the job was moved to %s while the request was in flight: the booking is still stored and announced',
    async (moved: Extract<JobState, 'failed' | 'expired' | 'scheduled'>) => {
      const rig = makeSniperRig({
        book: async () => {
          rig.store.transition(1, 'firing', moved, rig.clock.nowMs());
          return { kind: 'booked', reservationId: 7 };
        },
      });
      const job = rig.job('firing');
      expect(await rig.fire(job)).toMatchObject({ kind: 'booked', reservationId: 7 });
      expect(rig.stored(job.id)).toMatchObject({ state: 'booked', reservationId: 7, bookedChoice: { courtId: 9, startMinutes: 1080 } });
      expect(kinds(rig.events)).toContain('booked');
      expect(rig.logger.error).not.toHaveBeenCalled();
    },
  );

  it('the same for a card job: needs_payment is recorded from a finished job', async () => {
    const rig = makeSniperRig({
      book: async () => {
        rig.store.transition(1, 'firing', 'failed', rig.clock.nowMs());
        return { kind: 'booked', reservationId: 7 };
      },
    });
    const job = rig.job('firing', { payment: 'card' });
    await rig.fire(job, { allowCardPayment: true });
    expect(rig.stored(job.id)).toMatchObject({ state: 'needs_payment', reservationId: 7 });
  });

  it('an unclear answer that the calendar resolves as booked is recorded without a reservation id', async () => {
    const rig = makeSniperRig({
      book: async () => ({ kind: 'ambiguous' }),
      getDay: async () => emptyDay(date('2026-10-20'), true),
    });
    const job = rig.job('firing');
    expect(await rig.fire(job)).toMatchObject({ kind: 'booked', reservationId: null });
    expect(rig.stored(job.id)).toMatchObject({ state: 'booked', attempts: 1, reservationId: null });
    expect(rig.api.booked).toHaveLength(1);
  });
});

describe('recoverJobs against the real store', () => {
  it('re-arms an interrupted job that never sent a request (firing -> scheduled)', async () => {
    const rig = makeSniperRig();
    const job = rig.job('firing');
    const report = await rig.recover();
    expect(report.rescheduled).toEqual([job.id]);
    expect(rig.stored(job.id).state).toBe('scheduled');
    expect(rig.logger.error).not.toHaveBeenCalled();
  });

  it('records a booking that the calendar shows for a job that had sent a request (firing -> booked)', async () => {
    const rig = makeSniperRig({ getDay: async () => emptyDay(date('2026-10-20'), true) });
    const job = rig.job('firing');
    rig.store.transition(job.id, 'firing', 'firing', rig.clock.nowMs(), { attemptsDelta: 1 });
    const report = await rig.recover();
    expect(report.booked).toEqual([job.id]);
    expect(rig.stored(job.id)).toMatchObject({ state: 'booked', attempts: 1, bookedChoice: { courtId: 9, startMinutes: 1080 } });
    expect(kinds(rig.events)).toEqual(['booked']);
  });

  it('marks a job failed when the calendar cannot be read after a request was sent (firing -> failed)', async () => {
    const rig = makeSniperRig({
      getDay: async () => {
        throw new Error('down');
      },
    });
    const job = rig.job('firing');
    rig.store.transition(job.id, 'firing', 'firing', rig.clock.nowMs(), { attemptsDelta: 1 });
    const report = await rig.recover({ lookupRetryMs: 0 });
    expect(report.failed).toEqual([job.id]);
    expect(rig.stored(job.id)).toMatchObject({ state: 'failed', failureReason: 'recovery_unverified' });
  });

  it('expires an interrupted job whose window is long gone (firing -> expired)', async () => {
    const rig = makeSniperRig();
    const job = rig.job('firing');
    rig.clock.advance(10 * 60_000);
    const report = await rig.recover();
    expect(report.expired).toEqual([job.id]);
    expect(rig.stored(job.id).state).toBe('expired');
  });

  it('leaves the other jobs alone and re-arms a warming one (warming -> scheduled)', async () => {
    const rig = makeSniperRig();
    const warming = rig.job('warming');
    const report = await rig.recover();
    expect(report.rescheduled).toEqual([warming.id]);
    const states = rig.store.list().map((job: Job) => job.state);
    expect(states).toEqual(['scheduled']);
  });
});
