import type { SlotChoice } from '../contracts.js';

/** Sent in events when a booking was found in the calendar but its id could not be read (valid ids are positive). */
export const UNKNOWN_RESERVATION_ID = 0;

/** Never below this: the account must not be hammered (about 4 requests per second at most). */
export const MIN_REQUEST_GAP_MS = 250;
const MAX_ALLOWED_ATTEMPTS = 10;

export interface FireOptions {
  /** The first probe may start this long before the window opens. */
  readonly leadMs: number;
  /** Stop trying this long after the window opened (or after firing started, for a job picked up late). */
  readonly windowLimitMs: number;
  /** Maximum add_event requests that may have reached the server for one job. */
  readonly maxAttempts: number;
  /** Minimum time between the starts of two requests. */
  readonly minRequestGapMs: number;
  readonly maxNotSentRetries: number;
  readonly notSentDelayMs: number;
  /** Probing fails for good only after this long without ANY successful probe (a 5xx burst at the opening is normal). */
  readonly maxProbeOutageMs: number;
  /** Pause after a failed probe, on top of the request pacing. */
  readonly probeErrorBackoffMs: number;
  /** Calendar checks after an unclear outcome. */
  readonly reconcilePolls: number;
  readonly reconcileIntervalMs: number;
  /** Successful re-logins allowed during one firing run (a session that dies again and again is not worth more). */
  readonly maxRelogins: number;
  /** Attempts of ONE re-login: an overloaded site refuses or drops logins at the opening. */
  readonly maxLoginAttempts: number;
  readonly loginRetryDelayMs: number;
  /** Consecutive unrecognised form pages tolerated (a truncated or interstitial page under load) before the calendar decides. */
  readonly maxUnknownFormProbes: number;
}

export const DEFAULT_FIRE_OPTIONS: FireOptions = {
  leadMs: 3000,
  windowLimitMs: 90_000,
  maxAttempts: 3,
  minRequestGapMs: MIN_REQUEST_GAP_MS,
  maxNotSentRetries: 5,
  notSentDelayMs: 300,
  maxProbeOutageMs: 20_000,
  probeErrorBackoffMs: 750,
  reconcilePolls: 5,
  reconcileIntervalMs: 3000,
  maxRelogins: 2,
  maxLoginAttempts: 5,
  loginRetryDelayMs: 1500,
  maxUnknownFormProbes: 3,
};

const assertInteger = (name: string, value: number, min: number, max = Number.MAX_SAFE_INTEGER): void => {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`Invalid fire option ${name}: ${String(value)}`);
  }
};

export const resolveFireOptions = (overrides: Partial<FireOptions> = {}): FireOptions => {
  const options: FireOptions = { ...DEFAULT_FIRE_OPTIONS, ...overrides };
  assertInteger('leadMs', options.leadMs, 0);
  assertInteger('windowLimitMs', options.windowLimitMs, 1000);
  assertInteger('maxAttempts', options.maxAttempts, 1, MAX_ALLOWED_ATTEMPTS);
  assertInteger('minRequestGapMs', options.minRequestGapMs, MIN_REQUEST_GAP_MS);
  assertInteger('maxNotSentRetries', options.maxNotSentRetries, 0);
  assertInteger('notSentDelayMs', options.notSentDelayMs, 0);
  assertInteger('maxProbeOutageMs', options.maxProbeOutageMs, 1000);
  assertInteger('probeErrorBackoffMs', options.probeErrorBackoffMs, 0);
  assertInteger('reconcilePolls', options.reconcilePolls, 1);
  assertInteger('reconcileIntervalMs', options.reconcileIntervalMs, 0);
  assertInteger('maxRelogins', options.maxRelogins, 0);
  assertInteger('maxLoginAttempts', options.maxLoginAttempts, 1);
  assertInteger('loginRetryDelayMs', options.loginRetryDelayMs, 0);
  assertInteger('maxUnknownFormProbes', options.maxUnknownFormProbes, 1);
  return options;
};

/** Machine-readable ids stored in `job.failureReason` and sent in the `failed` event. */
export type FireFailureReason =
  | 'stopped'
  | 'card_not_allowed'
  | 'court_not_allowed'
  | 'window_timeout'
  | 'max_attempts'
  | 'no_choice_available'
  | 'unknown_form'
  | 'unknown_response'
  | 'daily_limit'
  | 'auth'
  | 'ambiguous_unresolved'
  | 'own_booking_elsewhere'
  | 'probe_failed'
  | 'not_sent_exhausted'
  | 'internal_error';

export const FIRE_FAILURE_DESCRIPTIONS: Readonly<Record<FireFailureReason, string>> = {
  stopped: 'The emergency stop flag is set.',
  card_not_allowed: 'Card payment jobs are disabled.',
  court_not_allowed: 'A wished court is not allowed on that day.',
  window_timeout: 'The booking window did not open within the time limit.',
  max_attempts: 'The maximum number of booking requests was reached.',
  no_choice_available: 'Every wished slot was ruled out.',
  unknown_form: 'The slot page was not understood; nothing was sent.',
  unknown_response: 'The booking answer was not understood and no booking was found; check the club site.',
  daily_limit: 'The account already has a booking on that day.',
  auth: 'The session expired and logging in again did not help.',
  ambiguous_unresolved: 'A booking request got no clear answer and no booking was found; check the club site.',
  own_booking_elsewhere: 'The account has a booking on that day, but not on a wished slot; check the club site.',
  probe_failed: 'The slot page could not be fetched for a long time.',
  not_sent_exhausted: 'The booking request could not leave this machine repeatedly.',
  internal_error: 'Unexpected internal error.',
};

export type FireResult =
  | { readonly kind: 'booked'; readonly reservationId: number | null; readonly choice: SlotChoice }
  | { readonly kind: 'needs_payment'; readonly reservationId: number | null; readonly choice: SlotChoice }
  | { readonly kind: 'failed'; readonly reason: FireFailureReason }
  /** The shutdown signal fired; the job is left in `firing` for restart recovery to reconcile. */
  | { readonly kind: 'aborted' }
  /** The job was moved out of `firing` by someone else (cancelled); nothing further was sent. */
  | { readonly kind: 'job_changed' };
