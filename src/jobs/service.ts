import { allowedCourtIds } from '../config/courts.js';
import { parseGameDate, type GameDate } from '../config/gameDate.js';
import { holidaysWithin } from '../config/holidays.js';
import {
  ACTIVE_JOB_STATES,
  DuplicateActiveJobError,
  type CancelJobResult,
  type Clock,
  type CreateJobInput,
  type CreateJobResult,
  type DaySchedule,
  type Job,
  type JobService,
  type JobState,
  type JobStore,
  type StatusReport,
  type WalletInfo,
} from '../contracts.js';
import { bookingOpensAt, DEFAULT_OPEN_RULE, type OpenRule } from '../sniper/openTime.js';
import { probeOwnBooking, probeSession, readWalletCents, type OwnBookingProbe, type ProbeApi } from './apiProbes.js';
import { clubDateOf, clubMinuteOf } from './clubTime.js';
import { assessFunds, DEFAULT_ESTIMATED_PRICE_CENTS } from './funds.js';
import { isBookedState, retirePastBookings } from './housekeeping.js';
import type { JobsLogger } from './logger.js';
import { checkCourts, checkCreateInput, checkDateRange, checkStartsNotPassed, rejected } from './validateInput.js';

const UPCOMING_HOLIDAYS_DAYS = 30;
const CANCELLABLE_STATES = ['scheduled', 'warming'] as const;
/** States whose window has not opened yet; `warming` starts about ten minutes before it. */
const WAITING_FOR_WINDOW_STATES: readonly JobState[] = ['scheduled', 'warming'];
const VANISHED_BOOKING_REASON = 'booking_not_on_calendar';

export interface JobServiceDeps {
  readonly store: JobStore;
  readonly api: ProbeApi;
  readonly clock: Clock;
  readonly holidays: ReadonlySet<GameDate>;
  readonly logger: JobsLogger;
  /** Price assumed while the site cannot quote (window not open yet). Defaults to 19.02 EUR for 90 minutes. */
  readonly estimatedPriceCents?: number;
  readonly openRule?: OpenRule;
}

const duplicate = (gameDate: GameDate): CreateJobResult =>
  rejected('duplicate_active_job', `there is already an active job for ${gameDate}`);

const byGameDateThenId = (a: Job, b: Job): number => {
  if (a.gameDate !== b.gameDate) return a.gameDate < b.gameDate ? -1 : 1;
  return a.id - b.id;
};

