/**
 * Fakes for the sniper tests: a virtual-time clock (sleep advances time, nothing is real), a scriptable
 * ReservaplayApi that records concurrency and the probe/book discipline, a Map-based JobStore that honours the
 * JobStore contract (optimistic transitions), a recording event sink and logger. All data is synthetic.
 */
import { DateTime } from 'luxon';
import { expect } from 'vitest';
import { parseGameDate, type GameDate } from '../../src/config/gameDate.js';
import { CLUB_LUXON_OPTIONS } from '../../src/config/timezone.js';
import {
  DuplicateActiveJobError,
  ACTIVE_JOB_STATES,
  type AccountContext,
  type BookRequest,
  type BookResult,
  type CancelResult,
  type Clock,
  type DaySchedule,
  type FormGate,
  type Job,
  type JobEvent,
  type JobEventSink,
  type JobPatch,
  type JobState,
  type JobStore,
  type NewJob,
  type PriceQuote,
  type ReservaplayApi,
  type SlotChoice,
  type SlotRef,
  type WalletInfo,
} from '../../src/contracts.js';
import type { PaymentMode } from '../../src/reservaplay/bookingBody.js';
import { createSystemClock, type ClockCalibration, type OffsetObservation, type SystemClock } from '../../src/sniper/clock.js';
import { createEventQueue } from '../../src/sniper/events.js';
import { bookingOpensAt } from '../../src/sniper/openTime.js';
import type { SniperLogger } from '../../src/sniper/types.js';
import { FAKE_HASH } from '../qa/_helpers.js';

export { FAKE_HASH };
/** Synthetic hashes that differ from FAKE_HASH (never 40 hex characters written out in source). */
export const GATE_HASH = 'b'.repeat(40);
export const SECOND_GATE_HASH = 'c'.repeat(40);
export const ACCOUNT_ID = 12345;
export const ACCOUNT: AccountContext = { accountId: ACCOUNT_ID, hash: FAKE_HASH };

/** Tuesday: the academy courts (1, 2, 3, 7, 8) are forbidden, 4 and 9-12 are allowed. */
export const GAME_DATE = parseGameDate('2026-10-20');
export const OPENS_AT_MS = bookingOpensAt(GAME_DATE).toMillis();
export const HOUR_MS = 3_600_000;

export const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------------------------

export interface FakeClockOptions {
  /** Server time minus PC time: a positive skew means the PC clock runs behind the server. */
  readonly skewMs?: number;
  /** Feed server readings into the real median calibration (off by default so timelines stay exact). */
  readonly applyObservations?: boolean;
}

export class FakeClock implements Clock, ClockCalibration {
  readonly sleeps: number[] = [];
  readonly observations: { serverTimeMs: number; receivedAtLocalMs: number; roundTripMs: number }[] = [];
  private wall: number;
  private mono = 5_000;
  private readonly skewMs: number;
  private readonly applyObservations: boolean;
  private readonly calibrated: SystemClock;

  constructor(startMs: number, options: FakeClockOptions = {}) {
    this.wall = startMs;
    this.skewMs = options.skewMs ?? 0;
    this.applyObservations = options.applyObservations ?? false;
    this.calibrated = createSystemClock({ wallNowMs: () => this.wall, monotonicMs: () => this.mono });
  }

  nowMs = (): number => this.calibrated.nowMs();
  localNowMs = (): number => this.wall;
  monotonicMs = (): number => this.mono;
  offsetMs = (): number => this.calibrated.offsetMs();
  /** The real server time right now (what the site's own clock shows), independent of what the bot believes. */
  serverNowMs = (): number => this.wall + this.skewMs;

  advance(ms: number): void {
    this.wall += ms;
    this.mono += ms;
  }

  /** Moves the bot's corrected time to `targetMs` (for tests that start somewhere else). */
  setNow(targetMs: number): void {
    this.advance(targetMs - this.nowMs());
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.advance(Math.max(0, ms));
    await yieldToEventLoop();
  }

