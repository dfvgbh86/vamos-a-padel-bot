/** Shared setup of the createApp tests: the app on a virtual clock, every part writing into one log. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { createApp, type AppStore } from '../../src/app.js';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { createFakeTransport } from '../telegram/_harness.js';
import { GAME_DAY, OPENS_MS, TEST_ENV } from './_rig.js';
import { FakeSite } from './_site.js';
import { createVirtualClock, type VirtualClock } from './_virtualClock.js';

/** Registers the cleanup hook of the calling test file; what is added is undone after every test, newest first. */
export const useCleanups = () => {
  const cleanups: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  return {
    add: (cleanup: () => void | Promise<void>): void => void cleanups.push(cleanup),
    tempDir: (): string => {
      const dir = mkdtempSync(join(tmpdir(), 'vamos-app-'));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      return dir;
    },
  };
};

/** A store that writes down what happens to it, into the same log as the other parts of the app. */
export const recordingStore = (inner: SqliteJobStore, log: string[]): AppStore => ({
  create: (job, opensAtMs, nowMs) => inner.create(job, opensAtMs, nowMs),
  get: (id) => inner.get(id),
  list: (filter) => {
    log.push(`store.list:${filter?.states?.join('+') ?? 'all'}`);
    return inner.list(filter);
  },
  transition: (id, from, to, nowMs, patch) => {
    log.push(`store.transition:${to}`);
    return inner.transition(id, from, to, nowMs, patch);
  },
  isStopped: () => inner.isStopped(),
  setStopped: (stopped) => inner.setStopped(stopped),
  close: () => {
    log.push('store.close');
    inner.close();
  },
});

export const seededFiringJob = (store: SqliteJobStore, nowMs: number): void => {
  const job = store.create({ gameDate: GAME_DAY, choices: [{ courtId: 9, startMinutes: 1080 }], durationMinutes: 90, payment: 'wallet' }, OPENS_MS, nowMs);
  store.transition(job.id, 'scheduled', 'warming', nowMs);
  store.transition(job.id, 'warming', 'firing', nowMs);
};

export interface Wired {
  readonly app: ReturnType<typeof createApp>;
  readonly log: string[];
  readonly inner: SqliteJobStore;
  readonly site: FakeSite;
  readonly clock: VirtualClock;
  /** app.stop(): the sniper loop sleeps on the virtual clock, so time has to pass for it to notice. */
  halt(): Promise<void>;
}

export const letTimePass = async (clock: VirtualClock, work: Promise<unknown>): Promise<void> => {
  await clock.advanceBy(10_000);
  await work;
};

/** The app on a virtual clock with every part writing into `log`. */
export const wire = (add: (cleanup: () => void) => void, options: { seedFiring?: boolean; allowedUserIds?: readonly number[] } = {}): Wired => {
  const clock = createVirtualClock(OPENS_MS + 10_000);
  const site = new FakeSite(clock);
  const inner = new SqliteJobStore(':memory:');
  if (options.seedFiring === true) seededFiringJob(inner, clock.nowMs());
  const log: string[] = [];
  const transport = createFakeTransport();
  const app = createApp(
    { ...TEST_ENV, ...(options.allowedUserIds === undefined ? {} : { allowedUserIds: options.allowedUserIds }) },
    {
      clock,
      api: site,
      store: recordingStore(inner, log),
      telegramTransformer: (prev, method, payload, signal) => {
        log.push(`telegram.${method}`);
        return transport.transformer(prev, method, payload, signal);
      },
    },
  );
  add(() => inner.close());
  return { app, log, inner, site, clock, halt: () => letTimePass(clock, app.stop()) };
};

