/**
 * A clock whose time moves only when the test says so, and whose sleepers (the sniper loop, request pacing,
 * Telegram deadlines) wake up in order as virtual time passes. Built on the REAL createSystemClock, so the
 * server-offset calibration and the chunked sleep are the production code.
 */
import { createSystemClock, type SystemClock } from '../../src/sniper/clock.js';

interface Timer {
  readonly at: number;
  readonly callback: () => void;
}

export interface VirtualClock extends SystemClock {
  /** The real server time right now (the fake site reads this, never the bot's corrected time). */
  serverNowMs(): number;
  /** Moves virtual time forward until the bot's own clock reads `targetMs`, waking every sleeper on the way. */
  advanceTo(targetMs: number): Promise<void>;
  advanceBy(ms: number): Promise<void>;
  /** Lets every already-resolved promise chain run to its next wait. */
  settle(): Promise<void>;
}

const MAX_STEPS = 5_000_000;

export const settleTurns = async (turns = 3): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
};

export const createVirtualClock = (startMs: number): VirtualClock => {
  let wall = startMs;
  let mono = 10_000;
  const timers: Timer[] = [];
  const system = createSystemClock({
    wallNowMs: () => wall,
    monotonicMs: () => mono,
    startTimer: (callback, ms) => {
      timers.push({ at: wall + ms, callback });
    },
  });

  const fireDue = (): boolean => {
    const due = timers.filter((timer) => timer.at <= wall).sort((a, b) => a.at - b.at);
    if (due.length === 0) return false;
    for (const timer of due) timers.splice(timers.indexOf(timer), 1);
    for (const timer of due) timer.callback();
    return true;
  };

  const advanceTo = async (targetMs: number): Promise<void> => {
    for (let step = 0; step < MAX_STEPS; step++) {
      await settleTurns();
      if (fireDue()) continue;
      const remaining = targetMs - system.nowMs();
      if (remaining <= 0) return;
      const nextTimer = timers.length === 0 ? Infinity : Math.min(...timers.map((timer) => timer.at - wall));
      const jump = Math.max(1, Math.min(remaining, nextTimer));
      wall += jump;
      mono += jump;
    }
    throw new Error('virtual clock: too many steps (a sleeper keeps re-arming itself?)');
  };

  return Object.assign(system, {
    serverNowMs: () => wall,
    advanceTo,
    advanceBy: (ms: number) => advanceTo(system.nowMs() + ms),
    settle: () => settleTurns(),
  });
};