  observeServerTime(serverTimeMs: number, receivedAtLocalMs: number, roundTripMs = 0): OffsetObservation {
    this.observations.push({ serverTimeMs, receivedAtLocalMs, roundTripMs });
    if (this.applyObservations) return this.calibrated.observeServerTime(serverTimeMs, receivedAtLocalMs, roundTripMs);
    return { accepted: true, absurd: false, sampleOffsetMs: 0, offsetMs: 0, sampleCount: this.observations.length };
  }

  maxSleepMs(): number {
    return this.sleeps.reduce((max, ms) => Math.max(max, ms), 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------------

export const ALLOWED_WEEKDAY_COURTS: readonly number[] = [4, 9, 10, 11, 12];

export interface DayOptions {
  readonly courts?: readonly number[];
  readonly startMinutes?: number;
  readonly durationMinutes?: number;
  /** `courtId@startMinutes` pairs that are not free. */
  readonly taken?: readonly SlotChoice[];
  /** Slots that belong to a reservation of the logged-in account (also not free). */
  readonly own?: readonly SlotChoice[];
}

const same = (a: SlotChoice, courtId: number, startMinutes: number): boolean =>
  a.courtId === courtId && a.startMinutes === startMinutes;

export const makeDay = (gameDate: GameDate, options: DayOptions = {}): DaySchedule => {
  const duration = options.durationMinutes ?? 90;
  const starts = [options.startMinutes ?? 1080, 1170];
  return {
    gameDate,
    courts: (options.courts ?? ALLOWED_WEEKDAY_COURTS).map((courtId) => ({
      courtId,
      name: `Court ${String(courtId)}`,
      slots: starts.map((startMinutes) => {
        const own = (options.own ?? []).some((slot) => same(slot, courtId, startMinutes));
        const taken = (options.taken ?? []).some((slot) => same(slot, courtId, startMinutes));
        return { startMinutes, endMinutes: startMinutes + duration, durationMinutes: duration, free: !own && !taken, ownBooking: own };
      }),
    })),
  };
};

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------

export type ApiMethod = 'login' | 'keepAlive' | 'getDay' | 'probeForm' | 'getAccountContext' | 'getWallet' | 'quote' | 'book' | 'cancel';

export interface ApiCall {
  readonly name: ApiMethod;
  readonly atMs: number;
  readonly monoMs: number;
  /** Real server time at the call (see FakeClock.serverNowMs). */
  readonly serverMs: number;
  readonly gameDate?: GameDate;
  readonly courtId?: number;
}

export interface ApiScript {
  readonly login?: (nth: number) => void;
  readonly keepAlive?: (nth: number) => void;
  readonly getDay?: (date: GameDate, nth: number) => DaySchedule;
  readonly probeForm?: (slot: SlotRef, nth: number) => FormGate;
  readonly getAccountContext?: (sample: SlotRef, nth: number) => AccountContext;
  readonly getWallet?: (nth: number) => WalletInfo;
  readonly quote?: (slot: SlotRef, payment: PaymentMode, nth: number) => PriceQuote;
  readonly book?: (request: BookRequest, nth: number) => BookResult;
}

/**
 * Picks the nth item, repeating the last one forever. Usable as any script hook: the call counter is the
 * last argument of every hook (`(nth)`, `(slot, nth)`, `(request, nth)`).
 */
export const bySequence =
  <T>(items: readonly T[]) =>
  (first: unknown, second?: unknown): T => {
    const nth = typeof second === 'number' ? second : Number(first);
    const item = items[Math.min(nth, items.length - 1)];
    if (item === undefined) throw new Error('empty sequence');
    return item;
  };

export const openGate = (hash: string = GATE_HASH): FormGate => ({ kind: 'open', hash });

export const closedGate = (clock: FakeClock): FormGate => ({
  kind: 'window_closed',
  serverCheckTime: DateTime.fromMillis(Math.floor(clock.serverNowMs() / 1000) * 1000, CLUB_LUXON_OPTIONS),
});

/** A probe script that behaves like the real site: closed until `opensAtMs`, open afterwards. */
export const gateAt =
  (clock: FakeClock, opensAtMs: number, hash: string = GATE_HASH) =>
  (): FormGate =>
    clock.serverNowMs() >= opensAtMs ? openGate(hash) : closedGate(clock);

export class FakeApi implements ReservaplayApi {
  readonly calls: ApiCall[] = [];
  readonly bookRequests: BookRequest[] = [];
  latencyMs: Partial<Record<ApiMethod, number>> = {};
  active = 0;
  maxActive = 0;
  activeBooks = 0;
  maxActiveBooks = 0;
  /** book() calls made while the latest probe result was not `open`. */
  bookWithoutOpenProbe = 0;
  /** book() calls that did not consume a fresh open probe (each open probe may authorise ONE book()). */
  bookWithoutFreshProbe = 0;
  private lastProbeKind: FormGate['kind'] | null = null;
  private freshOpenProbe = false;
  private counts = new Map<ApiMethod, number>();

  constructor(
    readonly clock: FakeClock,
    public script: ApiScript = {},
  ) {}

  count(name: ApiMethod): number {
    return this.calls.filter((call) => call.name === name).length;
  }

  callsOf(name: ApiMethod): readonly ApiCall[] {
    return this.calls.filter((call) => call.name === name);
  }

  private nth(name: ApiMethod): number {
    const n = this.counts.get(name) ?? 0;
    this.counts.set(name, n + 1);
    return n;
  }

  private async run<T>(name: ApiMethod, extra: Partial<ApiCall>, produce: (nth: number) => T): Promise<T> {
    const nth = this.nth(name);
    this.calls.push({ name, atMs: this.clock.nowMs(), monoMs: this.clock.monotonicMs(), serverMs: this.clock.serverNowMs(), ...extra });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await yieldToEventLoop();
      this.clock.advance(this.latencyMs[name] ?? 0);
      return produce(nth);
    } finally {
      this.active--;
    }
  }

  login = (): Promise<void> => this.run('login', {}, (nth) => this.script.login?.(nth));
  keepAlive = (): Promise<void> => this.run('keepAlive', {}, (nth) => this.script.keepAlive?.(nth));

  getDay = (gameDate: GameDate): Promise<DaySchedule> =>
    this.run('getDay', { gameDate }, (nth) => this.script.getDay?.(gameDate, nth) ?? makeDay(gameDate));

  probeForm = (slot: SlotRef): Promise<FormGate> =>
    this.run('probeForm', { gameDate: slot.gameDate, courtId: slot.courtId }, (nth) => {
      const gate = this.script.probeForm?.(slot, nth) ?? openGate();
      this.lastProbeKind = gate.kind;
      this.freshOpenProbe = gate.kind === 'open';
      return gate;
    });

  getAccountContext = (sample: SlotRef): Promise<AccountContext> =>
    this.run('getAccountContext', { gameDate: sample.gameDate, courtId: sample.courtId }, (nth) =>
      this.script.getAccountContext?.(sample, nth) ?? ACCOUNT,
    );

  getWallet = (): Promise<WalletInfo> =>
    this.run('getWallet', {}, (nth) => this.script.getWallet?.(nth) ?? { balanceCents: 10_000 });

  quote = (slot: SlotRef, payment: PaymentMode): Promise<PriceQuote> =>
    this.run('quote', { gameDate: slot.gameDate, courtId: slot.courtId }, (nth) =>
      this.script.quote?.(slot, payment, nth) ?? { totalCents: 1902, walletPayable: true },
    );

  book = async (request: BookRequest): Promise<BookResult> => {
    this.bookRequests.push(request);
    if (this.lastProbeKind !== 'open') this.bookWithoutOpenProbe++;
    if (!this.freshOpenProbe) this.bookWithoutFreshProbe++;
    this.freshOpenProbe = false;
    this.activeBooks++;
    this.maxActiveBooks = Math.max(this.maxActiveBooks, this.activeBooks);
    try {
      return await this.run('book', { gameDate: request.slot.gameDate, courtId: request.slot.courtId }, (nth) =>
        this.script.book?.(request, nth) ?? { kind: 'booked', reservationId: 100_002 },
      );
    } finally {
      this.activeBooks--;
    }
  };

  cancel = (): Promise<CancelResult> => this.run('cancel', {}, () => ({ kind: 'failed', reason: 'never expected' }));
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

export interface Transition {
  readonly id: number;
  readonly from: JobState;
  readonly to: JobState;
  readonly atMs: number;
  readonly patch: JobPatch | undefined;
}

export class MapJobStore implements JobStore {
  readonly transitions: Transition[] = [];
  private readonly jobs = new Map<number, Job>();
  private nextId = 1;
  private stopped = false;
  /** Called at the start of every isStopped() read (for "stop flag raised at the worst moment" tests). */
  onIsStopped: (() => void) | undefined;

  create(job: NewJob, opensAtMs: number, nowMs: number): Job {
    if ([...this.jobs.values()].some((other) => other.gameDate === job.gameDate && ACTIVE_JOB_STATES.includes(other.state))) {
      throw new DuplicateActiveJobError(job.gameDate);
    }
    const created: Job = {
      ...job,
      id: this.nextId++,
      state: 'scheduled',
      opensAtMs,
      reservationId: null,
      bookedChoice: null,
      failureReason: null,
      attempts: 0,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.jobs.set(created.id, created);
    return created;
  }

  /** Inserts a job exactly as given (any state), for arranging tests. */
  insert(job: Job): Job {
    this.jobs.set(job.id, job);
    this.nextId = Math.max(this.nextId, job.id + 1);
    return job;
  }

  get(id: number): Job | undefined {
    return this.jobs.get(id);
  }

  list(filter?: { readonly states?: readonly JobState[] }): readonly Job[] {
    const all = [...this.jobs.values()];
    const states = filter?.states;
    return states === undefined ? all : all.filter((job) => states.includes(job.state));
  }

  transition(id: number, from: JobState | readonly JobState[], to: JobState, nowMs: number, patch?: JobPatch): Job | undefined {
    const current = this.jobs.get(id);
    const allowed: readonly JobState[] = typeof from === 'string' ? [from] : from;
    if (current === undefined || !allowed.includes(current.state)) return undefined;
    const updated: Job = {
      ...current,
      state: to,
      updatedAtMs: nowMs,
      reservationId: patch?.reservationId ?? current.reservationId,
      bookedChoice: patch?.bookedChoice ?? current.bookedChoice,
      failureReason: patch?.failureReason ?? current.failureReason,
      attempts: current.attempts + (patch?.attemptsDelta ?? 0),
    };
    this.jobs.set(id, updated);
    this.transitions.push({ id, from: current.state, to, atMs: nowMs, patch });
    return updated;
  }

  isStopped(): boolean {
    this.onIsStopped?.();
    return this.stopped;
  }

  setStopped(stopped: boolean): void {
    this.stopped = stopped;
  }

  statesOf(id: number): readonly JobState[] {
    return this.transitions.filter((t) => t.id === id).map((t) => t.to);
  }
}

// ---------------------------------------------------------------------------------------------
// Events and logging
// ---------------------------------------------------------------------------------------------

export class RecordingSink implements JobEventSink {
  readonly events: JobEvent[] = [];
  /** Job state in the store at the instant each event was delivered. */
  readonly storeStates: (JobState | undefined)[] = [];
  failWith: Error | undefined;

  constructor(private readonly store?: JobStore) {}

  async emit(event: JobEvent): Promise<void> {
    this.events.push(event);
    this.storeStates.push(this.store?.get(event.job.id)?.state);
    if (this.failWith !== undefined) throw this.failWith;
    await yieldToEventLoop();
  }

  kinds(): string[] {
    return this.events.map((event) => event.kind);
  }

  ofKind<K extends JobEvent['kind']>(kind: K): Extract<JobEvent, { kind: K }>[] {
    return this.events.filter((event): event is Extract<JobEvent, { kind: K }> => event.kind === kind);
  }
}

export class RecordingLogger implements SniperLogger {
  readonly entries: { level: string; obj: object; msg: string }[] = [];
  debug = (obj: object, msg: string): void => void this.entries.push({ level: 'debug', obj, msg });
  info = (obj: object, msg: string): void => void this.entries.push({ level: 'info', obj, msg });
  warn = (obj: object, msg: string): void => void this.entries.push({ level: 'warn', obj, msg });
  error = (obj: object, msg: string): void => void this.entries.push({ level: 'error', obj, msg });

  /** Everything ever logged as one string, to assert that no secret leaked. */
  dump(): string {
    return JSON.stringify(this.entries);
  }

  count(level: string): number {
    return this.entries.filter((entry) => entry.level === level).length;
  }
}

// ---------------------------------------------------------------------------------------------
// Jobs and rigs
// ---------------------------------------------------------------------------------------------

export const CHOICE_A: SlotChoice = { courtId: 9, startMinutes: 1080 };
export const CHOICE_B: SlotChoice = { courtId: 10, startMinutes: 1080 };

export const makeJob = (overrides: Partial<Job> = {}): Job => ({
  id: 1,
  gameDate: GAME_DATE,
  choices: [CHOICE_A, CHOICE_B],
  durationMinutes: 90,
  payment: 'wallet',
  state: 'firing',
  opensAtMs: OPENS_AT_MS,
  reservationId: null,
  bookedChoice: null,
  failureReason: null,
  attempts: 0,
  createdAtMs: OPENS_AT_MS - 86_400_000,
  updatedAtMs: OPENS_AT_MS - 3000,
  ...overrides,
});

export const NO_HOLIDAYS: ReadonlySet<GameDate> = new Set<GameDate>();

export interface Rig {
  readonly clock: FakeClock;
  readonly api: FakeApi;
  readonly store: MapJobStore;
  readonly sink: RecordingSink;
  readonly logger: RecordingLogger;
  readonly queue: ReturnType<typeof createEventQueue>;
}

/** A rig whose clock starts at `startMs` (default: 20 s before the window opens). */
export const makeRig = (script: ApiScript = {}, startMs: number = OPENS_AT_MS - 20_000, clockOptions: FakeClockOptions = {}): Rig => {
  const clock = new FakeClock(startMs, clockOptions);
  const store = new MapJobStore();
  const sink = new RecordingSink(store);
  const logger = new RecordingLogger();
  return { clock, api: new FakeApi(clock, script), store, sink, logger, queue: createEventQueue(sink, logger) };
};

/**
 * Request pacing as the account sees it: every request starts at least 250 ms after the previous one, except a
 * booking request that directly follows the probe which opened the gate (it must not be delayed), and no more
 * than 4 requests per second apart from those bookings.
 */
export const expectPacing = (calls: readonly ApiCall[], label = 'pacing'): void => {
  for (let i = 1; i < calls.length; i++) {
    const call = calls[i];
    const previous = calls[i - 1];
    if (call === undefined || previous === undefined || call.name === 'book') continue;
    expect(call.monoMs - previous.monoMs, `${label}: gap before ${call.name} #${String(i)}`).toBeGreaterThanOrEqual(250);
  }
  const others = calls.filter((call) => call.name !== 'book').map((call) => call.monoMs);
  for (const start of others) {
    expect(others.filter((other) => other >= start && other < start + 1000).length, label).toBeLessThanOrEqual(4);
  }
};
