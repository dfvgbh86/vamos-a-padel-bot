import type { Clock, Job, JobEvent, JobEventSink } from '../contracts.js';
import { createEventQueue, flushWithin } from './events.js';
import { UNKNOWN_RESERVATION_ID } from './fireTypes.js';
import { describeError, type SniperLogger } from './types.js';

/** The results that must reach the owner: money was spent, or a booking may exist that the bot could not confirm. */
export const ANNOUNCED_STATES = ['booked', 'needs_payment', 'failed'] as const;
export type AnnouncedState = (typeof ANNOUNCED_STATES)[number];

/** Persistent record of which job results were confirmed delivered, so a crash or a long outage cannot swallow one. */
export interface ResultLedger {
  /** Jobs in a result state whose current result was not confirmed delivered, last updated at or after `sinceMs`. */
  unannouncedResults(sinceMs: number): readonly Job[];
  markAnnounced(jobId: number, state: AnnouncedState): void;
}

/** The state a delivered event settles, or null for events that carry no result (progress messages, alerts). */
export const announcedStateOf = (event: JobEvent): AnnouncedState | null => {
  switch (event.kind) {
    case 'booked':
    case 'needs_payment':
    case 'failed':
      return event.kind;
    default:
      return null;
  }
};

/** Older results are history: nobody wants "failed" for a game from last month after a long holiday. */
const REANNOUNCE_WINDOW_MS = 7 * 24 * 3_600_000;
const FLUSH_TIMEOUT_MS = 4000;

/** Failure reasons after which a booking may exist: the owner must be told to look, not only that it failed. */
const MAYBE_BOOKED_REASONS: ReadonlySet<string> = new Set([
  'ambiguous_unresolved',
  'own_booking_elsewhere',
  'recovery_unverified',
  'unknown_response',
]);

const REANNOUNCE_DETAIL =
  'this result could not be delivered earlier (the bot was restarted or Telegram was unreachable): check the booking on the club site';

const eventsFor = (job: Job): readonly JobEvent[] => {
  const reservationId = job.reservationId ?? UNKNOWN_RESERVATION_ID;
  switch (job.state) {
    case 'booked': {
      const choice = job.bookedChoice ?? job.choices[0];
      return choice === undefined ? [] : [{ kind: 'booked', job, reservationId, choice }];
    }
    case 'needs_payment':
      return [{ kind: 'needs_payment', job, reservationId }];
    case 'failed': {
      const reason = job.failureReason ?? 'unknown';
      const maybeBooked = MAYBE_BOOKED_REASONS.has(reason) || (reason === 'internal_error' && job.attempts > 0);
      const failed: JobEvent = { kind: 'failed', job, reason };
      return maybeBooked ? [{ kind: 'ambiguous', job, detail: REANNOUNCE_DETAIL }, failed] : [failed];
    }
    default:
      return [];
  }
};

export interface ReannounceDeps {
  readonly ledger: ResultLedger;
  readonly events: JobEventSink;
  readonly clock: Clock;
  readonly logger: SniperLogger;
}

/**
 * Run once at startup, BEFORE recovery (recovery announces its own results): hands the sink every recent result
 * that was never confirmed delivered. Delivery is marked by the sink's owner once Telegram accepted the message.
 * Never waits long and never throws: a dead network must not hold up the sniper.
 */
export const reannounceResults = async (deps: ReannounceDeps): Promise<number> => {
  const queue = createEventQueue(deps.events, deps.logger);
  let announced = 0;
  try {
    for (const job of deps.ledger.unannouncedResults(deps.clock.nowMs() - REANNOUNCE_WINDOW_MS)) {
      for (const event of eventsFor(job)) queue.emit(event);
      announced++;
    }
    await flushWithin(queue, FLUSH_TIMEOUT_MS);
  } catch (error) {
    deps.logger.error(describeError(error), 'could not re-announce undelivered results');
  }
  if (announced > 0) deps.logger.warn({ jobs: announced }, 'announcing results that were never confirmed as delivered');
  return announced;
};
