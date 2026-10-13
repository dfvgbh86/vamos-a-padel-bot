import type { Job, JobState } from '../../src/contracts.js';
import type { EventQueue } from '../../src/sniper/events.js';
import { runFiring, type FireDeps, type FireResult } from '../../src/sniper/fire.js';
import {
  ACCOUNT,
  NO_HOLIDAYS,
  OPENS_AT_MS,
  gateAt,
  makeJob,
  makeRig,
  type ApiMethod,
  type ApiScript,
  type FakeClock,
  type Rig,
} from './_fakes.js';

export interface FireSetupOptions {
  /** Defaults to a probe script that is closed until the window opens and open afterwards. */
  readonly script?: (clock: FakeClock) => ApiScript;
  readonly job?: Partial<Job>;
  /** Clock start relative to the opening instant (default: 20 s before). */
  readonly startOffsetMs?: number;
  readonly deps?: Partial<FireDeps>;
  readonly latency?: Partial<Record<ApiMethod, number>>;
}

export interface FireSetup extends Rig {
  readonly job: Job;
  readonly deps: FireDeps;
  /** Job state in the store at the instant each event was EMITTED (not delivered). */
  readonly emitStates: (JobState | undefined)[];
  /** Runs the firing loop to its end and delivers every event. */
  run(): Promise<FireResult>;
  stored(): Job;
}

export const setupFire = (options: FireSetupOptions = {}): FireSetup => {
  const rig = makeRig({}, OPENS_AT_MS + (options.startOffsetMs ?? -20_000));
  const script = options.script?.(rig.clock) ?? {};
  rig.api.script = { probeForm: gateAt(rig.clock, OPENS_AT_MS), ...script };
  rig.api.latencyMs = options.latency ?? {};
  const job = rig.store.insert(makeJob(options.job));
  const emitStates: (JobState | undefined)[] = [];
  const events: EventQueue = {
    emit: (event) => {
      emitStates.push(rig.store.get(event.job.id)?.state);
      rig.queue.emit(event);
    },
    flush: () => rig.queue.flush(),
  };
  const deps: FireDeps = {
    api: rig.api,
    clock: rig.clock,
    store: rig.store,
    events,
    holidays: NO_HOLIDAYS,
    logger: rig.logger,
    account: ACCOUNT,
    ...options.deps,
  };
  return {
    ...rig,
    job,
    deps,
    emitStates,
    run: async () => {
      const result = await runFiring(job, deps);
      await rig.queue.flush();
      return result;
    },
    stored: () => {
      const current = rig.store.get(job.id);
      if (current === undefined) throw new Error('job vanished');
      return current;
    },
  };
};
