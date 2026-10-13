import type { JobPatch, JobState, SlotChoice } from '../contracts.js';
import type { FireContext } from './fireContext.js';
import { UNKNOWN_RESERVATION_ID, type FireFailureReason, type FireResult } from './fireTypes.js';
import { describeError } from './types.js';

/** A booking that was recorded while the job already sat in another state must still be recorded (money was spent). */
const LATE_BOOKING_FROM: readonly JobState[] = ['scheduled', 'warming', 'cancelled', 'failed', 'expired'];

export const abortedResult = (ctx: FireContext): FireResult => {
  ctx.deps.logger.info({ jobId: ctx.job.id }, 'firing interrupted by shutdown; the job stays in firing for recovery');
  return { kind: 'aborted' };
};

export const failJob = (ctx: FireContext, reason: FireFailureReason): FireResult => {
  const { store, clock, events, logger } = ctx.deps;
  const updated = store.transition(ctx.job.id, 'firing', 'failed', clock.nowMs(), { failureReason: reason });
  if (updated === undefined) {
    logger.warn({ jobId: ctx.job.id, reason }, 'job was no longer firing when the failure was to be recorded');
    return { kind: 'job_changed' };
  }
  ctx.job = updated;
  events.emit({ kind: 'failed', job: updated, reason });
  logger.warn({ jobId: updated.id, reason, attempts: updated.attempts }, 'firing failed');
  return { kind: 'failed', reason };
};

/** Stores the booking BEFORE the event is emitted (CONTRACT C3, C12). `reservationId` null = found in the calendar. */
export const finishBooked = (ctx: FireContext, choice: SlotChoice, reservationId: number | null): FireResult => {
  const { store, clock, events, logger } = ctx.deps;
  const target: JobState = ctx.job.payment === 'card' ? 'needs_payment' : 'booked';
  const patch: JobPatch = reservationId === null ? { bookedChoice: choice } : { bookedChoice: choice, reservationId };
  const now = clock.nowMs();
  const updated =
    store.transition(ctx.job.id, 'firing', target, now, patch) ?? store.transition(ctx.job.id, LATE_BOOKING_FROM, target, now, patch);
  if (updated === undefined) logger.error({ jobId: ctx.job.id, target }, 'booking could not be recorded in the store');
  const job = updated ?? ctx.job;
  ctx.job = job;
  const eventId = reservationId ?? UNKNOWN_RESERVATION_ID;
  events.emit(
    target === 'booked'
      ? { kind: 'booked', job, reservationId: eventId, choice }
      : { kind: 'needs_payment', job, reservationId: eventId },
  );
  logger.info({ jobId: job.id, target, idKnown: reservationId !== null, courtId: choice.courtId }, 'booking recorded');
  return target === 'booked' ? { kind: 'booked', reservationId, choice } : { kind: 'needs_payment', reservationId, choice };
};

export const failUnexpected = (ctx: FireContext, error: unknown): FireResult => {
  ctx.deps.logger.error({ jobId: ctx.job.id, ...describeError(error) }, 'unexpected error while firing');
  if (ctx.booksStarted > 0) {
    ctx.deps.events.emit({
      kind: 'ambiguous',
      job: ctx.job,
      detail: 'internal error after a booking request was sent: check the club site, nothing will be re-sent',
    });
  }
  try {
    return failJob(ctx, 'internal_error');
  } catch (inner) {
    ctx.deps.logger.error({ jobId: ctx.job.id, ...describeError(inner) }, 'could not record the internal failure');
    return { kind: 'failed', reason: 'internal_error' };
  }
};
