import { describe, expect, it } from 'vitest';
import { parseGameDate } from '../../src/config/gameDate.js';
import { yieldToEventLoop } from './_fakes.js';
import { MINUTE, setupRunner, until } from './_runnerHarness.js';

describe('runner: start / stop', () => {
  it('runs the one-second tick loop on the injected clock until the job is booked, then stop() ends it', async () => {
    const t = setupRunner({ startOffsetMs: -11 * MINUTE });
    t.runner.start();
    t.runner.start();
    await until(() => t.stored().state === 'booked');
    await t.runner.stop();

    expect(t.sink.kinds()).toEqual(['armed', 'preflight_ok', 'window_open', 'booked']);
    expect(t.api.count('login')).toBe(1);
    expect(t.api.count('book')).toBe(1);
    expect(t.clock.maxSleepMs()).toBeLessThanOrEqual(1000);

    const callsAfterStop = t.api.calls.length;
    const slept = t.clock.sleeps.length;
    for (let turn = 0; turn < 50; turn++) await yieldToEventLoop();
    expect(t.api.calls.length).toBe(callsAfterStop);
    expect(t.clock.sleeps.length).toBe(slept);
  });

  it('stop() during firing interrupts it: no failure is written, the job stays `firing` for recovery', async () => {
    let stopping: Promise<void> | undefined;
    const t = setupRunner({
      startOffsetMs: -11 * MINUTE,
      script: (clock, opens) => ({
        probeForm: () => {
          if (clock.serverNowMs() < opens - 1500) return { kind: 'window_closed', serverCheckTime: null };
          stopping ??= t.runner.stop();
          return { kind: 'window_closed', serverCheckTime: null };
        },
      }),
    });
    t.runner.start();
    await until(() => stopping !== undefined);
    await stopping;
    expect(t.stored().state).toBe('firing');
    expect(t.sink.ofKind('failed')).toEqual([]);
    expect(t.api.count('book')).toBe(0);
  });

  it('stop() without start() is harmless, and the runner can be started again afterwards', async () => {
    const t = setupRunner({ startOffsetMs: -11 * MINUTE });
    await t.runner.stop();
    t.runner.start();
    await until(() => t.stored().state === 'booked');
    await t.runner.stop();
    expect(t.stored().state).toBe('booked');
  });

  it('a broken job does not stop the loop: the error is logged and the next job is handled', async () => {
    const t = setupRunner({ startOffsetMs: 2 * 86_400_000 });
    const second = t.addJob(parseGameDate('2026-10-21'));
    const original = t.store.get.bind(t.store);
    t.store.get = (id) => {
      if (id === 1) throw new Error('database is locked');
      return original(id);
    };
    await t.drive(t.clock.nowMs() + 30_000);
    expect(t.stored(second.id).state).toBe('booked');
    expect(t.logger.entries.some((entry) => entry.level === 'error' && entry.msg === 'processing a job failed')).toBe(true);
  });

  it('a failing store.list is logged and the next tick tries again', async () => {
    const t = setupRunner({ startOffsetMs: -11 * MINUTE });
    const original = t.store.list.bind(t.store);
    let failures = 1;
    t.store.list = (filter) => {
      if (failures-- > 0) throw new Error('database is locked');
      return original(filter);
    };
    await t.drive(t.opensAtMs + 30_000);
    expect(t.logger.entries.some((entry) => entry.msg === 'tick failed')).toBe(true);
    expect(t.stored().state).toBe('booked');
  });

  it('two overlapping ticks do not process a job twice', async () => {
    const t = setupRunner({ startOffsetMs: -10 * MINUTE });
    await Promise.all([t.runner.tick(), t.runner.tick(), t.runner.tick()]);
    await t.runner.flushEvents();
    expect(t.api.count('login')).toBe(1);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_ok']);
  });
});

describe('runner: without a clock calibrator', () => {
  it('works the same (the clock is simply not corrected)', async () => {
    const t = setupRunner({ deps: { calibration: undefined } });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.stored().state).toBe('booked');
    expect(t.api.count('probeForm')).toBeGreaterThan(5);
  });
});

