import type { GameDate } from '../../src/config/gameDate.js';
import { buildHolidaySet } from '../../src/config/holidays.js';
import type { CreateJobInput, CreateJobResult, JobService, JobStore } from '../../src/contracts.js';
import { createJobService } from '../../src/jobs/service.js';
import { SqliteJobStore } from '../../src/jobs/store.js';
import type { OpenRule } from '../../src/sniper/openTime.js';
import {
  date,
  makeApi,
  makeClock,
  makeLogger,
  NOW,
  track,
  type FakeApi,
  type FakeClock,
  type RecordingLogger,
} from './_helpers.js';

export interface Harness {
  readonly service: JobService;
  readonly store: SqliteJobStore;
  readonly api: FakeApi;
  readonly clock: FakeClock;
  readonly logger: RecordingLogger;
}

export interface HarnessOptions {
  readonly now?: number;
  readonly holidays?: ReadonlySet<GameDate>;
  readonly estimatedPriceCents?: number;
  readonly openRule?: OpenRule;
  /** Wraps the real in-memory store (to inject races). */
  readonly wrapStore?: (store: SqliteJobStore) => JobStore;
}

export const harness = (options: HarnessOptions = {}): Harness => {
  const store = track(new SqliteJobStore(':memory:'));
  const api = makeApi();
  const clock = makeClock(options.now ?? NOW);
  const logger = makeLogger();
  const service = createJobService({
    store: options.wrapStore ? options.wrapStore(store) : store,
    api,
    clock,
    holidays: options.holidays ?? buildHolidaySet(undefined),
    logger,
    ...(options.estimatedPriceCents === undefined ? {} : { estimatedPriceCents: options.estimatedPriceCents }),
    ...(options.openRule === undefined ? {} : { openRule: options.openRule }),
  });
  return { service, store, api, clock, logger };
};

/** Tuesday 20 Oct 2026, court 9 (Pista 7), 18:00: open at the default test clock. */
export const request = (overrides: Partial<CreateJobInput> = {}): CreateJobInput => ({
  gameDate: date('2026-10-20'),
  choices: [{ courtId: 9, startMinutes: 1080 }],
  ...overrides,
});

export const created = (result: CreateJobResult): Extract<CreateJobResult, { kind: 'created' }> => {
  if (result.kind !== 'created') throw new Error(`expected created, got rejected: ${result.reason} (${result.detail})`);
  return result;
};
