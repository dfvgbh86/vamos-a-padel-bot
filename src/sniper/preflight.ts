import type { GameDate } from '../config/gameDate.js';
import type { AccountContext, Clock, Job, PreflightFailure, ReservaplayApi, SlotRef } from '../contracts.js';
import { AuthExpiredError, LoginFailedError } from '../reservaplay/errors.js';
import { createPacer, type ClockCalibration } from './clock.js';
import { slotFor } from './fireContext.js';
import { MIN_REQUEST_GAP_MS } from './fireTypes.js';
import { findAccountContext } from './sampleSlot.js';
import { describeError, type SniperLogger } from './types.js';

/** A 90 minute booking costs 19.02 EUR; used when the site cannot quote the price yet. */
export const DEFAULT_ESTIMATED_COST_CENTS = 1902;
const ESTIMATE_BASE_MINUTES = 90;

/** The estimate for a 90 minute booking, scaled to the job's duration (the site's price grows with the time). */
export const estimateCostCents = (cents90Minutes: number, durationMinutes: number): number =>
  Math.round((cents90Minutes * durationMinutes) / ESTIMATE_BASE_MINUTES);

export interface PreflightOptions {
  readonly sampleSearchDays: number;
  /** Probes of the closed target form used to read the server clock. */
  readonly calibrationSamples: number;
  readonly requestGapMs: number;
}

const DEFAULT_PREFLIGHT_OPTIONS: PreflightOptions = {
  sampleSearchDays: 7,
  calibrationSamples: 5,
  requestGapMs: MIN_REQUEST_GAP_MS,
};

export interface PreflightDeps {
  readonly api: ReservaplayApi;
  readonly clock: Clock;
  readonly calibration?: ClockCalibration;
  readonly holidays: ReadonlySet<GameDate>;
  readonly logger: SniperLogger;
  /** A login already happened in this process: check the session first and log in only if it is gone. */
  readonly reuseSession?: boolean;
  /** Price of a 90 minute booking when the site cannot quote; scaled to the job's duration. */
  readonly estimatedCostCents?: number;
  readonly options?: Partial<PreflightOptions>;
}

export interface ClockReport {
  readonly offsetMs: number;
  readonly observations: number;
  /** Readings beyond the sanity limit that were NOT applied (garbled time or a badly wrong PC clock). */
  readonly absurd: number;
}

export type PreflightResult =
  | {
      readonly ok: true;
      /** Lives in memory only; the `hash` is replaced by the one of the latest open form at firing time. */
      readonly account: AccountContext;
      readonly walletCents: number;
      readonly quoteCents: number | null;
      readonly requiredCents: number;
      /** `requiredCents` is a guess (the site could not quote), not a price the site named. */
      readonly requiredIsEstimate: boolean;
      readonly clock: ClockReport | null;
    }
  | {
      readonly ok: false;
      readonly reason: PreflightFailure;
      readonly detail: string;
      /** Present when the failure came after the account context was read (the job can still fire). */
      readonly account?: AccountContext;
      readonly requiredCents?: number;
      readonly requiredIsEstimate?: boolean;
    };

type Failed = Extract<PreflightResult, { ok: false }>;

const euros = (cents: number): string => (cents / 100).toFixed(2);

const failed = (reason: PreflightFailure, detail: string, extra: Partial<Failed> = {}): Failed => ({
  ok: false,
  reason,
  detail,
  ...extra,
});

const establishSession = async (deps: PreflightDeps, pace: () => Promise<void>): Promise<void> => {
  if (deps.reuseSession === true) {
    try {
      await pace();
      await deps.api.keepAlive();
      return;
    } catch (error) {
      if (!(error instanceof AuthExpiredError)) throw error;
      deps.logger.info({}, 'session is gone; logging in again');
    }
  }
  await pace();
  await deps.api.login();
};

interface Funds {
  readonly walletCents: number;
  readonly quoteCents: number | null;
  readonly requiredCents: number;
  readonly requiredIsEstimate: boolean;
  readonly shortDetail: string | null;
}

const checkFunds = async (job: Job, slot: SlotRef, deps: PreflightDeps, pace: () => Promise<void>): Promise<Funds> => {
  await pace();
  const wallet = await deps.api.getWallet();
  await pace();
  const quote = await deps.api.quote(slot, job.payment).catch((error: unknown) => {
    if (error instanceof AuthExpiredError) throw error;
    deps.logger.info({ jobId: job.id, ...describeError(error) }, 'price not quotable yet; using the estimate');
    return null;
  });
  const quoteCents = quote?.totalCents ?? null;
  const requiredCents =
    quoteCents ?? estimateCostCents(deps.estimatedCostCents ?? DEFAULT_ESTIMATED_COST_CENTS, job.durationMinutes);
  const base = { walletCents: wallet.balanceCents, quoteCents, requiredCents, requiredIsEstimate: quoteCents === null };
  if (job.payment !== 'wallet') return { ...base, shortDetail: null };
  if (wallet.balanceCents < requiredCents) {
    const source = quoteCents === null ? ' (estimate)' : '';
    return { ...base, shortDetail: `need ${euros(requiredCents)} EUR${source}, wallet has ${euros(wallet.balanceCents)} EUR` };
  }
  if (quoteCents !== null && quote?.walletPayable === false) {
    return { ...base, shortDetail: 'the site does not offer payment from the wallet for this slot' };
  }
  return { ...base, shortDetail: null };
};