describe('runner: one job at a time, one request at a time', () => {
  it('two jobs that are both open now are handled one after the other, never overlapping on the wire', async () => {
    const t = setupRunner({
      startOffsetMs: 2 * 86_400_000,
      latency: { login: 400, keepAlive: 400, getDay: 400, probeForm: 400, getAccountContext: 400, getWallet: 400, quote: 400, book: 1900 },
    });
    const second = t.addJob(parseGameDate('2026-10-21'), { choices: [{ courtId: 11, startMinutes: 1080 }] });
    await t.drive(t.clock.nowMs() + 90_000);

    expect(t.stored(1).state).toBe('booked');
    expect(t.stored(second.id).state).toBe('booked');
    expect(t.api.maxActive).toBe(1);
    expect(t.api.maxActiveBooks).toBe(1);
    const books = t.api.callsOf('book');
    expect(books).toHaveLength(2);
    expect((books[1]?.monoMs ?? 0) - (books[0]?.monoMs ?? 0)).toBeGreaterThanOrEqual(1900);
    expect(t.api.bookWithoutFreshProbe).toBe(0);
    expect(t.api.bookWithoutOpenProbe).toBe(0);
  });

  it('the job whose window opened first is handled first', async () => {
    const t = setupRunner({ startOffsetMs: 2 * 86_400_000, job: false });
    const later = t.addJob(parseGameDate('2026-10-21'));
    const earlier = t.addJob(parseGameDate('2026-10-20'));
    await t.drive(t.clock.nowMs() + 60_000);
    const order = t.store.transitions.filter((tr) => tr.to === 'booked').map((tr) => tr.id);
    expect(order).toEqual([earlier.id, later.id]);
  });

  it('never more than one job is in `firing` at any time', async () => {
    const t = setupRunner({ startOffsetMs: 2 * 86_400_000 });
    t.addJob(parseGameDate('2026-10-21'));
    t.addJob(parseGameDate('2026-10-22'));
    let maxFiring = 0;
    const original = t.store.transition.bind(t.store);
    t.store.transition = (...args) => {
      const result = original(...args);
      maxFiring = Math.max(maxFiring, t.store.list({ states: ['firing'] }).length);
      return result;
    };
    await t.drive(t.clock.nowMs() + 120_000);
    expect(maxFiring).toBe(1);
    expect(t.store.list({ states: ['booked'] })).toHaveLength(3);
  });
});

describe('runner: events never break booking', () => {
  it('a sink that throws on every event does not change the outcome; the failures are logged', async () => {
    const t = setupRunner();
    t.sink.failWith = new Error('telegram is down');
    await t.drive(t.opensAtMs + 30_000);
    expect(t.stored().state).toBe('booked');
    expect(t.logger.entries.filter((entry) => entry.msg === 'event sink failed').length).toBeGreaterThanOrEqual(4);
  });

  it('a sink that never answers neither holds up the firing nor the ticks', async () => {
    const t = setupRunner();
    t.sink.emit = () => new Promise<void>(() => undefined);
    for (let seconds = 0; t.clock.nowMs() < t.opensAtMs + 30_000; seconds++) {
      await t.runner.tick();
      await t.clock.sleep(1000);
    }
    expect(t.stored().state).toBe('booked');
  });
});

describe('runner: jobs changed by the owner meanwhile', () => {
  it('a job cancelled before pickup is never touched', async () => {
    const t = setupRunner();
    await t.drive(t.opensAtMs - 12 * MINUTE);
    t.store.transition(1, 'scheduled', 'cancelled', t.clock.nowMs());
    await t.drive(t.opensAtMs + 30_000);
    expect(t.api.calls).toEqual([]);
    expect(t.sink.events).toEqual([]);
  });

  it('a job cancelled while warming is not fired and nothing more is sent for it', async () => {
    const t = setupRunner();
    await t.drive(t.opensAtMs - 5 * MINUTE);
    t.store.transition(1, 'warming', 'cancelled', t.clock.nowMs());
    const callsBefore = t.api.calls.length;
    await t.drive(t.opensAtMs + 30_000);
    expect(t.api.calls.length).toBe(callsBefore);
    expect(t.api.count('book')).toBe(0);
    expect(t.stored().state).toBe('cancelled');
  });

  it('a job cancelled in the very instant before firing is not fired', async () => {
    const t = setupRunner();
    const original = t.store.transition.bind(t.store);
    t.store.transition = (id, from, to, nowMs, patch) => {
      if (to === 'firing') original(id, from, 'cancelled', nowMs);
      return original(id, from, to, nowMs, patch);
    };
    await t.drive(t.opensAtMs + 30_000);
    expect(t.stored().state).toBe('cancelled');
    expect(t.api.count('book')).toBe(0);
    expect(t.api.callsOf('probeForm').every((call) => call.serverMs < t.opensAtMs - 9 * MINUTE)).toBe(true);
  });

  it('a job that is already booked, failed or expired is ignored', async () => {
    const t = setupRunner();
    t.store.transition(1, 'scheduled', 'booked', t.clock.nowMs());
    await t.drive(t.opensAtMs + 30_000);
    expect(t.api.calls).toEqual([]);
  });
});
