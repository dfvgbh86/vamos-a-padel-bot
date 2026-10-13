import type { Clock } from '../contracts.js';

/** No timer is ever longer than this: Windows sleep makes long timers late, and > 2^31-1 ms fires at once. */
export const MAX_SLEEP_CHUNK_MS = 1000;

/** An offset beyond this is a garbled reading (wrong time zone, parse slip), not a drifting PC clock. */
export const MAX_CLOCK_OFFSET_MS = 120_000;

/** The server reading has whole-second resolution (truncated), so the true time lies half a second above it. */
const HALF_READING_RESOLUTION_MS = 500;
const DEFAULT_MAX_SAMPLES = 9;

export interface OffsetObservation {
  readonly accepted: boolean;
  /** The sample was beyond MAX_CLOCK_OFFSET_MS: it is NOT applied and the owner should be told. */
  readonly absurd: boolean;
  readonly sampleOffsetMs: number;
  /** Offset in force after this observation. */
  readonly offsetMs: number;
  readonly sampleCount: number;
}

export interface ClockCalibration {
  /** Raw local wall clock, without the server offset. */
  localNowMs(): number;
  /**
   * `serverTimeMs`: server reading truncated to whole seconds (see parseServerCheckTime).
   * `receivedAtLocalMs`: raw local time at which the response arrived.
   * `roundTripMs`: request duration, half of which is the assumed travel time of the reading.
   */
  observeServerTime(serverTimeMs: number, receivedAtLocalMs: number, roundTripMs?: number): OffsetObservation;
  offsetMs(): number;
}

export type SystemClock = Clock & ClockCalibration;

export interface SystemClockSources {
  readonly wallNowMs?: () => number;
  readonly monotonicMs?: () => number;
  readonly startTimer?: (callback: () => void, ms: number) => void;
  readonly maxSamples?: number;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return Math.round(((sorted[middle - 1] ?? upper) + upper) / 2);
};

export const createSystemClock = (sources: SystemClockSources = {}): SystemClock => {
  const wallNow = sources.wallNowMs ?? (() => Date.now());
  const monotonic = sources.monotonicMs ?? (() => performance.now());
  const startTimer =
    sources.startTimer ??
    ((callback: () => void, ms: number): void => {
      setTimeout(callback, ms);
    });
  const maxSamples = Math.max(1, sources.maxSamples ?? DEFAULT_MAX_SAMPLES);

  let samples: readonly number[] = [];
  let offset = 0;

  const observeServerTime = (
    serverTimeMs: number,
    receivedAtLocalMs: number,
    roundTripMs = 0,
  ): OffsetObservation => {
    const finite = [serverTimeMs, receivedAtLocalMs, roundTripMs].every((value) => Number.isFinite(value));
    if (!finite || roundTripMs < 0) {
      return { accepted: false, absurd: false, sampleOffsetMs: 0, offsetMs: offset, sampleCount: samples.length };
    }
    const sampleOffsetMs = Math.round(serverTimeMs + HALF_READING_RESOLUTION_MS - (receivedAtLocalMs - roundTripMs / 2));
    if (Math.abs(sampleOffsetMs) > MAX_CLOCK_OFFSET_MS) {
      return { accepted: false, absurd: true, sampleOffsetMs, offsetMs: offset, sampleCount: samples.length };
    }
    samples = [...samples, sampleOffsetMs].slice(-maxSamples);
    offset = median(samples);
    return { accepted: true, absurd: false, sampleOffsetMs, offsetMs: offset, sampleCount: samples.length };
  };

  const sleep = async (ms: number): Promise<void> => {
    if (!Number.isFinite(ms)) throw new RangeError('sleep: ms must be a finite number');
    if (ms <= 0) return;
    const startedMono = monotonic();
    const startedWall = wallNow();
    for (;;) {
      // Either clock may be the one that kept running (suspend freezes one, an NTP step moves the other).
      const elapsed = Math.max(monotonic() - startedMono, wallNow() - startedWall);
      const remaining = ms - elapsed;
      if (remaining <= 0) return;
      await new Promise<void>((resolve) => startTimer(resolve, Math.min(Math.ceil(remaining), MAX_SLEEP_CHUNK_MS)));
    }
  };

  return {
    nowMs: () => wallNow() + offset,
    localNowMs: wallNow,
    monotonicMs: monotonic,
    sleep,
    observeServerTime,
    offsetMs: () => offset,
  };
};

/** Sleeps until `clock.nowMs()` reaches `targetMs`, in chunks of at most MAX_SLEEP_CHUNK_MS. */
export const sleepUntil = async (clock: Clock, targetMs: number): Promise<void> => {
  for (;;) {
    const remaining = targetMs - clock.nowMs();
    if (remaining <= 0) return;
    await clock.sleep(Math.min(Math.ceil(remaining), MAX_SLEEP_CHUNK_MS));
  }
};

/** Sleeps for `ms` of monotonic time, in chunks of at most MAX_SLEEP_CHUNK_MS. */
export const sleepFor = async (clock: Clock, ms: number): Promise<void> => {
  if (!Number.isFinite(ms)) throw new RangeError('sleepFor: ms must be a finite number');
  const end = clock.monotonicMs() + ms;
  for (;;) {
    const remaining = end - clock.monotonicMs();
    if (remaining <= 0) return;
    await clock.sleep(Math.min(Math.ceil(remaining), MAX_SLEEP_CHUNK_MS));
  }
};

export type Pacer = (() => Promise<void>) & {
  /** Records that a request starts now without waiting (for requests that must not be delayed). */
  mark(): void;
};

/** Spaces requests: every call waits until `minGapMs` has passed since the previous request started. */
export const createPacer = (clock: Clock, minGapMs: number): Pacer => {
  let lastStartMs: number | null = null;
  const mark = (): void => {
    lastStartMs = clock.monotonicMs();
  };
  const wait = async (): Promise<void> => {
    if (lastStartMs !== null) await sleepFor(clock, lastStartMs + minGapMs - clock.monotonicMs());
    mark();
  };
  return Object.assign(wait, { mark });
};
