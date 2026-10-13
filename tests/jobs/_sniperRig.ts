/**
 * Runs the REAL sniper entry points (runFiring, recoverJobs) against the REAL SqliteJobStore. The sniper tests use
 * a permissive in-memory store; this rig is what proves that the call patterns of the sniper are legal for the
 * store matrix. Everything is synthetic: fake api, virtual clock, no network.
 */
import { buildHolidaySet } from '../../src/config/holidays.js';
import type {
  BookRequest,
  BookResult,
  DaySchedule,
  FormGate,
  Job,
  JobEvent,
  JobState,
  ReservaplayApi,
} from '../../src/contracts.js';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { createEventQueue, type EventQueue } from '../../src/sniper/events.js';
import { runFiring, type FireDeps, type FireResult } from '../../src/sniper/fire.js';
import { recoverJobs, type RecoveryDeps, type RecoveryReport } from '../../src/sniper/recovery.js';
import {
  date,
  driveTo,
  emptyDay,
  makeClock,
  makeLogger,
  newJob,
  OPENS_20_OCT,
  track,
  type FakeClock,
  type RecordingLogger,
} from './_helpers.js';

const GATE_HASH = 'b'.repeat(40);
const ACCOUNT = { accountId: 12345, hash: 'c'.repeat(40) };

export interface ApiScript {
  readonly probeForm?: () => Promise<FormGate>;
  readonly book?: (request: BookRequest, call: number) => Promise<BookResult>;
  readonly getDay?: () => Promise<DaySchedule>;
}

export interface ScriptedApi extends ReservaplayApi {
  readonly booked: BookRequest[];
}

const unused = async (): Promise<never> => {
  throw new Error('not used by this test');
};

const makeSniperApi = (script: ApiScript): ScriptedApi => {
  const booked: BookRequest[] = [];
  return {
    booked,
    login: async () => undefined,
    keepAlive: async () => undefined,
    getDay: script.getDay ?? (async (gameDate) => emptyDay(gameDate)),
    probeForm: script.probeForm ?? (async () => ({ kind: 'open', hash: GATE_HASH })),
    getAccountContext: unused,
    getWallet: async () => ({ balanceCents: 5000 }),
    quote: async () => ({ totalCents: 1902, walletPayable: true }),
    book: async (request) => {
      booked.push(request);
      return script.book ? script.book(request, booked.length) : { kind: 'booked', reservationId: 7 };
    },
    cancel: unused,
  };
};

export interface SniperRig {
  readonly store: SqliteJobStore;
  readonly clock: FakeClock;
  readonly logger: RecordingLogger;
  readonly api: ScriptedApi;
  readonly events: JobEvent[];
  /** A fresh job, driven through the legal path to `state` at the rig clock. */
  job(state: JobState, overrides?: Partial<Parameters<typeof newJob>[0]>): Job;
  fire(job: Job, deps?: Partial<FireDeps>): Promise<FireResult>;
  recover(options?: RecoveryDeps['options']): Promise<RecoveryReport>;
  stored(id: number): Job;
}

/** Clock starts five seconds after 07:00 Madrid on 13 Oct 2026, i.e. inside the window of 20 Oct. */
export const makeSniperRig = (script: ApiScript = {}): SniperRig => {
  const store = track(new SqliteJobStore(':memory:'));
  const clock = makeClock(OPENS_20_OCT + 5_000);
  const logger = makeLogger();
  const api = makeSniperApi(script);
  const events: JobEvent[] = [];
  const queue: EventQueue = createEventQueue({ emit: async (event) => void events.push(event) }, logger);

  const stored = (id: number): Job => {
    const job = store.get(id);
    if (job === undefined) throw new Error('job vanished');
    return job;
  };

  return {
    store,
    clock,
    logger,
    api,
    events,
    job: (state, overrides = {}) => {
      const created = store.create(newJob({ gameDate: date('2026-10-20'), ...overrides }), OPENS_20_OCT, clock.nowMs());
      return driveTo(store, created.id, state, clock.nowMs());
    },
    fire: async (job, deps = {}) => {
      const result = await runFiring(job, {
        api,
        clock,
        store,
        events: queue,
        holidays: buildHolidaySet(undefined),
        logger,
        account: ACCOUNT,
        ...deps,
      });
      await queue.flush();
      return result;
    },
    recover: async (options) => {
      const report = await recoverJobs({
        api,
        clock,
        store,
        events: { emit: async (event) => void events.push(event) },
        logger,
        ...(options === undefined ? {} : { options }),
      });
      return report;
    },
    stored,
  };
};
