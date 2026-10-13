import type { GameDate } from '../../src/config/gameDate.js';
import type { Job, NewJob } from '../../src/contracts.js';
import { bookingOpensAt } from '../../src/sniper/openTime.js';
import { createSniperRunner, type RunnerOptions, type SniperRunner, type SniperRunnerDeps } from '../../src/sniper/runner.js';
import {
  CHOICE_A,
  CHOICE_B,
  GAME_DATE,
  NO_HOLIDAYS,
  gateAt,
  makeRig,
  yieldToEventLoop,
  type ApiMethod,
  type ApiScript,
  type FakeClock,
  type FakeClockOptions,
  type Rig,
} from './_fakes.js';

export const MINUTE = 60_000;

export interface RunnerSetupOptions {
  readonly gameDate?: GameDate;
  /** Clock start relative to the opening instant of `gameDate` (default: 15 minutes before). */
  readonly startOffsetMs?: number;
  readonly script?: (clock: FakeClock, opensAtMs: number) => ApiScript;
  /** false = do not create a job. */
  readonly job?: Partial<NewJob> | false;
  readonly deps?: Partial<SniperRunnerDeps>;
  readonly options?: Partial<RunnerOptions>;
  readonly clock?: FakeClockOptions;
  readonly latency?: Partial<Record<ApiMethod, number>>;
}

export interface RunnerSetup extends Rig {
  readonly runner: SniperRunner;
  readonly opensAtMs: number;
  readonly job: Job | undefined;
  /** Ticks once a second until the corrected clock reaches `untilMs`, then delivers the pending events. */
  drive(untilMs: number): Promise<void>;
  stored(id?: number): Job;
  /** Adds one more job (same defaults) for another game date. */
  addJob(gameDate: GameDate, overrides?: Partial<NewJob>): Job;
}

export const setupRunner = (options: RunnerSetupOptions = {}): RunnerSetup => {
  const gameDate = options.gameDate ?? GAME_DATE;
  const opensAtMs = bookingOpensAt(gameDate).toMillis();
  const rig = makeRig({}, opensAtMs + (options.startOffsetMs ?? -15 * MINUTE), options.clock);
  rig.api.script = { probeForm: gateAt(rig.clock, opensAtMs), ...options.script?.(rig.clock, opensAtMs) };
  rig.api.latencyMs = options.latency ?? {};

  const defaults = (date: GameDate): NewJob => ({
    gameDate: date,
    choices: [CHOICE_A, CHOICE_B],
    durationMinutes: 90,
    payment: 'wallet',
  });
  const addJob = (date: GameDate, overrides: Partial<NewJob> = {}): Job =>
    rig.store.create({ ...defaults(date), ...overrides }, bookingOpensAt(date).toMillis(), rig.clock.nowMs());
  const job = options.job === false ? undefined : addJob(gameDate, options.job);

  const runner = createSniperRunner({
    api: rig.api,
    clock: rig.clock,
    calibration: rig.clock,
    store: rig.store,
    events: rig.sink,
    holidays: NO_HOLIDAYS,
    logger: rig.logger,
    ...options.deps,
    ...(options.options === undefined ? {} : { options: options.options }),
  });

  return {
    ...rig,
    runner,
    opensAtMs,
    job,
    addJob,
    drive: async (untilMs) => {
      while (rig.clock.nowMs() < untilMs) {
        await runner.tick();
        await rig.clock.sleep(1000);
      }
      await runner.flushEvents();
    },
    stored: (id = job?.id ?? 1) => {
      const current = rig.store.get(id);
      if (current === undefined) throw new Error(`job ${String(id)} vanished`);
      return current;
    },
  };
};

/** Lets the event loop turn until `condition` holds (for tests that run the real start()/stop() loop). */
export const until = async (condition: () => boolean, maxTurns = 200_000): Promise<void> => {
  for (let turn = 0; turn < maxTurns; turn++) {
    if (condition()) return;
    await yieldToEventLoop();
  }
  throw new Error('condition not reached');
};
