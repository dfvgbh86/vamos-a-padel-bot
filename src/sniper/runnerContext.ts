import type { GameDate } from '../config/gameDate.js';
import type { AccountContext, Clock, JobEventSink, JobStore, PreflightFailure, ReservaplayApi } from '../contracts.js';
import type { ClockCalibration } from './clock.js';
import type { EventQueue } from './events.js';
import { DEFAULT_ESTIMATED_COST_CENTS, type PreflightOptions } from './preflight.js';
import type { FireOptions } from './fireTypes.js';
import type { SniperLogger } from './types.js';

export interface RunnerOptions {
  readonly tickMs: number;
  /** A job is picked up (preflight starts) this long before its window opens. */
  readonly warmupLeadMs: number;
  readonly keepAliveEveryMs: number;
  /** One more session check this long before the window opens. */
  readonly sessionCheckLeadMs: number;
  /** While funds (or the page) are missing: preflight is repeated this often until firing time. */
  readonly recheckEveryMs: number;
  /** A failed login (or session) is tried again this often ... */
  readonly authRetryEveryMs: number;
  /** ... for this many failures, then half as often (twice the interval) until firing time; never a terminal failure before it. */
  readonly authFastRetries: number;
  /**
   * While the account context is still unknown, one more preflight runs this long before firing starts, whatever the
   * retry schedule says: a site that came back shortly before the opening must not find the job already failed.
   */
  readonly finalPreflightLeadMs: number;
  /** Closer than this to the first probe, no recheck or regular keep-alive starts (when the account context is known). */
  readonly fireQuietMs: number;
  /** Price of a 90 minute booking when the site cannot quote it yet. */
  readonly estimatedCostCents: number;
  readonly fire: Partial<FireOptions>;
  readonly preflight: Partial<PreflightOptions>;
}

export const DEFAULT_RUNNER_OPTIONS: RunnerOptions = {
  tickMs: 1000,
  warmupLeadMs: 10 * 60_000,
  keepAliveEveryMs: 5 * 60_000,
  sessionCheckLeadMs: 60_000,
  recheckEveryMs: 60_000,
  authRetryEveryMs: 60_000,
  authFastRetries: 3,
  fireQuietMs: 10_000,
  finalPreflightLeadMs: 20_000,
  estimatedCostCents: DEFAULT_ESTIMATED_COST_CENTS,
  fire: {},
  preflight: {},
};

export const resolveRunnerOptions = (overrides: Partial<RunnerOptions> = {}): RunnerOptions => {
  const options: RunnerOptions = { ...DEFAULT_RUNNER_OPTIONS, ...overrides };
  const numbers: readonly (readonly [string, number, number])[] = [
    ['tickMs', options.tickMs, 1],
    ['warmupLeadMs', options.warmupLeadMs, 0],
    ['keepAliveEveryMs', options.keepAliveEveryMs, 1000],
    ['sessionCheckLeadMs', options.sessionCheckLeadMs, 0],
    ['recheckEveryMs', options.recheckEveryMs, 1000],
    ['authRetryEveryMs', options.authRetryEveryMs, 1000],
    ['authFastRetries', options.authFastRetries, 1],
    ['fireQuietMs', options.fireQuietMs, 0],
    ['finalPreflightLeadMs', options.finalPreflightLeadMs, 0],
    ['estimatedCostCents', options.estimatedCostCents, 0],
  ];
  for (const [name, value, min] of numbers) {
    if (!Number.isInteger(value) || value < min) throw new RangeError(`Invalid runner option ${name}: ${String(value)}`);
  }
  if (options.tickMs > 1000) throw new RangeError('Invalid runner option tickMs: ticks must be 1 s or shorter');
  return options;
};

export interface SniperRunnerDeps {
  readonly api: ReservaplayApi;
  /** The server-corrected clock (see createSystemClock). */
  readonly clock: Clock;
  /** The same clock object when it can be calibrated from server readings. */
  readonly calibration?: ClockCalibration;
  readonly store: JobStore;
  readonly events: JobEventSink;
  readonly holidays: ReadonlySet<GameDate>;
  readonly logger: SniperLogger;
  /** Card jobs are refused unless this is exactly true. */
  readonly allowCardPayment?: boolean;
  readonly options?: Partial<RunnerOptions>;
}

/** What the runner remembers about one job between ticks. Never persisted; the hash is not kept at all. */
export interface WarmState {
  account: AccountContext | null;
  requiredCents: number | null;
  /** `requiredCents` is a guess: it must never keep a job from firing (the site decides). */
  requiredIsEstimate: boolean;
  /** The last preflight passed. */
  ready: boolean;
  failure: PreflightFailure | null;
  /** Last preflight outcome the owner was told about (events are not repeated every minute). */
  announced: 'ok' | PreflightFailure | null;
  authAttempts: number;
  /** The owner was told that the PC clock cannot be trusted. */
  clockWarned: boolean;
  nextPreflightAtMs: number;
  finalSessionCheckDone: boolean;
  /** The extra preflight before firing (see RunnerOptions.finalPreflightLeadMs) was already started. */
  finalPreflightStarted: boolean;
}

export interface RunnerContext {
  readonly deps: SniperRunnerDeps;
  readonly opts: RunnerOptions;
  readonly events: EventQueue;
  readonly warms: Map<number, WarmState>;
  readonly logger: SniperLogger;
  /** Firing starts this long before the window opens (FireOptions.leadMs). */
  readonly fireLeadMs: number;
  abort: AbortController;
  /** A login was done in this process and not seen to fail since. */
  sessionReady: boolean;
  lastSessionActivityAtMs: number;
}

export const newWarmState = (nowMs: number): WarmState => ({
  account: null,
  requiredCents: null,
  requiredIsEstimate: true,
  ready: false,
  failure: null,
  announced: null,
  authAttempts: 0,
  clockWarned: false,
  nextPreflightAtMs: nowMs,
  finalSessionCheckDone: false,
  finalPreflightStarted: false,
});
