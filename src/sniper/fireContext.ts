import type { GameDate } from '../config/gameDate.js';
import type { AccountContext, Clock, Job, JobStore, ReservaplayApi, SlotChoice, SlotRef } from '../contracts.js';
import type { EventQueue } from './events.js';
import { createPacer, type Pacer } from './clock.js';
import type { FireOptions } from './fireTypes.js';
import type { SniperLogger } from './types.js';

export interface FireDeps {
  readonly api: ReservaplayApi;
  /** Server-corrected clock. */
  readonly clock: Clock;
  readonly store: JobStore;
  readonly events: EventQueue;
  readonly holidays: ReadonlySet<GameDate>;
  readonly logger: SniperLogger;
  /** From preflight. Only `accountId` is used: the `hash` of every booking comes from the latest open gate. */
  readonly account: AccountContext;
  /** Card jobs are refused unless this is exactly true. */
  readonly allowCardPayment?: boolean;
  /** Shutdown signal: firing stops at the next step and leaves the job in `firing` for restart recovery. */
  readonly signal?: AbortSignal;
  readonly options?: Partial<FireOptions>;
}

/** Proof that the latest probe of a choice's form was `open`; consumed by exactly one booking request. */
export interface OpenGate {
  readonly hash: string;
  readonly choiceIndex: number;
}

export interface FireContext {
  readonly deps: FireDeps;
  readonly opts: FireOptions;
  readonly pace: Pacer;
  /** Indices (into job.choices) ruled out for this run. */
  readonly excluded: Set<number>;
  readonly deadlineMs: number;
  /** Latest job as returned by the store. */
  job: Job;
  openGate: OpenGate | null;
  relogins: number;
  /** add_event requests started in this run (every one was counted in the store before it was sent). */
  booksStarted: number;
  /** Of those, how many provably never left the machine. */
  notSent: number;
  /** Monotonic start of the current run of failed probes; null while the site answers. */
  probeOutageStartedMs: number | null;
  /** Consecutive form probes that gave a page nobody understands. */
  unknownFormStreak: number;
  windowAnnounced: boolean;
}

export const createFireContext = (job: Job, deps: FireDeps, opts: FireOptions): FireContext => ({
  deps,
  opts,
  pace: createPacer(deps.clock, opts.minRequestGapMs),
  excluded: new Set<number>(),
  deadlineMs: Math.max(job.opensAtMs, deps.clock.nowMs()) + opts.windowLimitMs,
  job,
  openGate: null,
  relogins: 0,
  booksStarted: 0,
  notSent: 0,
  probeOutageStartedMs: null,
  unknownFormStreak: 0,
  windowAnnounced: false,
});

/** add_event requests that may have reached the server (persisted attempts minus the ones that never left). */
export const sentAttempts = (ctx: FireContext): number => ctx.job.attempts - ctx.notSent;

export const slotFor = (job: Job, choice: SlotChoice): SlotRef => ({
  gameDate: job.gameDate,
  courtId: choice.courtId,
  startMinutes: choice.startMinutes,
  durationMinutes: job.durationMinutes,
});
