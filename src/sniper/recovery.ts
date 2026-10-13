import type { Job, JobEventSink, JobState, JobStore, ReservaplayApi, Clock } from '../contracts.js';
import { AuthExpiredError } from '../reservaplay/errors.js';
import { sleepFor, sleepUntil } from './clock.js';
import { createEventQueue, flushWithin, type EventQueue } from './events.js';
import { DEFAULT_FIRE_OPTIONS, UNKNOWN_RESERVATION_ID } from './fireTypes.js';
import { isGameDatePassed } from './gameDay.js';
import { findOwnBooking, type OwnBookingMatch } from './ownBooking.js';
import { describeError, type SniperLogger } from './types.js';

export interface RecoveryOptions {
  /** A job that was firing may be re-armed only while its window is plausibly still open (see fire options). */
  readonly windowLimitMs: number;
  /** A request sent just before the crash is given this long (from the job's last update) to finish server-side. */
  readonly settleMs: number;
  readonly lookupAttempts: number;
  readonly lookupRetryMs: number;
  /** Right after a reboot the network may not be up yet: the login is tried this many times before giving up. */
  readonly loginAttempts: number;
  readonly loginRetryMs: number;
  /** Events still undelivered after this long are left to the queue: startup must not wait for a hung sink. */
  readonly flushTimeoutMs: number;
}

const DEFAULT_RECOVERY_OPTIONS: RecoveryOptions = {
  windowLimitMs: DEFAULT_FIRE_OPTIONS.windowLimitMs,
  settleMs: 20_000,
  lookupAttempts: 3,
  lookupRetryMs: 3000,
  loginAttempts: 3,
  loginRetryMs: 4000,
  flushTimeoutMs: 4000,
};

export interface RecoveryDeps {
  readonly api: ReservaplayApi;
  readonly clock: Clock;
  readonly store: JobStore;
  readonly events: JobEventSink;
  readonly logger: SniperLogger;
  readonly options?: Partial<RecoveryOptions>;
}

export interface RecoveryReport {
  /** Back to `scheduled`: the runner picks them up again. */
  readonly rescheduled: readonly number[];
  readonly booked: readonly number[];
  readonly expired: readonly number[];
  /** Could not be verified: marked failed (never re-fired) and the owner is told to check manually. */
  readonly failed: readonly number[];
}

interface Run {
  readonly deps: RecoveryDeps;
  readonly opts: RecoveryOptions;
  readonly events: EventQueue;
  readonly report: { rescheduled: number[]; booked: number[]; expired: number[]; failed: number[] };
  loggedIn: 'unknown' | 'yes' | 'no';
}

const move = (run: Run, job: Job, from: JobState, to: JobState, patch?: Parameters<JobStore['transition']>[4]): Job | undefined =>
  run.deps.store.transition(job.id, from, to, run.deps.clock.nowMs(), patch);

const expire = (run: Run, job: Job, from: JobState, reason: string): void => {
  const updated = move(run, job, from, 'expired', { failureReason: reason });
  if (updated === undefined) return;
  run.report.expired.push(job.id);
  run.events.emit({ kind: 'expired', job: updated });
};

const ensureLogin = async (run: Run): Promise<boolean> => {
  if (run.loggedIn !== 'unknown') return run.loggedIn === 'yes';
  const { api, clock, logger } = run.deps;
  for (let attempt = 0; attempt < run.opts.loginAttempts; attempt++) {
    if (attempt > 0) await sleepFor(clock, run.opts.loginRetryMs);
    try {
      await api.login();
      run.loggedIn = 'yes';
      return true;
    } catch (error) {
      logger.warn({ attempt, ...describeError(error) }, 'recovery could not log in');
    }
  }
  run.loggedIn = 'no';
  return false;
};

/** Own booking on the job's date: a match, null (calendar read fine, nothing there) or 'unreachable'. */
const lookupOwnBooking = async (run: Run, job: Job): Promise<OwnBookingMatch | null | 'unreachable'> => {
  const { api, clock, logger } = run.deps;
  if (!(await ensureLogin(run))) return 'unreachable';
  let reloggedIn = false;
  for (let attempt = 0; attempt < run.opts.lookupAttempts; attempt++) {
    if (attempt > 0) await sleepFor(clock, run.opts.lookupRetryMs);
    try {
      return findOwnBooking(await api.getDay(job.gameDate), job.choices);
    } catch (error) {
      logger.warn({ jobId: job.id, attempt, ...describeError(error) }, 'recovery calendar read failed');
      if (error instanceof AuthExpiredError && !reloggedIn) {
        reloggedIn = true;
        await api.login().catch(() => undefined);
      }
    }
  }
  return 'unreachable';
};