/**
 * Probes the CLOSED target form: the "N days ahead" message carries the server clock, which calibrates `clock`.
 * Also the earliest place where "you already have a booking that day" or an unreadable page shows up.
 */
const probeTarget = async (
  slot: SlotRef,
  deps: PreflightDeps,
  opts: PreflightOptions,
  pace: () => Promise<void>,
): Promise<{ readonly clock: ClockReport | null } | Failed> => {
  const calibration = deps.calibration;
  const probes = calibration === undefined ? 1 : opts.calibrationSamples;
  let observations = 0;
  let absurd = 0;
  const report = (): ClockReport | null =>
    calibration === undefined ? null : { offsetMs: calibration.offsetMs(), observations, absurd };
  for (let probe = 0; probe < probes; probe++) {
    await pace();
    const sentAt = calibration?.localNowMs() ?? 0;
    const gate = await deps.api.probeForm(slot);
    switch (gate.kind) {
      case 'window_closed': {
        if (calibration === undefined || gate.serverCheckTime === null) break;
        const receivedAt = calibration.localNowMs();
        const result = calibration.observeServerTime(gate.serverCheckTime.toMillis(), receivedAt, receivedAt - sentAt);
        if (result.accepted) observations++;
        if (result.absurd) absurd++;
        break;
      }
      case 'open':
        return { clock: report() };
      case 'daily_limit':
        return failed('daily_limit', 'the account already has a booking on that day');
      case 'login_required':
        return failed('auth', 'the booking form asked for a login');
      case 'too_short':
        return failed('other', 'the site rejects the booking duration');
      case 'unknown':
        return failed('window_unknown', 'the booking form page was not understood');
    }
  }
  return { clock: report() };
};

/**
 * T-10 min checks: login, account context (kept in memory only), wallet against the price, clock calibration.
 * Emits nothing: the caller turns the result into events.
 */
export const runPreflight = async (job: Job, deps: PreflightDeps): Promise<PreflightResult> => {
  const opts: PreflightOptions = { ...DEFAULT_PREFLIGHT_OPTIONS, ...deps.options };
  const pace = createPacer(deps.clock, opts.requestGapMs);
  let account: AccountContext | undefined;
  let requiredCents: number | undefined;
  let requiredIsEstimate: boolean | undefined;
  try {
    const firstChoice = job.choices[0];
    if (firstChoice === undefined) return failed('other', 'the job has no choices');
    const target = slotFor(job, firstChoice);

    await establishSession(deps, pace);
    const context = await findAccountContext({
      api: deps.api,
      clock: deps.clock,
      holidays: deps.holidays,
      logger: deps.logger,
      searchDays: opts.sampleSearchDays,
      pace,
    });
    if (context === null) return failed('other', 'no day with a free sample slot to read the account context from');
    account = context;

    const funds = await checkFunds(job, target, deps, pace);
    requiredCents = funds.requiredCents;
    requiredIsEstimate = funds.requiredIsEstimate;
    if (funds.shortDetail !== null) return failed('no_funds', funds.shortDetail, { account, requiredCents, requiredIsEstimate });

    const probed = await probeTarget(target, deps, opts, pace);
    if ('ok' in probed) return { ...probed, account, requiredCents, requiredIsEstimate };

    if ((probed.clock?.absurd ?? 0) > 0) {
      deps.logger.warn({ jobId: job.id, ...probed.clock }, 'server clock reading was absurd and ignored; check the PC clock');
    }
    deps.logger.info({ jobId: job.id, walletCents: funds.walletCents, offsetMs: probed.clock?.offsetMs }, 'preflight ok');
    return {
      ok: true,
      account,
      walletCents: funds.walletCents,
      quoteCents: funds.quoteCents,
      requiredCents: funds.requiredCents,
      requiredIsEstimate: funds.requiredIsEstimate,
      clock: probed.clock,
    };
  } catch (error) {
    deps.logger.warn({ jobId: job.id, ...describeError(error) }, 'preflight step failed');
    const extra: Partial<Failed> = {
      ...(account === undefined ? {} : { account }),
      ...(requiredCents === undefined || requiredIsEstimate === undefined ? {} : { requiredCents, requiredIsEstimate }),
    };
    if (error instanceof LoginFailedError || error instanceof AuthExpiredError) return failed('auth', error.name, extra);
    return failed('other', describeError(error).errorName, extra);
  }
};
