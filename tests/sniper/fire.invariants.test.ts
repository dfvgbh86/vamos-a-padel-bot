import { describe, expect, it } from 'vitest';
import type { BookResult, FormGate } from '../../src/contracts.js';
import { parseGameDate } from '../../src/config/gameDate.js';
import { makeRng } from '../qa/_helpers.js';
import {
  CHOICE_A,
  CHOICE_B,
  FAKE_HASH,
  GATE_HASH,
  OPENS_AT_MS,
  SECOND_GATE_HASH,
  closedGate,
  expectPacing,
  makeDay,
  openGate,
} from './_fakes.js';
import { setupFire } from './_fireHarness.js';
import { runFiring } from '../../src/sniper/fire.js';

const now = { startOffsetMs: 0 } as const;

describe('firing invariants: the emergency stop flag', () => {
  it('a job started while the flag is set sends nothing, not even a probe', async () => {
    const t = setupFire(now);
    t.store.setStopped(true);
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'stopped' });
    expect(t.api.calls).toEqual([]);
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'stopped' });
    expect(t.sink.kinds()).toEqual(['failed']);
  });

  it('raised while polling: the loop ends at the next step', async () => {
    const t = setupFire({
      startOffsetMs: -20_000,
      script: (clock) => ({
        probeForm: (_slot, nth) => {
          if (nth === 4) t.store.setStopped(true);
          return closedGate(clock);
        },
      }),
    });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'stopped' });
    expect(t.api.count('probeForm')).toBe(5);
    expect(t.api.count('book')).toBe(0);
  });

  it('raised between the "open" probe and the booking: NO add_event is sent', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        probeForm: () => {
          t.store.setStopped(true);
          return openGate();
        },
      }),
    });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'stopped' });
    expect(t.api.count('book')).toBe(0);
    expect(t.stored().attempts).toBe(0);
  });

  it('is read right before every booking request (once more than the loop check)', async () => {
    const t = setupFire(now);
    let reads = 0;
    t.store.onIsStopped = () => void reads++;
    await t.run();
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it('raised while a booking is in flight: that request completes, but no second add_event follows', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        book: () => {
          t.store.setStopped(true);
          return { kind: 'rejected', outcome: { kind: 'not_open_yet' } };
        },
      }),
    });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'stopped' });
    expect(t.api.count('book')).toBe(1);
  });

  it('does not stop the READ-ONLY calendar check after an unclear outcome (the owner must learn the truth)', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        book: () => {
          t.store.setStopped(true);
          return { kind: 'ambiguous' };
        },
        getDay: (date) => makeDay(date, { own: [CHOICE_A] }),
      }),
    });
    expect((await t.run()).kind).toBe('booked');
    expect(t.api.count('book')).toBe(1);
  });
});

describe('firing invariants: refusals before anything is sent', () => {
  it('card payment is refused unless explicitly allowed', async () => {
    for (const allow of [undefined, false]) {
      const t = setupFire({ ...now, job: { payment: 'card' }, deps: allow === undefined ? {} : { allowCardPayment: allow } });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'card_not_allowed' });
      expect(t.api.calls).toEqual([]);
    }
  });

  it('wallet payment is what goes on the wire by default', async () => {
    const t = setupFire(now);
    await t.run();
    expect(t.api.bookRequests[0]?.payment).toBe('wallet');
  });

  it('an academy court on a weekday is refused up front: no probe, no booking', async () => {
    const t = setupFire({ ...now, job: { choices: [CHOICE_A, { courtId: 1, startMinutes: 1080 }] } });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'court_not_allowed' });
    expect(t.api.calls).toEqual([]);
  });

  it('the same court is fine on a weekend, and on a holiday given to the loop', async () => {
    const saturday = parseGameDate('2026-10-24');
    const weekend = setupFire({
      startOffsetMs: -20_000,
      job: { gameDate: saturday, choices: [{ courtId: 1, startMinutes: 1080 }], opensAtMs: OPENS_AT_MS },
    });
    expect((await weekend.run()).kind).toBe('booked');

    const holiday = setupFire({
      ...now,
      job: { gameDate: parseGameDate('2026-12-08'), choices: [{ courtId: 2, startMinutes: 1080 }] },
      deps: { holidays: new Set([parseGameDate('2026-12-08')]) },
    });
    expect((await holiday.run()).kind).toBe('booked');
  });

  it('a job without choices fails cleanly', async () => {
    const t = setupFire({ ...now, job: { choices: [] } });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'no_choice_available' });
    expect(t.api.calls).toEqual([]);
  });
});

