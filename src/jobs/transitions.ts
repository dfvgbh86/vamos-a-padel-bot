import type { JobState } from '../contracts.js';
import { InvalidTransitionError } from './errors.js';

/** A reservation that exists on the site must always be storable, whatever state the job was moved to meanwhile. */
const RECORDS_BOOKING = ['booked', 'needs_payment'] as const satisfies readonly JobState[];

/**
 * The legal state changes of a job, in one place: the store enforces them inside the WHERE clause of its single
 * UPDATE and the sniper's call patterns are written against this table (tests/jobs/sniper.contract.test.ts runs
 * them against the real store).
 *
 * - `firing -> firing` counts a booking attempt (`attemptsDelta`) before the request leaves the machine.
 * - `firing -> scheduled` and `warming -> scheduled` re-arm a job interrupted before its window ended (restart).
 * - `booked` / `needs_payment` are normally reached from `firing`; the other sources exist only so that a confirmed
 *   booking is never lost when the job was moved on while the request was in flight (the store rejects the late
 *   record if another active job has taken the date meanwhile).
 * - every active state may become `expired` so housekeeping can retire jobs whose date is long gone.
 * - `failed`, `cancelled` and `expired` end a job's life; the only way out is recording such a late booking.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  scheduled: ['warming', 'cancelled', 'failed', 'expired', ...RECORDS_BOOKING],
  warming: ['firing', 'scheduled', 'cancelled', 'failed', 'expired', ...RECORDS_BOOKING],
  firing: ['firing', 'scheduled', 'booked', 'needs_payment', 'failed', 'expired'],
  booked: ['expired'],
  needs_payment: ['booked', 'failed', 'expired'],
  failed: RECORDS_BOOKING,
  cancelled: RECORDS_BOOKING,
  expired: RECORDS_BOOKING,
};

export const JOB_STATES = Object.keys(ALLOWED_TRANSITIONS) as readonly JobState[];

export const TERMINAL_JOB_STATES: readonly JobState[] = ['failed', 'cancelled', 'expired'];

export const isJobState = (value: unknown): value is JobState =>
  typeof value === 'string' && Object.hasOwn(ALLOWED_TRANSITIONS, value);

export const canTransition = (from: JobState, to: JobState): boolean => ALLOWED_TRANSITIONS[from].includes(to);

const describeState = (value: unknown): string => (typeof value === 'string' ? value.slice(0, 40) : typeof value);

/**
 * The subset of `from` that may legally move to `to`; empty when none can, which the store reports as a lost race
 * (`undefined`) like the contract says. Names that are not job states, or an empty list, are programming errors
 * and throw.
 */
export const transitionSources = (from: unknown, to: unknown): readonly JobState[] => {
  const requested: readonly unknown[] = Array.isArray(from) ? (from as readonly unknown[]) : [from];
  const names = requested.map(describeState);
  if (!isJobState(to) || requested.length === 0 || !requested.every(isJobState)) {
    throw new InvalidTransitionError(names, describeState(to));
  }
  return [...new Set(requested)].filter((state) => canTransition(state, to));
};
