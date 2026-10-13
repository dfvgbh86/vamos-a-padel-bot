/**
 * Shared fakes for the job store / service tests: a controllable clock, a recording logger, a fake ReservaPlay
 * API facade, temp-file helpers. Everything is synthetic (account ids, names); nothing touches the network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { parseGameDate, type GameDate } from '../../src/config/gameDate.js';
import type {
  Clock,
  DaySchedule,
  Job,
  JobState,
  JobStore,
  NewJob,
  PriceQuote,
  SlotRef,
  WalletInfo,
} from '../../src/contracts.js';
import type { JobsLogger } from '../../src/jobs/logger.js';
import type { PaymentMode } from '../../src/reservaplay/bookingBody.js';

export const date = parseGameDate;

/** Tuesday 13 Oct 2026, 08:00 in Madrid (06:00Z): the window of Tuesday 20 Oct opened an hour ago. */
export const NOW = Date.UTC(2026, 9, 13, 6, 0, 0);
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** 07:00 Madrid on 13 Oct 2026 (UTC+2): when 20 Oct opened. */
export const OPENS_20_OCT = Date.UTC(2026, 9, 13, 5, 0, 0);

export interface FakeClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

export const makeClock = (startMs = NOW): FakeClock => {
  let now = startMs;
  return {
    nowMs: () => now,
    monotonicMs: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    set: (ms) => {
      now = ms;
    },
    advance: (ms) => {
      now += ms;
    },
  };
};

export interface RecordingLogger extends JobsLogger {
  readonly debug: ReturnType<typeof vi.fn>;
  readonly info: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly error: ReturnType<typeof vi.fn>;
  /** Everything logged so far as one string, to assert that nothing sensitive reached the logs. */
  dump(): string;
}

export const makeLogger = (): RecordingLogger => {
  const debug = vi.fn();
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  return { debug, info, warn, error, dump: () => JSON.stringify([debug, info, warn, error].map((fn) => fn.mock.calls)) };
};

export const newJob = (overrides: Partial<NewJob> = {}): NewJob => ({
  gameDate: date('2026-10-20'),
  choices: [
    { courtId: 9, startMinutes: 1080 },
    { courtId: 10, startMinutes: 1080 },
  ],
  durationMinutes: 90,
  payment: 'wallet',
  ...overrides,
});

const FORWARD_PATH: Readonly<Record<JobState, readonly JobState[]>> = {
  scheduled: [],
  warming: ['warming'],
  firing: ['warming', 'firing'],
  booked: ['warming', 'firing', 'booked'],
  needs_payment: ['warming', 'firing', 'needs_payment'],
  failed: ['failed'],
  cancelled: ['cancelled'],
  expired: ['expired'],
};

/** Walks a fresh (`scheduled`) job to `target` through legal transitions only. */
export const driveTo = (store: JobStore, id: number, target: JobState, nowMs = NOW): Job => {
  let previous: JobState = 'scheduled';
  for (const next of FORWARD_PATH[target]) {
    if (store.transition(id, previous, next, nowMs) === undefined) throw new Error(`could not drive ${previous} -> ${next}`);
    previous = next;
  }
  const job = store.get(id);
  if (job === undefined) throw new Error('job vanished');
  return job;
};

export const emptyDay = (gameDate: GameDate, ownBooking = false): DaySchedule => ({
  gameDate,
  courts: [
    {
      courtId: 9,
      name: 'Pista 7 semicubierta',
      slots: [
        { startMinutes: 1080, endMinutes: 1170, durationMinutes: 90, free: !ownBooking, ownBooking },
        { startMinutes: 1170, endMinutes: 1260, durationMinutes: 90, free: true, ownBooking: false },
      ],
    },
    { courtId: 10, name: 'Pista 8 exterior', slots: [{ startMinutes: 1080, endMinutes: 1170, durationMinutes: 90, free: true, ownBooking: false }] },
  ],
});

export const makeApi = () => ({
  getDay: vi.fn<(gameDate: GameDate) => Promise<DaySchedule>>(async (gameDate) => emptyDay(gameDate)),
  getWallet: vi.fn<() => Promise<WalletInfo>>(async () => ({ balanceCents: 5000 })),
  quote: vi.fn<(slot: SlotRef, payment: PaymentMode) => Promise<PriceQuote>>(async () => ({
    totalCents: 1902,
    walletPayable: true,
  })),
  keepAlive: vi.fn<() => Promise<void>>(async () => undefined),
});
export type FakeApi = ReturnType<typeof makeApi>;

/** Number of calls to any API method: used to prove an operation never touches the site. */
export const apiCallCount = (api: FakeApi): number =>
  api.getDay.mock.calls.length + api.getWallet.mock.calls.length + api.quote.mock.calls.length + api.keepAlive.mock.calls.length;

// --- temp files ----------------------------------------------------------------------------------

const closables: { close(): void }[] = [];
const tempDirs: string[] = [];

export const track = <T extends { close(): void }>(resource: T): T => {
  closables.push(resource);
  return resource;
};

export const tempDbPath = (name = 'jobs.sqlite'): string => {
  const dir = mkdtempSync(join(tmpdir(), 'padel-jobs-test-'));
  tempDirs.push(dir);
  return join(dir, name);
};

export const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'padel-jobs-test-'));
  tempDirs.push(dir);
  return dir;
};

export const cleanupTemp = (): void => {
  for (const resource of closables.splice(0)) {
    try {
      resource.close();
    } catch {
      continue;
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
};

/** Second, independent connection to a database file (to corrupt rows or to inspect pragmas). */
export const rawDb = (path: string) => {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  return track(new DatabaseSync(path));
};