describe('firing invariants: shutdown and external changes', () => {
  it('an aborted signal ends the run and leaves the job in `firing` for recovery (nothing is failed)', async () => {
    const controller = new AbortController();
    const t = setupFire({
      startOffsetMs: -20_000,
      deps: { signal: controller.signal },
      script: (clock) => ({
        probeForm: (_slot, nth) => {
          if (nth === 3) controller.abort();
          return closedGate(clock);
        },
      }),
    });
    expect(await t.run()).toEqual({ kind: 'aborted' });
    expect(t.stored().state).toBe('firing');
    expect(t.sink.kinds()).toEqual([]);
  });

  it('an abort during the calendar check after an unclear outcome keeps the job in `firing`', async () => {
    const controller = new AbortController();
    const t = setupFire({
      ...now,
      deps: { signal: controller.signal },
      script: () => ({
        book: () => {
          controller.abort();
          return { kind: 'ambiguous' };
        },
      }),
    });
    expect(await t.run()).toEqual({ kind: 'aborted' });
    expect(t.stored().state).toBe('firing');
    expect(t.sink.kinds()).toEqual(['window_open', 'ambiguous']);
    expect(t.api.count('book')).toBe(1);
  });

  it('a job cancelled behind our back gets no booking request', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        probeForm: () => {
          t.store.transition(1, 'firing', 'cancelled', 0);
          return openGate();
        },
      }),
    });
    expect(await t.run()).toEqual({ kind: 'job_changed' });
    expect(t.api.count('book')).toBe(0);
    expect(t.stored().state).toBe('cancelled');
    expect(t.sink.ofKind('failed')).toEqual([]);
  });

  it('an unexpected store error before sending fails the job without sending', async () => {
    const t = setupFire(now);
    const original = t.store.transition.bind(t.store);
    t.store.transition = (id, from, to, nowMs, patch) => {
      if (patch?.attemptsDelta !== undefined) throw new Error('disk full');
      return original(id, from, to, nowMs, patch);
    };
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'internal_error' });
    expect(t.api.count('book')).toBe(0);
    expect(t.sink.kinds()).toEqual(['window_open', 'failed']);
  });

  it('even when the store also refuses to record the failure, the run ends with a result instead of throwing (the job stays firing)', async () => {
    const t = setupFire(now);
    const original = t.store.transition.bind(t.store);
    t.store.transition = (id, from, to, nowMs, patch) => {
      if (patch?.attemptsDelta !== undefined || to === 'failed') throw new Error('disk full');
      return original(id, from, to, nowMs, patch);
    };
    await expect(runFiring(t.job, t.deps)).resolves.toEqual({ kind: 'failed', reason: 'internal_error' });
    expect(t.api.count('book')).toBe(0);
    expect(t.stored().state).toBe('firing');
    expect(t.logger.entries.some((entry) => entry.msg === 'could not record the internal failure')).toBe(true);
  });

  it('an unexpected error AFTER a request was sent raises the alarm instead of pretending nothing happened', async () => {
    const t = setupFire(now);
    const original = t.store.transition.bind(t.store);
    t.store.transition = (id, from, to, nowMs, patch) => {
      if (to === 'booked') throw new Error('disk full');
      return original(id, from, to, nowMs, patch);
    };
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'internal_error' });
    expect(t.api.count('book')).toBe(1);
    expect(t.sink.kinds()).toEqual(['window_open', 'ambiguous', 'failed']);
  });
});

describe('firing invariants: at most one add_event in flight', () => {
  it('two firing loops on the same account never overlap their booking requests', async () => {
    const t = setupFire({ ...now, latency: { book: 1900 }, job: { id: 1 } });
    const second = t.store.insert({
      ...t.job,
      id: 2,
      gameDate: parseGameDate('2026-10-21'),
      choices: [{ courtId: 11, startMinutes: 1080 }],
    });
    const [first, other] = await Promise.all([runFiring(t.job, t.deps), runFiring(second, t.deps)]);
    await t.queue.flush();
    expect(first.kind).toBe('booked');
    expect(other.kind).toBe('booked');
    expect(t.api.count('book')).toBe(2);
    expect(t.api.maxActiveBooks).toBe(1);
    expect(t.api.bookWithoutFreshProbe).toBe(0);
  });

  it('a booking in flight keeps the loop from sending another one (it waits and re-probes)', async () => {
    const t = setupFire({ ...now, latency: { book: 1900 } });
    const second = t.store.insert({ ...t.job, id: 2, gameDate: parseGameDate('2026-10-22'), choices: [CHOICE_B] });
    await Promise.all([runFiring(t.job, t.deps), runFiring(second, t.deps)]);
    const books = t.api.callsOf('book');
    expect((books[1]?.monoMs ?? 0) - (books[0]?.monoMs ?? 0)).toBeGreaterThanOrEqual(1900);
  });
});

