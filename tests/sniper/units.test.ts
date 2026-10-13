import { describe, expect, it } from 'vitest';
import { parseGameDate } from '../../src/config/gameDate.js';
import { createEventQueue, flushWithin } from '../../src/sniper/events.js';
import { DEFAULT_FIRE_OPTIONS, resolveFireOptions } from '../../src/sniper/fireTypes.js';
import { gameDayEndsAtMs, isGameDatePassed } from '../../src/sniper/gameDay.js';
import { findOwnBooking, hasOwnBooking, slotTakenByOthers } from '../../src/sniper/ownBooking.js';
import { resolveRunnerOptions } from '../../src/sniper/runnerContext.js';
import { describeError } from '../../src/sniper/types.js';
import { madridInstant } from '../qa/_helpers.js';
import { FAKE_HASH, GAME_DATE, RecordingLogger, RecordingSink, makeDay, makeJob, yieldToEventLoop } from './_fakes.js';

describe('event queue', () => {
  it('delivers events in order, one at a time, and emit() returns at once', async () => {
    const sink = new RecordingSink();
    const queue = createEventQueue(sink, new RecordingLogger());
    const job = makeJob();
    queue.emit({ kind: 'armed', job });
    queue.emit({ kind: 'window_open', job });
    queue.emit({ kind: 'expired', job });
    expect(sink.events).toEqual([]);
    await queue.flush();
    expect(sink.kinds()).toEqual(['armed', 'window_open', 'expired']);
  });

  it('a failing sink is logged (job id and kind only) and the queue carries on', async () => {
    const sink = new RecordingSink();
    sink.failWith = new Error(`token ${FAKE_HASH}`);
    const logger = new RecordingLogger();
    const queue = createEventQueue(sink, logger);
    queue.emit({ kind: 'armed', job: makeJob() });
    queue.emit({ kind: 'expired', job: makeJob() });
    await queue.flush();
    expect(sink.kinds()).toEqual(['armed', 'expired']);
    expect(logger.count('error')).toBe(2);
    expect(logger.dump()).not.toContain(FAKE_HASH);
  });

  it('a sink that throws synchronously is handled too', async () => {
    const logger = new RecordingLogger();
    const queue = createEventQueue(
      {
        emit: () => {
          throw new Error('sync boom');
        },
      },
      logger,
    );
    queue.emit({ kind: 'armed', job: makeJob() });
    await queue.flush();
    expect(logger.count('error')).toBe(1);
  });

  it('flush also waits for events emitted while it was waiting', async () => {
    const sink = new RecordingSink();
    const queue = createEventQueue(sink, new RecordingLogger());
    queue.emit({ kind: 'armed', job: makeJob() });
    const flushing = queue.flush();
    await yieldToEventLoop();
    queue.emit({ kind: 'expired', job: makeJob() });
    await flushing;
    await queue.flush();
    expect(sink.kinds()).toEqual(['armed', 'expired']);
  });

  it('flushWithin gives up on a sink that hangs', async () => {
    const queue = createEventQueue({ emit: () => new Promise<void>(() => undefined) }, new RecordingLogger());
    queue.emit({ kind: 'armed', job: makeJob() });
    expect(await flushWithin(queue, 20)).toBe(false);
  });

  it('flushWithin reports success when everything was delivered', async () => {
    const queue = createEventQueue(new RecordingSink(), new RecordingLogger());
    queue.emit({ kind: 'armed', job: makeJob() });
    expect(await flushWithin(queue, 1000)).toBe(true);
  });
});

describe('own booking lookup', () => {
  const choices = [
    { courtId: 9, startMinutes: 1080 },
    { courtId: 10, startMinutes: 1080 },
  ];

  it('finds nothing on a day without an own booking', () => {
    expect(findOwnBooking(makeDay(GAME_DATE), choices)).toBeNull();
    expect(hasOwnBooking(makeDay(GAME_DATE))).toBe(false);
  });

  it('matches the wished slot by court and covering time', () => {
    const day = makeDay(GAME_DATE, { own: [{ courtId: 10, startMinutes: 1080 }] });
    expect(findOwnBooking(day, choices)).toEqual({ choice: choices[1] });
    expect(hasOwnBooking(day)).toBe(true);
  });

  it('a booking on the wished court at ANOTHER time is not a match, but is still an own booking', () => {
    const day = makeDay(GAME_DATE, { own: [{ courtId: 9, startMinutes: 1170 }] });
    expect(findOwnBooking(day, choices)).toEqual({ choice: null });
  });

  it('prefers a matching booking over an earlier non-matching one', () => {
    const day = makeDay(GAME_DATE, { own: [{ courtId: 4, startMinutes: 1080 }, { courtId: 10, startMinutes: 1080 }] });
    expect(findOwnBooking(day, choices)).toEqual({ choice: choices[1] });
  });

  it('a taken slot of somebody else is not an own booking', () => {
    const day = makeDay(GAME_DATE, { taken: [{ courtId: 9, startMinutes: 1080 }] });
    expect(findOwnBooking(day, choices)).toBeNull();
  });
});

