import { describe, expect, it, vi } from 'vitest';
import type { Job, JobEvent } from '../../src/contracts.js';
import { announcedStateOf, reannounceResults, type ResultLedger } from '../../src/sniper/announce.js';
import { UNKNOWN_RESERVATION_ID } from '../../src/sniper/fireTypes.js';
import { CHOICE_A, CHOICE_B, FakeClock, OPENS_AT_MS, RecordingLogger, RecordingSink, makeJob } from './_fakes.js';

const clock = (): FakeClock => new FakeClock(OPENS_AT_MS + 60_000);

const ledgerOf = (jobs: readonly Job[]): ResultLedger & { readonly asked: number[] } => {
  const asked: number[] = [];
  return {
    asked,
    unannouncedResults: (sinceMs) => {
      asked.push(sinceMs);
      return jobs;
    },
    markAnnounced: () => undefined,
  };
};

const run = async (jobs: readonly Job[], sink = new RecordingSink()) => {
  const logger = new RecordingLogger();
  const ledger = ledgerOf(jobs);
  const c = clock();
  const announced = await reannounceResults({ ledger, events: sink, clock: c, logger });
  return { announced, sink, logger, ledger, clock: c };
};

describe('announcedStateOf', () => {
  it('names the state a result event settles and ignores everything else', () => {
    const job = makeJob();
    expect(announcedStateOf({ kind: 'booked', job, reservationId: 1, choice: CHOICE_A })).toBe('booked');
    expect(announcedStateOf({ kind: 'needs_payment', job, reservationId: 1 })).toBe('needs_payment');
    expect(announcedStateOf({ kind: 'failed', job, reason: 'x' })).toBe('failed');
    const others: JobEvent[] = [
      { kind: 'armed', job },
      { kind: 'window_open', job },
      { kind: 'ambiguous', job, detail: 'x' },
      { kind: 'expired', job },
      { kind: 'preflight_ok', job, walletCents: 1, quoteCents: null },
    ];
    for (const event of others) expect(announcedStateOf(event)).toBeNull();
  });
});

describe('reannounceResults', () => {
  it('announces a booked job with the stored id and the booked choice', async () => {
    const job = makeJob({ state: 'booked', reservationId: 777, bookedChoice: CHOICE_B });
    const { sink, announced } = await run([job]);
    expect(announced).toBe(1);
    expect(sink.events).toEqual([{ kind: 'booked', job, reservationId: 777, choice: CHOICE_B }]);
  });

  it('a booking found in the calendar (no id) is announced with the unknown-id marker', async () => {
    const { sink } = await run([makeJob({ state: 'booked', bookedChoice: CHOICE_A })]);
    expect(sink.events[0]).toMatchObject({ kind: 'booked', reservationId: UNKNOWN_RESERVATION_ID });
  });

  it('a booked job without a stored choice falls back to the first wish', async () => {
    const { sink } = await run([makeJob({ state: 'booked', reservationId: 5 })]);
    expect(sink.events[0]).toMatchObject({ kind: 'booked', choice: CHOICE_A });
  });

  it('needs_payment is announced as such', async () => {
    const { sink } = await run([makeJob({ state: 'needs_payment', payment: 'card', reservationId: 9 })]);
    expect(sink.kinds()).toEqual(['needs_payment']);
  });

  it('a plain failure is announced with its stored reason, without an alert', async () => {
    const { sink } = await run([makeJob({ state: 'failed', failureReason: 'no_funds' })]);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ kind: 'failed', reason: 'no_funds' });
  });

  it.each(['ambiguous_unresolved', 'own_booking_elsewhere', 'recovery_unverified', 'unknown_response'])(
    'failure %s may hide a booking: the "check the club site" alert goes first',
    async (reason) => {
      const { sink } = await run([makeJob({ state: 'failed', failureReason: reason, attempts: 1 })]);
      expect(sink.kinds()).toEqual(['ambiguous', 'failed']);
      expect(sink.ofKind('ambiguous')[0]?.detail).toContain('club site');
    },
  );

  it('internal_error is an alert only when a request was sent', async () => {
    const sent = await run([makeJob({ state: 'failed', failureReason: 'internal_error', attempts: 1 })]);
    expect(sent.sink.kinds()).toEqual(['ambiguous', 'failed']);
    const unsent = await run([makeJob({ state: 'failed', failureReason: 'internal_error', attempts: 0 })]);
    expect(unsent.sink.kinds()).toEqual(['failed']);
  });

  it('a failed job without a reason still gets an announcement', async () => {
    const { sink } = await run([makeJob({ state: 'failed', failureReason: null })]);
    expect(sink.events[0]).toMatchObject({ kind: 'failed', reason: 'unknown' });
  });

  it('jobs in other states are never announced', async () => {
    const { sink, announced } = await run([makeJob({ state: 'scheduled' }), makeJob({ id: 2, state: 'firing' }), makeJob({ id: 3, state: 'cancelled' })]);
    expect(sink.events).toEqual([]);
    expect(announced).toBe(3);
  });

  it('keeps the order of the jobs', async () => {
    const { sink } = await run([
      makeJob({ id: 1, state: 'failed', failureReason: 'no_funds' }),
      makeJob({ id: 2, state: 'booked', reservationId: 3, bookedChoice: CHOICE_A }),
    ]);
    expect(sink.events.map((event) => event.job.id)).toEqual([1, 2]);
  });

  it('only looks at the last week', async () => {
    const { ledger, clock: c } = await run([]);
    expect(ledger.asked).toEqual([c.nowMs() - 7 * 24 * 3_600_000]);
  });

  it('nothing to announce: nothing is sent and nothing is logged as a warning', async () => {
    const { sink, logger, announced } = await run([]);
    expect(announced).toBe(0);
    expect(sink.events).toEqual([]);
    expect(logger.count('warn')).toBe(0);
  });

  it('a failing sink cannot make it throw, and the other results still go out', async () => {
    const sink = new RecordingSink();
    sink.failWith = new Error('telegram down');
    const { announced, logger } = await run(
      [makeJob({ id: 1, state: 'failed', failureReason: 'no_funds' }), makeJob({ id: 2, state: 'failed', failureReason: 'daily_limit' })],
      sink,
    );
    expect(announced).toBe(2);
    expect(sink.events).toHaveLength(2);
    expect(logger.count('error')).toBe(2);
  });

  it('a ledger that throws is logged, not thrown', async () => {
    const logger = new RecordingLogger();
    const ledger: ResultLedger = {
      unannouncedResults: () => {
        throw new Error('disk gone');
      },
      markAnnounced: () => undefined,
    };
    await expect(reannounceResults({ ledger, events: new RecordingSink(), clock: clock(), logger })).resolves.toBe(0);
    expect(logger.count('error')).toBe(1);
  });

  it('does not wait for a sink that hangs (startup must go on)', async () => {
    vi.useFakeTimers();
    try {
      const hanging = { emit: () => new Promise<void>(() => undefined) };
      const pending = reannounceResults({
        ledger: ledgerOf([makeJob({ state: 'failed', failureReason: 'no_funds' })]),
        events: hanging,
        clock: clock(),
        logger: new RecordingLogger(),
      });
      await vi.advanceTimersByTimeAsync(4001);
      await expect(pending).resolves.toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