describe('firing invariants: events never break or delay booking', () => {
  it('a failing sink does not change the outcome and is logged', async () => {
    const t = setupFire(now);
    t.sink.failWith = new Error('telegram down');
    expect((await t.run()).kind).toBe('booked');
    expect(t.stored().state).toBe('booked');
    expect(t.logger.entries.some((entry) => entry.msg === 'event sink failed')).toBe(true);
  });

  it('a sink that never answers does not hold up the booking', async () => {
    const t = setupFire(now);
    t.sink.emit = () => new Promise<void>(() => undefined);
    const result = await runFiring(t.job, t.deps);
    expect(result.kind).toBe('booked');
    expect(t.stored().state).toBe('booked');
  });
});

describe('firing invariants: nothing secret is logged', () => {
  it('the hashes (preflight and gate) never appear in any log entry or event', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        probeForm: () => openGate(GATE_HASH),
        book: (_request, nth) => (nth === 0 ? { kind: 'ambiguous' } : { kind: 'booked', reservationId: 1 }),
      }),
    });
    await t.run();
    for (const secret of [FAKE_HASH, GATE_HASH, SECOND_GATE_HASH]) {
      expect(t.logger.dump()).not.toContain(secret);
      expect(JSON.stringify(t.sink.events)).not.toContain(secret);
    }
  });

  it('errors are logged by name and short message only', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        probeForm: (_slot, nth) => {
          if (nth === 0) throw new Error(`Cookie: laravel_session=${'x'.repeat(300)}`);
          return openGate();
        },
      }),
    });
    await t.run();
    expect(t.logger.dump().length).toBeLessThan(3000);
    expect(t.logger.dump()).not.toContain('x'.repeat(250));
  });
});

type GateKind = 'closed' | 'open' | 'too_short' | 'login_required' | 'daily_limit' | 'unknown' | 'throw';
type BookKind =
  | 'booked'
  | 'not_open_yet'
  | 'daily_limit'
  | 'too_short'
  | 'auth_expired'
  | 'server_error'
  | 'unknown'
  | 'ambiguous'
  | 'not_sent'
  | 'throw';

const GATE_KINDS: readonly GateKind[] = ['closed', 'open', 'open', 'open', 'too_short', 'login_required', 'daily_limit', 'unknown', 'throw'];
const BOOK_KINDS: readonly BookKind[] = [
  'booked',
  'booked',
  'not_open_yet',
  'not_open_yet',
  'daily_limit',
  'too_short',
  'auth_expired',
  'server_error',
  'unknown',
  'ambiguous',
  'not_sent',
  'throw',
];

const bookResult = (kind: BookKind): BookResult => {
  switch (kind) {
    case 'booked':
      return { kind: 'booked', reservationId: 4242 };
    case 'ambiguous':
    case 'not_sent':
      return { kind };
    case 'server_error':
      return { kind: 'rejected', outcome: { kind: 'server_error', status: 502 } };
    case 'unknown':
      return { kind: 'rejected', outcome: { kind: 'unknown', status: 200, message: null } };
    case 'throw':
      throw new Error('boom');
    default:
      return { kind: 'rejected', outcome: { kind } };
  }
};

const RETRYABLE_UNCLEAR: ReadonlySet<string> = new Set(['book:server_error', 'book:ambiguous', 'book:throw']);
const RECONCILE_POLLS = 5;

/** The trail of book() and getDay() calls of one run must respect the reconcile-before-resend discipline. */
const expectReconciledBeforeResend = (trail: readonly string[], label: string): void => {
  trail.forEach((entry, index) => {
    const later = trail.slice(index + 1);
    if (entry === 'book:unknown') expect(later.some((e) => e.startsWith('book:')), `${label}: re-sent after an answer nobody understood`).toBe(false);
    if (!RETRYABLE_UNCLEAR.has(entry)) return;
    const next = later.findIndex((e) => e.startsWith('book:'));
    if (next === -1) return;
    const between = later.slice(0, next);
    expect(between.filter((e) => e === 'cal:none').length, `${label}: re-sent before the calendar wait was over`).toBeGreaterThanOrEqual(RECONCILE_POLLS);
    expect(between, `${label}: re-sent although the calendar showed a booking`).not.toContain('cal:own');
  });
};

