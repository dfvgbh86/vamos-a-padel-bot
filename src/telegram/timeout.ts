import type { Clock } from '../contracts.js';

export const TIMED_OUT: unique symbol = Symbol('timed out');
export type TimedOut = typeof TIMED_OUT;

export const SERVICE_TIMEOUT_MS = 30_000;
export const SCHEDULE_TIMEOUT_MS = 10_000;

/**
 * Long polling handles updates one by one, so a hung service call must not hold up /stop for long.
 * The abandoned call keeps running; its late failure is swallowed.
 */
export const withTimeout = async <T>(work: Promise<T>, ms: number, clock: Clock): Promise<T | TimedOut> => {
  work.catch(() => undefined);
  const deadline = clock.sleep(ms).then((): TimedOut => TIMED_OUT);
  return Promise.race([work, deadline]);
};
