import type { JobState, JobStore } from '../contracts.js';
import { clubDateOf } from './clubTime.js';
import { errorName, type JobsLogger } from './logger.js';

/** States of a job whose reservation exists on the site. */
export const BOOKED_STATES: readonly JobState[] = ['booked', 'needs_payment'];

export const isBookedState = (state: JobState): boolean => BOOKED_STATES.includes(state);

/**
 * A reservation whose game day is over has nothing left to do: its job stops occupying the date and leaves the
 * active lists (nothing else would ever retire it). The reservation data stays on the row. Never throws:
 * housekeeping must not break a read or a create.
 */
export const retirePastBookings = (store: JobStore, logger: JobsLogger, nowMs: number): number => {
  try {
    const today = clubDateOf(nowMs);
    let retired = 0;
    for (const job of store.list({ states: BOOKED_STATES })) {
      if (job.gameDate >= today) continue;
      if (store.transition(job.id, job.state, 'expired', nowMs) !== undefined) retired += 1;
    }
    if (retired > 0) logger.info({ retired }, 'past bookings retired');
    return retired;
  } catch (error) {
    logger.warn({ errorName: errorName(error) }, 'housekeeping of past bookings failed');
    return 0;
  }
};