/** A booking on the date that covers no wished slot may be the owner's own: nothing is claimed, the owner decides. */
const recordElsewhere = (run: Run, job: Job): void => {
  const updated = move(run, job, 'firing', 'failed', { failureReason: 'own_booking_elsewhere' });
  if (updated === undefined) return;
  run.report.failed.push(job.id);
  run.events.emit({
    kind: 'ambiguous',
    job: updated,
    detail: 'a booking exists on that day but not on a wished slot: check the club site; nothing more will be sent',
  });
  run.events.emit({ kind: 'failed', job: updated, reason: 'own_booking_elsewhere' });
};

const recordBooked = (run: Run, job: Job, match: OwnBookingMatch): void => {
  const { choice } = match;
  if (choice === null) return recordElsewhere(run, job);
  const target: JobState = job.payment === 'card' ? 'needs_payment' : 'booked';
  const updated = move(run, job, 'firing', target, { bookedChoice: choice });
  if (updated === undefined) return;
  run.report.booked.push(job.id);
  run.events.emit(
    target === 'booked'
      ? { kind: 'booked', job: updated, reservationId: UNKNOWN_RESERVATION_ID, choice }
      : { kind: 'needs_payment', job: updated, reservationId: UNKNOWN_RESERVATION_ID },
  );
};

const recordUnverified = (run: Run, job: Job): void => {
  const updated = move(run, job, 'firing', 'failed', { failureReason: 'recovery_unverified' });
  if (updated === undefined) return;
  run.report.failed.push(job.id);
  run.events.emit({
    kind: 'ambiguous',
    job: updated,
    detail: 'the bot restarted during a booking request and could not read the calendar: check the club site',
  });
  run.events.emit({ kind: 'failed', job: updated, reason: 'recovery_unverified' });
};

const stillPlausible = (run: Run, job: Job): boolean => {
  const now = run.deps.clock.nowMs();
  if (isGameDatePassed(job.gameDate, now)) return false;
  return now <= Math.max(job.opensAtMs, job.updatedAtMs) + run.opts.windowLimitMs;
};

/**
 * A job found in `firing` may already have booked. If a booking request was started (attempts > 0) the calendar
 * decides; nothing is ever fired again on a guess.
 */
const recoverFiring = async (run: Run, job: Job): Promise<void> => {
  if (job.attempts > 0) {
    const now = run.deps.clock.nowMs();
    await sleepUntil(run.deps.clock, Math.min(job.updatedAtMs, now) + run.opts.settleMs);
    const found = await lookupOwnBooking(run, job);
    if (found === 'unreachable') return recordUnverified(run, job);
    if (found !== null) return recordBooked(run, job, found);
  }
  if (!stillPlausible(run, job)) return expire(run, job, 'firing', 'restart_window_passed');
  if (move(run, job, 'firing', 'scheduled') !== undefined) run.report.rescheduled.push(job.id);
};

/**
 * Run once at startup, before the runner starts. warming -> scheduled; scheduled with a passed game date ->
 * expired; firing -> booked (calendar shows it), back to scheduled (window still plausible) or expired.
 */
export const recoverJobs = async (deps: RecoveryDeps): Promise<RecoveryReport> => {
  const run: Run = {
    deps,
    opts: { ...DEFAULT_RECOVERY_OPTIONS, ...deps.options },
    events: createEventQueue(deps.events, deps.logger),
    report: { rescheduled: [], booked: [], expired: [], failed: [] },
    loggedIn: 'unknown',
  };
  const jobs = deps.store.list({ states: ['warming', 'scheduled', 'firing'] });
  try {
    for (const job of jobs.filter((candidate) => candidate.state !== 'firing')) {
      if (isGameDatePassed(job.gameDate, deps.clock.nowMs())) {
        expire(run, job, job.state, 'game_date_passed');
      } else if (job.state === 'warming' && move(run, job, 'warming', 'scheduled') !== undefined) {
        run.report.rescheduled.push(job.id);
      }
    }
    for (const job of jobs.filter((candidate) => candidate.state === 'firing')) {
      try {
        await recoverFiring(run, job);
      } catch (error) {
        deps.logger.error({ jobId: job.id, ...describeError(error) }, 'recovering a job failed; it stays as it is');
      }
    }
  } finally {
    await flushWithin(run.events, run.opts.flushTimeoutMs);
  }
  deps.logger.info(
    { rescheduled: run.report.rescheduled.length, booked: run.report.booked.length, expired: run.report.expired.length, failed: run.report.failed.length },
    'recovery finished',
  );
  return run.report;
};
