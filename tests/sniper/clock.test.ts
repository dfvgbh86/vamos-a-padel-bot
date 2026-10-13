import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CLOCK_OFFSET_MS,
  MAX_SLEEP_CHUNK_MS,
  createPacer,
  createSystemClock,
  sleepFor,
  sleepUntil,
} from '../../src/sniper/clock.js';
import { FakeClock } from './_fakes.js';

/** A system clock whose time and timers are fully virtual: a timer fires at once and moves both clocks. */
const virtualClock = (options: { lateByMs?: number; moveWall?: boolean; moveMono?: boolean; maxSamples?: number } = {}) => {
  let wall = 1_000_000;
  let mono = 50;
  const timers: number[] = [];
  const clock = createSystemClock({
    wallNowMs: () => wall,
    monotonicMs: () => mono,
    ...(options.maxSamples === undefined ? {} : { maxSamples: options.maxSamples }),
    startTimer: (callback, ms) => {
      timers.push(ms);
      const elapsed = ms + (options.lateByMs ?? 0);
      if (options.moveWall !== false) wall += elapsed;
      if (options.moveMono !== false) mono += elapsed;
      queueMicrotask(callback);
    },
  });
  return { clock, timers, setWall: (value: number) => void (wall = value) };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('system clock: server offset', () => {
  it('starts with no offset: nowMs is the local wall clock', () => {
    const { clock } = virtualClock();
    expect(clock.offsetMs()).toBe(0);
    expect(clock.nowMs()).toBe(clock.localNowMs());
  });

  it('a whole-second server reading is assumed to be half a second old (it is truncated)', () => {
    const { clock } = virtualClock();
    const observation = clock.observeServerTime(2_000_000, 2_000_500);
    expect(observation).toMatchObject({ accepted: true, absurd: false, sampleOffsetMs: 0, offsetMs: 0, sampleCount: 1 });
  });

  it('applies the offset to nowMs but not to the raw local clock', () => {
    const { clock } = virtualClock();
    clock.observeServerTime(1_030_000, 1_000_500);
    expect(clock.offsetMs()).toBe(30_000);
    expect(clock.nowMs()).toBe(clock.localNowMs() + 30_000);
  });

  it('compensates half of the round trip', () => {
    const { clock } = virtualClock();
    // reading 10:00:00 arrived at local 10:00:00.900 after a 800 ms round trip: produced at local ...500
    const observation = clock.observeServerTime(5_000_000, 5_000_900, 800);
    expect(observation.sampleOffsetMs).toBe(5_000_000 + 500 - (5_000_900 - 400));
  });

  it('keeps the MEDIAN of recent observations, so one outlier does not move the clock', () => {
    const { clock } = virtualClock();
    clock.observeServerTime(1_000_100 - 500, 1_000_000);
    clock.observeServerTime(1_000_120 - 500, 1_000_000);
    clock.observeServerTime(1_090_000, 1_000_000);
    expect(clock.offsetMs()).toBe(120);
  });

  it('averages the two middle samples when their number is even', () => {
    const { clock } = virtualClock();
    clock.observeServerTime(1_000_100 - 500, 1_000_000);
    const second = clock.observeServerTime(1_000_201 - 500, 1_000_000);
    expect(second.offsetMs).toBe(151);
  });

  it('only the most recent samples count', () => {
    const { clock } = virtualClock({ maxSamples: 3 });
    for (const offset of [9000, 9000, 9000, 100, 100, 100]) clock.observeServerTime(1_000_000 + offset - 500, 1_000_000);
    expect(clock.offsetMs()).toBe(100);
  });

  it('REJECTS an absurd offset (more than 2 minutes) and reports it instead of applying it', () => {
    const { clock } = virtualClock();
    clock.observeServerTime(1_000_000 - 500 + 40, 1_000_000);
    const observation = clock.observeServerTime(1_000_000 + 2 * 3_600_000, 1_000_000);
    expect(observation).toMatchObject({ accepted: false, absurd: true, offsetMs: 40 });
    expect(observation.sampleOffsetMs).toBeGreaterThan(MAX_CLOCK_OFFSET_MS);
    expect(clock.offsetMs()).toBe(40);
    expect(observation.sampleCount).toBe(1);
  });

  it('rejects a reading two hours BEHIND too (wrong time zone must not shift the schedule)', () => {
    const { clock } = virtualClock();
    const observation = clock.observeServerTime(1_000_000 - 2 * 3_600_000, 1_000_000);
    expect(observation).toMatchObject({ accepted: false, absurd: true, offsetMs: 0 });
    expect(clock.nowMs()).toBe(clock.localNowMs());
  });

  it('the limit itself (exactly 2 minutes) is still accepted', () => {
    const { clock } = virtualClock();
    expect(clock.observeServerTime(1_000_000 + MAX_CLOCK_OFFSET_MS - 500, 1_000_000)).toMatchObject({ accepted: true, absurd: false });
    expect(clock.offsetMs()).toBe(MAX_CLOCK_OFFSET_MS);
    expect(clock.observeServerTime(1_000_000 + MAX_CLOCK_OFFSET_MS + 1000, 1_000_000).absurd).toBe(true);
  });

  it.each([
    ['NaN server time', Number.NaN, 1, 0],
    ['Infinity local time', 1, Number.POSITIVE_INFINITY, 0],
    ['negative round trip', 1, 1, -5],
  ])('ignores garbage input without throwing (%s)', (_label, server, local, rtt) => {
    const { clock } = virtualClock();
    const observation = clock.observeServerTime(server, local, rtt);
    expect(observation).toMatchObject({ accepted: false, absurd: false, offsetMs: 0, sampleCount: 0 });
    expect(clock.nowMs()).toBe(clock.localNowMs());
  });
});

describe('system clock: sleep never uses a long timer', () => {
  it('splits a long sleep into timers of at most 1000 ms and stops when the time is up', async () => {
    const { clock, timers } = virtualClock();
    await clock.sleep(2500);
    expect(timers).toEqual([1000, 1000, 500]);
  });

  it('a delay beyond 2^31-1 ms (which a single timer would fire at once) is still only ever a timer of one second', async () => {
    const { clock, timers } = virtualClock({ lateByMs: 2 ** 31 + 20_000 });
    await clock.sleep(2 ** 31 + 12_345);
    expect(timers).toEqual([1000]);
  });

  it('a long sleep is exactly as long as asked, made of one-second timers', async () => {
    const { clock, timers } = virtualClock();
    await clock.sleep(3_000_500);
    expect(timers.reduce((max, ms) => Math.max(max, ms), 0)).toBe(MAX_SLEEP_CHUNK_MS);
    expect(timers.reduce((sum, ms) => sum + ms, 0)).toBe(3_000_500);
    expect(timers.at(-1)).toBe(500);
  });

  it('re-checks the time after every chunk: a late timer (PC was asleep) ends the sleep early', async () => {
    const { clock, timers } = virtualClock({ lateByMs: 60_000 });
    await clock.sleep(30_000);
    expect(timers).toEqual([1000]);
  });

  it('ends when only the wall clock moved on (monotonic time stood still while the PC slept)', async () => {
    const { clock, timers } = virtualClock({ moveMono: false });
    await clock.sleep(4000);
    expect(timers).toEqual([1000, 1000, 1000, 1000]);
  });

  it('ends on the monotonic clock when the wall clock was stepped backwards', async () => {
    const { clock, timers } = virtualClock({ moveWall: false });
    await clock.sleep(3000);
    expect(timers).toEqual([1000, 1000, 1000]);
  });

  it.each([0, -1, -1e9])('returns at once for %s ms', async (ms) => {
    const { clock, timers } = virtualClock();
    await clock.sleep(ms);
    expect(timers).toEqual([]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects a non-finite duration (%s)', async (ms) => {
    const { clock } = virtualClock();
    await expect(clock.sleep(ms)).rejects.toThrow(RangeError);
  });

  it('works with the real timers wiring (fake timers): chunks of one second, resolved when the time is up', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const clock = createSystemClock();
    let done = false;
    const pending = clock.sleep(3200).then(() => void (done = true));
    await vi.advanceTimersByTimeAsync(2000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1300);
    await pending;
    expect(done).toBe(true);
    const durations = spy.mock.calls.map(([, ms]) => Number(ms));
    expect(durations.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...durations)).toBeLessThanOrEqual(MAX_SLEEP_CHUNK_MS);
  });

  it('nowMs follows Date.now() plus the offset and monotonicMs follows performance.now()', () => {
    const clock = createSystemClock();
    const before = Date.now();
    const now = clock.nowMs();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThan(before + 1000);
    const mono = clock.monotonicMs();
    expect(Math.abs(mono - performance.now())).toBeLessThan(1000);
  });
});

