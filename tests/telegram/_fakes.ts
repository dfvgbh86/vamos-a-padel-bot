/**
 * Fakes for the Telegram module tests: a fake JobService and a fake Clock. Nothing here talks to a network.
 * All values are synthetic (fake names, fake ids).
 */
import { allowedCourtIds } from '../../src/config/courts.js';
import { parseGameDate, type GameDate } from '../../src/config/gameDate.js';
import { buildHolidaySet } from '../../src/config/holidays.js';
import type {
  CancelJobResult,
  Clock,
  CreateJobInput,
  CreateJobResult,
  DaySchedule,
  Job,
  JobService,
  SlotChoice,
  StatusReport,
  WalletInfo,
} from '../../src/contracts.js';

export const holidays = buildHolidaySet(undefined);
export const date = parseGameDate;

/** 2026-10-13 08:00 in Madrid (CEST, UTC+2): the window for 2026-10-20 is open, 2026-10-21 opens tomorrow 07:00. */
export const NOW_MS = Date.UTC(2026, 9, 13, 6, 0, 0);
/** 2026-10-14 07:00 Madrid. */
export const OPENS_21_MS = Date.UTC(2026, 9, 14, 5, 0, 0);

export class FakeClock implements Clock {
  sleepMode: 'never' | 'immediate' = 'never';
  /** Every `ms` ever passed to sleep(), in order: lets tests pin the deadlines the module chooses. */
  readonly sleeps: number[] = [];

  constructor(public now: number = NOW_MS) {}

  nowMs(): number {
    return this.now;
  }

  monotonicMs(): number {
    return this.now;
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    return this.sleepMode === 'immediate' ? Promise.resolve() : new Promise<void>(() => undefined);
  }
}

export interface StartSpec {
  readonly start: number;
  readonly free?: boolean;
  readonly duration?: number;
  readonly ownBooking?: boolean;
}

/** Slots back to back from the given start times (90 minutes each unless stated). */
export const daySchedule = (
  gameDate: GameDate,
  courts: Readonly<Record<number, readonly (number | StartSpec)[]>>,
): DaySchedule => ({
  gameDate,
  courts: Object.entries(courts).map(([courtId, specs]) => ({
    courtId: Number(courtId),
    name: `Court ${courtId}`,
    slots: specs.map((spec) => {
      const { start, free = true, duration = 90, ownBooking = false } = typeof spec === 'number' ? { start: spec } : spec;
      return { startMinutes: start, endMinutes: start + duration, durationMinutes: duration, free, ownBooking };
    }),
  })),
});

export const makeJob = (patch: Partial<Job> = {}): Job => ({
  id: 7,
  gameDate: date('2026-10-20'),
  choices: [{ courtId: 9, startMinutes: 1080 }],
  durationMinutes: 90,
  payment: 'wallet',
  state: 'scheduled',
  opensAtMs: NOW_MS,
  reservationId: null,
  bookedChoice: null,
  failureReason: null,
  attempts: 0,
  createdAtMs: NOW_MS,
  updatedAtMs: NOW_MS,
  ...patch,
});

export const createdResult = (
  patch: Partial<Extract<CreateJobResult, { kind: 'created' }>> = {},
  job: Partial<Job> = {},
): CreateJobResult => ({
  kind: 'created',
  job: makeJob(job),
  walletCents: 5000,
  requiredCents: 1902,
  requiredIsEstimate: false,
  fundsOk: true,
  ...patch,
});

/** A JobService whose behaviour tests configure; every call is recorded. */
export class FakeJobService implements JobService {
  readonly createJobCalls: CreateJobInput[] = [];
  readonly cancelCalls: number[] = [];
  readonly getDayCalls: GameDate[] = [];
  readonly calls: string[] = [];
  jobs: Job[] = [];
  schedules = new Map<string, DaySchedule>();
  getDayFails = new Set<string>();
  hangGetDay = false;
  walletCents = 1902;
  walletFails = false;
  createResult: (input: CreateJobInput) => Promise<CreateJobResult> | CreateJobResult = () => createdResult();
  cancelResult: (id: number) => Promise<CancelJobResult> | CancelJobResult = (id) => ({
    kind: 'cancelled',
    job: makeJob({ id, state: 'cancelled' }),
  });
  statusReport: StatusReport = {
    stopped: false,
    sessionAlive: true,
    walletCents: 1902,
    activeJobs: [],
    upcomingHolidays: [],
    nextWindowOpensAtMs: null,
  };
  stopAllThrows = false;

  allowedCourts(gameDate: GameDate): readonly number[] {
    return allowedCourtIds(gameDate, holidays);
  }

  async getDay(gameDate: GameDate): Promise<DaySchedule> {
    this.getDayCalls.push(gameDate);
    if (this.hangGetDay) return new Promise<DaySchedule>(() => undefined);
    const schedule = this.schedules.get(gameDate);
    if (this.getDayFails.has(gameDate) || schedule === undefined) throw new Error(`no schedule for ${gameDate}`);
    return schedule;
  }

  async createJob(input: CreateJobInput): Promise<CreateJobResult> {
    this.createJobCalls.push(input);
    return this.createResult(input);
  }

  listJobs(): readonly Job[] {
    this.calls.push('listJobs');
    return this.jobs;
  }

  async cancelJob(id: number): Promise<CancelJobResult> {
    this.cancelCalls.push(id);
    return this.cancelResult(id);
  }

  async status(): Promise<StatusReport> {
    this.calls.push('status');
    return this.statusReport;
  }

  async wallet(): Promise<WalletInfo> {
    this.calls.push('wallet');
    if (this.walletFails) throw new Error('wallet unavailable');
    return { balanceCents: this.walletCents };
  }

  stopAll(): void {
    this.calls.push('stopAll');
    if (this.stopAllThrows) throw new Error('store is locked');
  }

  resumeAll(): void {
    this.calls.push('resumeAll');
  }
}

export const choice = (courtId: number, startMinutes: number): SlotChoice => ({ courtId, startMinutes });