describe('firing invariants: randomised scenarios (300 seeds)', () => {
  it('whatever the site answers, the safety invariants hold', async () => {
    const outcomes = new Map<string, number>();
    let resentAfterUnclear = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rng = makeRng(seed);
      const gates = Array.from({ length: 10 }, () => rng.pick(GATE_KINDS));
      const books = Array.from({ length: 6 }, () => rng.pick(BOOK_KINDS));
      const ownFromPoll = rng.pick([-1, -1, -1, -1, 0, 1, 2]);
      const stopAtCall = rng.bool(0.25) ? rng.int(0, 12) : -1;
      const label = `seed ${String(seed)}`;

      let genuineBooks = 0;
      const trail: string[] = [];
      let booksWhenStopped = -1;
      let callCount = 0;
      const t = setupFire({
        ...now,
        script: (clock) => ({
          probeForm: (_slot, nth): FormGate => {
            if (++callCount === stopAtCall) {
              booksWhenStopped = t.api.bookRequests.length;
              t.store.setStopped(true);
            }
            const kind = gates[Math.min(nth, gates.length - 1)] ?? 'closed';
            if (kind === 'throw') throw new Error('network');
            if (kind === 'closed') return closedGate(clock);
            if (kind === 'open') return openGate();
            return { kind };
          },
          book: (_request, nth) => {
            const kind = books[Math.min(nth, books.length - 1)] ?? 'booked';
            if (kind !== 'not_sent') genuineBooks++;
            trail.push(`book:${kind}`);
            return bookResult(kind);
          },
          getDay: (date, poll) => {
            const own = ownFromPoll !== -1 && poll >= ownFromPoll;
            trail.push(own ? 'cal:own' : 'cal:none');
            return makeDay(date, own ? { own: [CHOICE_A] } : {});
          },
        }),
        deps: { options: { windowLimitMs: 25_000 } },
      });
      const result = await t.run();
      const outcome = result.kind === 'failed' ? `failed:${result.reason}` : result.kind;
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);

      expect(t.api.maxActive, label).toBe(1);
      expect(t.api.maxActiveBooks, label).toBeLessThanOrEqual(1);
      expect(t.api.bookWithoutOpenProbe, label).toBe(0);
      expect(t.api.bookWithoutFreshProbe, label).toBe(0);
      expect(t.api.count('cancel'), label).toBe(0);
      expect(genuineBooks, label).toBeLessThanOrEqual(3);
      expect(t.clock.maxSleepMs(), label).toBeLessThanOrEqual(1000);
      expectReconciledBeforeResend(trail, label);
      if (trail.some((e, i) => RETRYABLE_UNCLEAR.has(e) && trail.slice(i + 1).some((later) => later.startsWith('book:')))) resentAfterUnclear++;
      if (booksWhenStopped !== -1) expect(t.api.count('book'), `${label}: add_event after the stop flag`).toBe(booksWhenStopped);

      expectPacing(t.api.calls, label);

      expect(t.stored().attempts, label).toBe(t.api.count('book'));
      const terminal = t.sink.events.filter((e) => e.kind === 'booked' || e.kind === 'failed' || e.kind === 'needs_payment');
      expect(terminal.length, label).toBe(1);
      expect(t.sink.ofKind('window_open').length, label).toBeLessThanOrEqual(1);
      if (result.kind === 'booked') {
        expect(t.stored().state, label).toBe('booked');
        expect(t.emitStates.at(-1), `${label}: stored before emitted`).toBe('booked');
      } else {
        expect(result.kind, label).toBe('failed');
        expect(t.stored().state, label).toBe('failed');
        expect(t.stored().failureReason, label).toBe(result.kind === 'failed' ? result.reason : null);
        expect(t.emitStates.at(-1), label).toBe('failed');
      }
    }
    // the generator must actually reach the interesting branches, otherwise the invariants above prove little
    expect(outcomes.get('booked') ?? 0).toBeGreaterThan(40);
    expect(resentAfterUnclear, 'scenarios that went back to the gate after an unclear answer').toBeGreaterThan(10);
    for (const reason of ['ambiguous_unresolved', 'max_attempts', 'unknown_form', 'daily_limit', 'stopped', 'unknown_response', 'auth']) {
      expect(outcomes.get(`failed:${reason}`) ?? 0, reason).toBeGreaterThan(0);
    }
  }, 120_000);
});