describe('taken-by-others lookup', () => {
  const wish = { courtId: 9, startMinutes: 1080 };

  it('is true only for a slot that is neither free nor ours', () => {
    expect(slotTakenByOthers(makeDay(GAME_DATE, { taken: [wish] }), wish)).toBe(true);
    expect(slotTakenByOthers(makeDay(GAME_DATE), wish)).toBe(false);
    expect(slotTakenByOthers(makeDay(GAME_DATE, { own: [wish] }), wish)).toBe(false);
  });

  it('looks at the slot of that court that covers the wished start, not at another court or another time', () => {
    expect(slotTakenByOthers(makeDay(GAME_DATE, { taken: [{ courtId: 10, startMinutes: 1080 }] }), wish)).toBe(false);
    expect(slotTakenByOthers(makeDay(GAME_DATE, { taken: [{ courtId: 9, startMinutes: 1170 }] }), wish)).toBe(false);
    expect(slotTakenByOthers(makeDay(GAME_DATE, { taken: [wish] }), { courtId: 9, startMinutes: 1100 })).toBe(true);
  });

  it('is false for a court or a time the calendar does not have', () => {
    expect(slotTakenByOthers(makeDay(GAME_DATE, { courts: [11] }), wish)).toBe(false);
    expect(slotTakenByOthers(makeDay(GAME_DATE, { taken: [wish] }), { courtId: 9, startMinutes: 600 })).toBe(false);
  });
});

describe('game day boundaries', () => {
  it('the day ends at midnight club time, DST-safe', () => {
    expect(gameDayEndsAtMs(GAME_DATE)).toBe(madridInstant('2026-10-21', 0));
    const longDay = parseGameDate('2026-10-25');
    expect(gameDayEndsAtMs(longDay)).toBe(madridInstant('2026-10-26', 0));
    expect(gameDayEndsAtMs(longDay) - madridInstant('2026-10-25', 0)).toBe(25 * 3_600_000);
  });

  it('isGameDatePassed flips exactly at midnight', () => {
    const end = gameDayEndsAtMs(GAME_DATE);
    expect(isGameDatePassed(GAME_DATE, end - 1)).toBe(false);
    expect(isGameDatePassed(GAME_DATE, end)).toBe(true);
  });
});

describe('option validation', () => {
  it('fire options default to the documented values', () => {
    expect(resolveFireOptions()).toEqual(DEFAULT_FIRE_OPTIONS);
    expect(DEFAULT_FIRE_OPTIONS).toMatchObject({
      leadMs: 3000,
      windowLimitMs: 90_000,
      maxAttempts: 3,
      minRequestGapMs: 250,
      maxProbeOutageMs: 20_000,
      probeErrorBackoffMs: 750,
    });
  });

  it.each([
    ['maxAttempts', 0],
    ['maxAttempts', 11],
    ['maxAttempts', 1.5],
    ['minRequestGapMs', 249],
    ['windowLimitMs', 999],
    ['leadMs', -1],
    ['reconcilePolls', 0],
    ['maxProbeOutageMs', 999],
    ['probeErrorBackoffMs', -1],
    ['probeErrorBackoffMs', 0.5],
  ])('rejects %s = %s', (name, value) => {
    expect(() => resolveFireOptions({ [name]: value })).toThrow(RangeError);
  });

  it('runner options: ticks must be one second or shorter (no long timers), counts must be sensible', () => {
    expect(() => resolveRunnerOptions({ tickMs: 5000 })).toThrow(RangeError);
    expect(() => resolveRunnerOptions({ tickMs: 0 })).toThrow(RangeError);
    expect(() => resolveRunnerOptions({ authFastRetries: 0 })).toThrow(RangeError);
    expect(() => resolveRunnerOptions({ fireQuietMs: -1 })).toThrow(RangeError);
    expect(resolveRunnerOptions({ fireQuietMs: 0 }).fireQuietMs).toBe(0);
    expect(resolveRunnerOptions({ tickMs: 500 }).tickMs).toBe(500);
    expect(resolveRunnerOptions()).toMatchObject({
      tickMs: 1000,
      warmupLeadMs: 600_000,
      keepAliveEveryMs: 300_000,
      authFastRetries: 3,
      fireQuietMs: 10_000,
    });
  });
});

describe('describeError', () => {
  it('never returns a hash or a session cookie, and keeps messages short', () => {
    const cookie = ['laravel_session', '=', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
    const described = describeError(new Error(`bad ${FAKE_HASH} and ${cookie} ${'z'.repeat(500)}`));
    expect(described.errorMessage).not.toContain(FAKE_HASH);
    expect(described.errorMessage).not.toContain('abcdefghijklmnop');
    expect(described.errorMessage.length).toBeLessThanOrEqual(200);
    expect(described.errorName).toBe('Error');
  });

  it('handles values that are not errors', () => {
    expect(describeError('boom')).toEqual({ errorName: 'string', errorMessage: '' });
    expect(describeError(undefined)).toEqual({ errorName: 'undefined', errorMessage: '' });
  });
});