export const createJobService = (deps: JobServiceDeps): JobService => {
  const { store, api, clock, holidays, logger } = deps;
  const estimatedPriceCents = deps.estimatedPriceCents ?? DEFAULT_ESTIMATED_PRICE_CENTS;
  const openRule = deps.openRule ?? DEFAULT_OPEN_RULE;
  if (!Number.isSafeInteger(estimatedPriceCents) || estimatedPriceCents <= 0) {
    throw new Error('estimatedPriceCents must be a positive integer number of cents');
  }

  retirePastBookings(store, logger, clock.nowMs());

  /** The owner cancelled the reservation on the club site: the stale job must not keep its date blocked. */
  const releaseVanishedBooking = (existing: Job): boolean => {
    const released = store.transition(existing.id, existing.state, 'expired', clock.nowMs(), {
      failureReason: VANISHED_BOOKING_REASON,
    });
    if (released === undefined) return false;
    logger.info({ jobId: existing.id, gameDate: existing.gameDate }, 'booking no longer on the calendar, job released');
    return true;
  };

  const allowedCourts = (gameDate: GameDate): readonly number[] => allowedCourtIds(parseGameDate(gameDate), holidays);

  const getDay = async (gameDate: GameDate): Promise<DaySchedule> => api.getDay(parseGameDate(gameDate));

  const createJob = async (input: CreateJobInput): Promise<CreateJobResult> => {
    const nowMs = clock.nowMs();
    const checked = checkCreateInput(input);
    if (checked.kind === 'rejected') return checked;
    const { gameDate, choices, durationMinutes, payment } = checked.value;

    const today = clubDateOf(nowMs);
    const outOfRange = checkDateRange(gameDate, today);
    if (outOfRange) return outOfRange;
    const badCourt = checkCourts(gameDate, choices, holidays);
    if (badCourt) return badCourt;
    const startPassed = checkStartsNotPassed(gameDate, choices, today, clubMinuteOf(nowMs));
    if (startPassed) return startPassed;

    retirePastBookings(store, logger, nowMs);
    const existing = store.list({ states: ACTIVE_JOB_STATES }).find((job) => job.gameDate === gameDate);
    let ownBooking: OwnBookingProbe | undefined;
    if (existing !== undefined) {
      if (!isBookedState(existing.state)) return duplicate(gameDate);
      ownBooking = await probeOwnBooking(api, logger, gameDate);
      if (ownBooking !== 'absent' || !releaseVanishedBooking(existing)) return duplicate(gameDate);
    }

    const opensAtMs = bookingOpensAt(gameDate, openRule).toMillis();
    const windowOpen = opensAtMs <= nowMs;
    if (windowOpen) {
      ownBooking ??= await probeOwnBooking(api, logger, gameDate);
      if (ownBooking === 'present') return rejected('own_booking_exists', `the account already has a booking on ${gameDate}`);
    }

    // Before the job exists: a stored job of an open window counts as "the sniper needs the session" (see ownerApi), so the
    // owner's own balance check could not log in again, and the sniper's own login would race with it.
    const slot = { gameDate, courtId: choices[0].courtId, startMinutes: choices[0].startMinutes, durationMinutes };
    const funds = await assessFunds(api, logger, { slot, payment, windowOpen, estimatedPriceCents });

    let job: Job;
    try {
      job = store.create({ gameDate, choices, durationMinutes, payment }, opensAtMs, clock.nowMs());
    } catch (error) {
      if (error instanceof DuplicateActiveJobError) return duplicate(gameDate);
      throw error;
    }
    logger.info(
      { jobId: job.id, gameDate, choices: choices.length, payment, windowOpen, fundsOk: funds.fundsOk, estimate: funds.requiredIsEstimate },
      'job created',
    );
    return { kind: 'created', job, ...funds };
  };

  const cancelJob = async (id: number): Promise<CancelJobResult> => {
    const current = store.get(id);
    if (current === undefined) return { kind: 'not_found' };
    if (!CANCELLABLE_STATES.some((state) => state === current.state)) {
      return { kind: 'not_cancellable', state: current.state };
    }
    const cancelled = store.transition(id, CANCELLABLE_STATES, 'cancelled', clock.nowMs());
    if (cancelled) {
      logger.info({ jobId: id, from: current.state }, 'job cancelled by the owner');
      return { kind: 'cancelled', job: cancelled };
    }
    const latest = store.get(id);
    return latest === undefined ? { kind: 'not_found' } : { kind: 'not_cancellable', state: latest.state };
  };

  const listJobs = (): readonly Job[] => {
    retirePastBookings(store, logger, clock.nowMs());
    return store.list();
  };

  const status = async (): Promise<StatusReport> => {
    const [sessionAlive, walletCents] = await Promise.all([probeSession(api, logger), readWalletCents(api, logger)]);
    const nowMs = clock.nowMs();
    retirePastBookings(store, logger, nowMs);
    const activeJobs = [...store.list({ states: ACTIVE_JOB_STATES })].sort(byGameDateThenId);
    const upcoming = activeJobs
      .filter((job) => WAITING_FOR_WINDOW_STATES.includes(job.state) && job.opensAtMs > nowMs)
      .map((job) => job.opensAtMs);
    return {
      stopped: store.isStopped(),
      sessionAlive,
      walletCents,
      activeJobs,
      upcomingHolidays: holidaysWithin(holidays, clubDateOf(nowMs), UPCOMING_HOLIDAYS_DAYS),
      nextWindowOpensAtMs: upcoming.length > 0 ? Math.min(...upcoming) : null,
    };
  };

  const wallet = async (): Promise<WalletInfo> => api.getWallet();

  const stopAll = (): void => {
    store.setStopped(true);
    logger.warn({}, 'emergency stop enabled');
  };

  const resumeAll = (): void => {
    store.setStopped(false);
    logger.info({}, 'emergency stop cleared');
  };

  return {
    allowedCourts,
    getDay,
    createJob,
    listJobs,
    cancelJob,
    status,
    wallet,
    stopAll,
    resumeAll,
  };
};