describe('sleepUntil / sleepFor / pacer (on a virtual clock)', () => {
  it('sleepUntil reaches the target exactly with chunks of at most one second', async () => {
    const clock = new FakeClock(10_000);
    await sleepUntil(clock, 10_000 + 3_450);
    expect(clock.nowMs()).toBe(13_450);
    expect(clock.sleeps).toEqual([1000, 1000, 1000, 450]);
  });

  it('sleepUntil returns at once when the target has passed', async () => {
    const clock = new FakeClock(10_000);
    await sleepUntil(clock, 5000);
    expect(clock.sleeps).toEqual([]);
  });

  it('sleepFor measures monotonic time and rejects non-finite durations', async () => {
    const clock = new FakeClock(10_000);
    const start = clock.monotonicMs();
    await sleepFor(clock, 2200);
    expect(clock.monotonicMs() - start).toBe(2200);
    expect(clock.sleeps).toEqual([1000, 1000, 200]);
    await expect(sleepFor(clock, Number.NaN)).rejects.toThrow(RangeError);
  });

  it('the pacer lets the first request go at once and spaces the next ones by the minimum gap', async () => {
    const clock = new FakeClock(10_000);
    const pace = createPacer(clock, 250);
    const starts: number[] = [];
    for (let i = 0; i < 4; i++) {
      await pace();
      starts.push(clock.monotonicMs());
    }
    expect(starts.map((start) => start - (starts[0] ?? 0))).toEqual([0, 250, 500, 750]);
  });

  it('the pacer does not wait when the request itself took longer than the gap', async () => {
    const clock = new FakeClock(10_000);
    const pace = createPacer(clock, 250);
    await pace();
    clock.advance(700);
    const before = clock.monotonicMs();
    await pace();
    expect(clock.monotonicMs()).toBe(before);
    expect(clock.sleeps).toEqual([]);
  });
});
