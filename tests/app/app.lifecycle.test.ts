/** createApp: in which order it starts and stops, and what happens when a part fails. */
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { createFakeTransport } from '../telegram/_harness.js';
import { START_MS, TEST_ENV, createRig } from './_rig.js';
import { FakeSite } from './_site.js';
import { createVirtualClock } from './_virtualClock.js';
import { letTimePass, recordingStore, useCleanups, wire as wireApp } from './_wire.js';

const { add, tempDir } = useCleanups();
const wire = (options: Parameters<typeof wireApp>[1] = {}) => wireApp(add, options);

describe('startup order', () => {
  it('opens the store, recovers jobs, starts the sniper, and only then connects Telegram', async () => {
    const { app, log, halt } = wire({ seedFiring: true });
    expect(log.some((line) => line.startsWith('telegram.'))).toBe(false);

    await app.start();
    const first = (line: string): number => log.indexOf(line);
    const recovery = first('store.transition:scheduled');
    const sniper = first('store.list:scheduled+warming');
    const telegram = first('telegram.getMe');
    expect(recovery).toBeGreaterThanOrEqual(0);
    expect(sniper).toBeGreaterThan(recovery);
    expect(telegram).toBeGreaterThan(sniper);
    await halt();
  });

  it('does not talk to Telegram or the site before start()', () => {
    const { app, log, site } = wire();
    expect(log.filter((line) => line.startsWith('telegram.'))).toEqual([]);
    expect(site.calls).toEqual([]);
    expect(app.telegram.bot.isRunning()).toBe(false);
  });

  it('exposes the parts it wired', () => {
    const { app } = wire();
    expect(typeof app.service.createJob).toBe('function');
    expect(typeof app.runner.tick).toBe('function');
    expect(typeof app.telegram.notifier.emit).toBe('function');
    expect(app.store.list()).toEqual([]);
  });

  it('refuses to start twice, or after it was stopped', async () => {
    const { app, halt } = wire();
    await app.start();
    await expect(app.start()).rejects.toThrow(/already started/);
    await halt();
    await expect(app.start()).rejects.toThrow(/stopped/);
  });

  it('logs the emergency stop flag at startup, so a persisted /stop is not a surprise', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'bot.sqlite');
    const first = createRig({ env: { dbPath } });
    await first.start();
    await first.owner.say('/stop');
    expect(first.app.store.isStopped()).toBe(true);
    await first.stop();

    const second = createRig({ env: { dbPath } });
    await second.start();
    expect(second.app.store.isStopped()).toBe(true);
    expect(second.logText()).toMatch(/"stopFlag":true/);
    await second.stop();
  });
});

describe('shutdown order', () => {
  it('stops Telegram, then the sniper, then closes the store', async () => {
    const { app, log, halt } = wire();
    await app.start();
    const order: string[] = [];
    const record = (name: string, original: () => Promise<void>) => async () => {
      order.push(name);
      await original();
    };
    const telegramStop = app.telegram.stop.bind(app.telegram);
    const runnerStop = app.runner.stop.bind(app.runner);
    vi.spyOn(app.telegram, 'stop').mockImplementation(record('telegram', telegramStop));
    vi.spyOn(app.runner, 'stop').mockImplementation(record('sniper', runnerStop));

    await halt();
    expect(order).toEqual(['telegram', 'sniper']);
    expect(log.at(-1)).toBe('store.close');
    expect(log.filter((line) => line === 'store.close')).toHaveLength(1);
  });

  it('is safe to call twice: the second call waits for the first and closes nothing again', async () => {
    const { app, log, clock } = wire();
    await app.start();
    const first = app.stop();
    const second = app.stop();
    expect(second).toBe(first);
    await letTimePass(clock, Promise.all([first, second]));
    await app.stop();
    expect(log.filter((line) => line === 'store.close')).toHaveLength(1);
  });

  it('works before start(): only the store is closed', async () => {
    const { app, log } = wire();
    await app.stop();
    expect(log).toContain('store.close');
    expect(log.some((line) => line.startsWith('telegram.'))).toBe(false);
  });

  it('a failing step does not keep the later steps from running', async () => {
    const { app, log, halt } = wire();
    await app.start();
    vi.spyOn(app.telegram, 'stop').mockRejectedValue(new Error('network gone'));
    const runnerStop = vi.spyOn(app.runner, 'stop');

    await expect(halt()).resolves.toBeUndefined();
    expect(runnerStop).toHaveBeenCalledTimes(1);
    expect(log).toContain('store.close');
  });

  it('a store that cannot be closed is reported, not thrown', async () => {
    const clock = createVirtualClock(START_MS);
    const inner = new SqliteJobStore(':memory:');
    add(() => inner.close());
    const entries: string[] = [];
    const app = createApp(TEST_ENV, {
      clock,
      api: new FakeSite(clock),
      store: {
        ...recordingStore(inner, []),
        close: () => {
          throw new Error('disk gone');
        },
      },
      telegramTransformer: createFakeTransport().transformer,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: (obj, msg) => void entries.push(`${msg ?? ''} ${JSON.stringify(obj)}`) },
    });
    await app.start();
    await expect(letTimePass(clock, app.stop())).resolves.toBeUndefined();
    expect(entries.join('\n')).toContain('shutdown step failed');
    expect(entries.join('\n')).toContain('"step":"store"');
  });
});

describe('when something cannot be built or started', () => {
  it('an empty allowlist is refused and the store that was already opened is closed again', () => {
    const inner = new SqliteJobStore(':memory:');
    const log: string[] = [];
    const clock = createVirtualClock(START_MS);
    expect(() =>
      createApp({ ...TEST_ENV, allowedUserIds: [] }, { clock, api: new FakeSite(clock), store: recordingStore(inner, log), telegramTransformer: createFakeTransport().transformer }),
    ).toThrow(/at least one Telegram user id/);
    expect(log).toContain('store.close');
  });

  it('Telegram refusing the token fails start(), stops the sniper and closes the store', async () => {
    const clock = createVirtualClock(START_MS);
    const inner = new SqliteJobStore(':memory:');
    add(() => inner.close());
    const log: string[] = [];
    const transport = createFakeTransport();
    transport.failNext('getMe', { code: 401, description: 'Unauthorized' });
    const app = createApp(TEST_ENV, {
      clock,
      api: new FakeSite(clock),
      store: recordingStore(inner, log),
      telegramTransformer: transport.transformer,
    });
    const runnerStop = vi.spyOn(app.runner, 'stop');

    const started = app.start().then(
      () => new Error('start() should have failed'),
      (error: unknown) => error,
    );
    await clock.advanceBy(10_000);
    const error = await started;
    expect(String((error as Error).message)).toMatch(/401/);
    expect(runnerStop).toHaveBeenCalledTimes(1);
    expect(log).toContain('store.close');
    await expect(app.start()).rejects.toThrow(/stopped/);
  });

  it('a store that cannot be opened is an error before anything else is built', () => {
    const dir = tempDir();
    // a directory where the database file should be
    expect(() => createApp({ ...TEST_ENV, dbPath: dir }, { clock: createVirtualClock(START_MS), telegramTransformer: createFakeTransport().transformer })).toThrow();
  });
});

