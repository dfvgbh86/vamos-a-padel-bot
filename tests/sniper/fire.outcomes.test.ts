import { describe, expect, it } from 'vitest';
import { CourtNotAllowedError } from '../../src/config/courts.js';
import { parseGameDate } from '../../src/config/gameDate.js';
import { AuthExpiredError, LoginFailedError } from '../../src/reservaplay/errors.js';
import { UNKNOWN_RESERVATION_ID } from '../../src/sniper/fire.js';
import {
  CHOICE_A,
  CHOICE_B,
  GATE_HASH,
  SECOND_GATE_HASH,
  bySequence,
  makeDay,
  openGate,
  type ApiScript,
} from './_fakes.js';
import { setupFire } from './_fireHarness.js';

/** The window is already open: every test below starts at the opening instant. */
const now = { startOffsetMs: 0 } as const;

const ownOn = (...choices: readonly (typeof CHOICE_A)[]): Pick<ApiScript, 'getDay'> => ({
  getDay: (date) => makeDay(date, { own: choices }),
});

describe('firing: answers of the form gate', () => {
  it('daily_limit with no own booking in the calendar -> failed daily_limit, nothing sent', async () => {
    const t = setupFire({ ...now, script: () => ({ probeForm: () => ({ kind: 'daily_limit' }) }) });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'daily_limit' });
    expect(t.api.count('getDay')).toBe(1);
    expect(t.api.count('book')).toBe(0);
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'daily_limit' });
    expect(t.sink.kinds()).toEqual(['failed']);
  });

  it('daily_limit when the booking predates this job (no add_event was sent) is NOT reported as booked by the bot', async () => {
    const t = setupFire({ ...now, script: () => ({ probeForm: () => ({ kind: 'daily_limit' }), ...ownOn(CHOICE_B) }) });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'daily_limit' });
    expect(t.stored().state).toBe('failed');
    expect(t.sink.kinds()).toEqual(['failed']);
  });

  it('daily_limit after an earlier request of this job: the own booking in the calendar counts as booked (id unknown)', async () => {
    const t = setupFire({
      ...now,
      job: { attempts: 1 },
      script: () => ({ probeForm: () => ({ kind: 'daily_limit' }), ...ownOn(CHOICE_B) }),
    });
    expect(await t.run()).toEqual({ kind: 'booked', reservationId: null, choice: CHOICE_B });
    expect(t.stored()).toMatchObject({ state: 'booked', reservationId: null, bookedChoice: CHOICE_B });
    expect(t.sink.ofKind('booked')[0]).toMatchObject({ reservationId: UNKNOWN_RESERVATION_ID, choice: CHOICE_B });
    expect(t.api.count('book')).toBe(0);
  });

  it('a reconciled booking that matches no wished slot is NOT claimed as a success: the owner is alerted and the job fails', async () => {
    const t = setupFire({
      ...now,
      job: { attempts: 1 },
      script: () => ({ probeForm: () => ({ kind: 'daily_limit' }), ...ownOn({ courtId: 12, startMinutes: 1170 }) }),
    });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'own_booking_elsewhere' });
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'own_booking_elsewhere', bookedChoice: null, reservationId: null });
    expect(t.sink.kinds()).toEqual(['ambiguous', 'failed']);
    expect(t.sink.ofKind('ambiguous')[0]?.detail).toContain('not on a wished slot');
    expect(t.sink.ofKind('booked')).toEqual([]);
    expect(t.api.count('book')).toBe(0);
  });

  it('after our own request, a calendar booking on an unwished slot (the owner booked by hand) is not claimed either', async () => {
    const t = setupFire({
      ...now,
      script: () => ({ book: () => ({ kind: 'ambiguous' }), ...ownOn({ courtId: 12, startMinutes: 1170 }) }),
    });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'own_booking_elsewhere' });
    expect(t.api.count('book')).toBe(1);
    expect(t.sink.ofKind('booked')).toEqual([]);
    expect(t.stored().bookedChoice).toBeNull();
  });

  it('the booking is attributed to the wished slot it covers, not to the choice that was tried last', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        probeForm: (slot) => (slot.courtId === CHOICE_A.courtId ? { kind: 'too_short' } : openGate()),
        book: () => ({ kind: 'ambiguous' }),
        ...ownOn(CHOICE_B),
      }),
    });
    expect(await t.run()).toEqual({ kind: 'booked', reservationId: null, choice: CHOICE_B });
    expect(t.stored().bookedChoice).toEqual(CHOICE_B);
    expect(t.api.bookRequests.map((r) => r.slot.courtId)).toEqual([10]);

    const other = setupFire({
      ...now,
      script: () => ({ book: () => ({ kind: 'ambiguous' }), ...ownOn(CHOICE_B) }),
    });
    expect(await other.run()).toEqual({ kind: 'booked', reservationId: null, choice: CHOICE_B });
    expect(other.api.bookRequests.map((r) => r.slot.courtId)).toEqual([9]);
  });

  it('a calendar slot that merely covers the wished start time matches (60 minute grid, 90 minute wish)', async () => {
    const t = setupFire({
      ...now,
      job: { attempts: 1, choices: [CHOICE_A, { courtId: 10, startMinutes: 1100 }] },
      script: () => ({
        probeForm: () => ({ kind: 'daily_limit' }),
        getDay: (date) => makeDay(date, { startMinutes: 1080, durationMinutes: 90, own: [{ courtId: 10, startMinutes: 1080 }] }),
      }),
    });
    expect(await t.run()).toMatchObject({ kind: 'booked', choice: { courtId: 10, startMinutes: 1100 } });
  });

  it('too_short on the first choice rules it out and the next one is tried', async () => {
    const t = setupFire({
      ...now,
      script: () => ({ probeForm: (slot) => (slot.courtId === CHOICE_A.courtId ? { kind: 'too_short' } : openGate()) }),
    });
    expect(await t.run()).toEqual({ kind: 'booked', reservationId: 100_002, choice: CHOICE_B });
    expect(t.api.callsOf('probeForm').map((c) => c.courtId)).toEqual([9, 10]);
    expect(t.api.bookRequests[0]?.slot.courtId).toBe(10);
    expect(t.stored().bookedChoice).toEqual(CHOICE_B);
  });

  it('when every choice is ruled out the job fails without sending anything', async () => {
    const t = setupFire({ ...now, script: () => ({ probeForm: () => ({ kind: 'too_short' }) }) });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'no_choice_available' });
    expect(t.api.count('book')).toBe(0);
    expect(t.api.count('probeForm')).toBe(2);
  });

  it('login_required: ONE re-login, then the loop continues and books', async () => {
    const t = setupFire({
      ...now,
      script: () => ({ probeForm: bySequence([{ kind: 'login_required' }, openGate()]) }),
    });
    expect((await t.run()).kind).toBe('booked');
    expect(t.api.count('login')).toBe(1);
    expect(t.api.count('book')).toBe(1);
  });

  it('login_required again after the permitted re-logins -> failed auth (no further login)', async () => {
    const t = setupFire({ ...now, script: () => ({ probeForm: () => ({ kind: 'login_required' }) }) });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'auth' });
    expect(t.api.count('login')).toBe(2);
    expect(t.api.count('book')).toBe(0);

    const single = setupFire({ ...now, deps: { options: { maxRelogins: 1 } }, script: () => ({ probeForm: () => ({ kind: 'login_required' }) }) });
    expect(await single.run()).toEqual({ kind: 'failed', reason: 'auth' });
    expect(single.api.count('login')).toBe(1);
  });

  it('a re-login that keeps failing fails the job with auth after a bounded number of attempts', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        probeForm: () => ({ kind: 'login_required' }),
        login: () => {
          throw new LoginFailedError();
        },
      }),
    });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'auth' });
    expect(t.api.count('login')).toBe(5);
    expect(t.api.count('book')).toBe(0);
  });

  it('an AuthExpiredError thrown by the probe counts as login_required', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        probeForm: (_slot, nth) => {
          if (nth === 0) throw new AuthExpiredError();
          return openGate();
        },
      }),
    });
    expect((await t.run()).kind).toBe('booked');
    expect(t.api.count('login')).toBe(1);
  });

  describe('an unknown page', () => {
    const unknownFor = (...courts: readonly number[]): Pick<ApiScript, 'probeForm'> => ({
      probeForm: (slot) => (courts.includes(slot.courtId) ? { kind: 'unknown' } : openGate()),
    });

    it('with the slot still free in the calendar stops the job after three pages in a row: nothing sent, the owner is told', async () => {
      const t = setupFire({ ...now, script: () => ({ probeForm: () => ({ kind: 'unknown' }) }) });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'unknown_form' });
      expect(t.api.count('probeForm')).toBe(3);
      expect(t.api.count('getDay')).toBe(1);
      expect(t.api.count('book')).toBe(0);
      expect(t.sink.kinds()).toEqual(['failed']);
      expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'unknown_form' });
    });

    it('because somebody took the slot: the choice is ruled out (one read-only calendar look) and the next one is booked', async () => {
      const t = setupFire({ ...now, script: () => ({ ...unknownFor(9), getDay: (date) => makeDay(date, { taken: [CHOICE_A] }) }) });
      expect(await t.run()).toEqual({ kind: 'booked', reservationId: 100_002, choice: CHOICE_B });
      expect(t.api.callsOf('probeForm').map((c) => c.courtId)).toEqual([9, 9, 9, 10]);
      expect(t.api.count('getDay')).toBe(1);
      expect(t.api.count('book')).toBe(1);
      expect(t.api.bookRequests[0]?.slot.courtId).toBe(10);
      expect(t.sink.kinds()).toEqual(['window_open', 'booked']);
      expect(t.stored()).toMatchObject({ state: 'booked', bookedChoice: CHOICE_B, attempts: 1 });
    });

    it('a choice that was ruled out is never probed again', async () => {
      const t = setupFire({
        ...now,
        script: () => ({
          ...unknownFor(9),
          getDay: (date) => makeDay(date, { taken: [CHOICE_A] }),
          book: bySequence([{ kind: 'rejected', outcome: { kind: 'not_open_yet' } }, { kind: 'booked', reservationId: 5 }]),
        }),
      });
      expect((await t.run()).kind).toBe('booked');
      expect(t.api.callsOf('probeForm').map((c) => c.courtId)).toEqual([9, 9, 9, 10, 10]);
    });

    it('every choice taken -> no_choice_available, nothing is ever sent', async () => {
      const t = setupFire({
        ...now,
        script: () => ({ ...unknownFor(9, 10), getDay: (date) => makeDay(date, { taken: [CHOICE_A, CHOICE_B] }) }),
      });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'no_choice_available' });
      expect(t.api.count('book')).toBe(0);
      expect(t.api.count('getDay')).toBe(2);
    });

    it('is still a mystery when the account has a booking that day (the form would not render for that reason): stop', async () => {
      const t = setupFire({
        ...now,
        script: () => ({ ...unknownFor(9), getDay: (date) => makeDay(date, { taken: [CHOICE_A], own: [{ courtId: 4, startMinutes: 1170 }] }) }),
      });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'unknown_form' });
      expect(t.api.count('book')).toBe(0);
    });

    it('is still a mystery when the calendar cannot be read, or does not show that court or time: stop', async () => {
      const unreadable = setupFire({
        ...now,
        script: () => ({ ...unknownFor(9), getDay: () => { throw new Error('timeout'); } }),
      });
      expect(await unreadable.run()).toEqual({ kind: 'failed', reason: 'unknown_form' });

      const absent = setupFire({ ...now, script: () => ({ ...unknownFor(9), getDay: (date) => makeDay(date, { courts: [11, 12] }) }) });
      expect(await absent.run()).toEqual({ kind: 'failed', reason: 'unknown_form' });

      const otherTime = setupFire({
        ...now,
        job: { choices: [{ courtId: 9, startMinutes: 1000 }, CHOICE_B] },
        script: () => ({ ...unknownFor(9), getDay: (date) => makeDay(date, { taken: [{ courtId: 9, startMinutes: 1170 }] }) }),
      });
      expect(await otherTime.run()).toEqual({ kind: 'failed', reason: 'unknown_form' });
      expect(otherTime.api.count('book')).toBe(0);
    });

    it('a dead session during that calendar look costs one login, the look is lost, and the job stops (safe default)', async () => {
      const t = setupFire({
        ...now,
        script: () => ({
          ...unknownFor(9),
          getDay: (date, nth) => {
            if (nth === 0) throw new AuthExpiredError();
            return makeDay(date, { taken: [CHOICE_A] });
          },
        }),
      });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'unknown_form' });
      expect(t.api.count('login')).toBe(1);
      expect(t.api.count('getDay')).toBe(1);
    });
  });
});

describe('firing: answers of the booking request', () => {
  it('not_open_yet goes back to the gate; the next booking uses the NEW hash and a fresh probe', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        probeForm: bySequence([openGate(GATE_HASH), openGate(SECOND_GATE_HASH)]),
        book: bySequence([{ kind: 'rejected', outcome: { kind: 'not_open_yet' } }, { kind: 'booked', reservationId: 777 }]),
      }),
    });
    expect(await t.run()).toEqual({ kind: 'booked', reservationId: 777, choice: CHOICE_A });
    expect(t.api.bookRequests.map((r) => r.account.hash)).toEqual([GATE_HASH, SECOND_GATE_HASH]);
    expect(t.api.bookWithoutFreshProbe).toBe(0);
    expect(t.stored().attempts).toBe(2);
    expect(t.sink.kinds()).toEqual(['window_open', 'booked']);
  });

  it('keeps getting not_open_yet: stops after the maximum number of add_event requests (3)', async () => {
    const t = setupFire({
      ...now,
      script: () => ({ book: () => ({ kind: 'rejected', outcome: { kind: 'not_open_yet' } }) }),
    });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'max_attempts' });
    expect(t.api.count('book')).toBe(3);
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'max_attempts', attempts: 3 });
  });

  it('the attempt cap is configurable and counts attempts made in an earlier run (after a restart)', async () => {
    const configured = setupFire({
      ...now,
      deps: { options: { maxAttempts: 1 } },
      script: () => ({ book: () => ({ kind: 'rejected', outcome: { kind: 'not_open_yet' } }) }),
    });
    expect((await configured.run()).kind).toBe('failed');
    expect(configured.api.count('book')).toBe(1);

    const resumed = setupFire({
      ...now,
      job: { attempts: 2 },
      script: () => ({ book: () => ({ kind: 'rejected', outcome: { kind: 'not_open_yet' } }) }),
    });
    expect(await resumed.run()).toEqual({ kind: 'failed', reason: 'max_attempts' });
    expect(resumed.api.count('book')).toBe(1);
    expect(resumed.stored().attempts).toBe(3);
  });

  it('a job that already used its attempts sends nothing at all', async () => {
    const t = setupFire({ ...now, job: { attempts: 3 } });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'max_attempts' });
    expect(t.api.count('book')).toBe(0);
  });

  it('every add_event is counted in the store BEFORE it is sent', async () => {
    const seen: number[] = [];
    const t = setupFire({
      ...now,
      script: () => ({
        book: () => {
          seen.push(t.stored().attempts);
          return { kind: 'booked', reservationId: 5 };
        },
      }),
    });
    await t.run();
    expect(seen).toEqual([1]);
  });

  it('too_short from the server rules the choice out and goes on with the next', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        book: bySequence([{ kind: 'rejected', outcome: { kind: 'too_short' } }, { kind: 'booked', reservationId: 9 }]),
      }),
    });
    expect(await t.run()).toEqual({ kind: 'booked', reservationId: 9, choice: CHOICE_B });
    expect(t.api.bookRequests.map((r) => r.slot.courtId)).toEqual([9, 10]);
  });

  describe('daily_limit', () => {
    const limit = { kind: 'rejected', outcome: { kind: 'daily_limit' } } as const;

    it('with no booking in the calendar after our own request -> alert and ambiguous_unresolved (see fire.unresolved)', async () => {
      const t = setupFire({ ...now, script: () => ({ book: () => limit }) });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'ambiguous_unresolved' });
      expect(t.api.count('book')).toBe(1);
    });

    it('with an own booking in the calendar -> booked (id unknown), nothing re-sent', async () => {
      const t = setupFire({ ...now, script: () => ({ book: () => limit, ...ownOn(CHOICE_A) }) });
      expect(await t.run()).toEqual({ kind: 'booked', reservationId: null, choice: CHOICE_A });
      expect(t.stored()).toMatchObject({ state: 'booked', reservationId: null });
      expect(t.api.count('book')).toBe(1);
    });
  });

  describe('auth_expired', () => {
    const expired = { kind: 'rejected', outcome: { kind: 'auth_expired' } } as const;

    it('one re-login and ONE retry of the gate/book sequence, then booked', async () => {
      const t = setupFire({
        ...now,
        script: () => ({ book: bySequence([expired, { kind: 'booked', reservationId: 31 }]) }),
      });
      expect(await t.run()).toEqual({ kind: 'booked', reservationId: 31, choice: CHOICE_A });
      expect(t.api.count('login')).toBe(1);
      expect(t.api.count('book')).toBe(2);
      expect(t.api.calls.map((c) => c.name)).toEqual(['probeForm', 'book', 'login', 'probeForm', 'book']);
      expect(t.api.bookWithoutFreshProbe).toBe(0);
    });

    it('an expiry beyond the permitted re-logins fails the job: no further login, no further request', async () => {
      const t = setupFire({ ...now, deps: { options: { maxRelogins: 1 } }, script: () => ({ book: () => expired }) });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'auth' });
      expect(t.api.count('login')).toBe(1);
      expect(t.api.count('book')).toBe(2);
    });

    it('an AuthExpiredError thrown by book() is the same thing', async () => {
      const t = setupFire({
        ...now,
        script: () => ({
          book: (_request, nth) => {
            if (nth === 0) throw new AuthExpiredError();
            return { kind: 'booked', reservationId: 4 };
          },
        }),
      });
      expect((await t.run()).kind).toBe('booked');
      expect(t.api.count('login')).toBe(1);
    });
  });

  describe('unclear outcomes (ambiguous / server error / exception): reconcile first, send again only through a fresh gate', () => {
    const unclear = [
      ['ambiguous', { kind: 'ambiguous' }],
      ['server_error', { kind: 'rejected', outcome: { kind: 'server_error', status: 500 } }],
    ] as const;

    it.each(unclear)('%s: the ambiguous event goes out first, the booking is found in the calendar on a later poll', async (_label, answer) => {
      const t = setupFire({
        ...now,
        script: () => ({
          book: () => answer,
          getDay: (date, nth) => makeDay(date, nth >= 1 ? { own: [CHOICE_A] } : {}),
        }),
      });
      expect(await t.run()).toEqual({ kind: 'booked', reservationId: null, choice: CHOICE_A });
      expect(t.sink.kinds()).toEqual(['window_open', 'ambiguous', 'booked']);
      expect(t.emitStates).toEqual(['firing', 'firing', 'booked']);
      expect(t.api.count('getDay')).toBe(2);
      const polls = t.api.callsOf('getDay');
      expect((polls[1]?.monoMs ?? 0) - (polls[0]?.monoMs ?? 0)).toBeGreaterThanOrEqual(3000);
      expect(t.api.count('book')).toBe(1);
      expect(t.stored()).toMatchObject({ state: 'booked', reservationId: null, bookedChoice: CHOICE_A, attempts: 1 });
    });

    it.each([
      ['a 503 on the POST', { kind: 'rejected', outcome: { kind: 'server_error', status: 503 } }],
      ['a lost answer', { kind: 'ambiguous' }],
    ] as const)(
      '%s that created nothing: after the full calendar wait the loop goes back to the gate and books on a FRESH probe',
      async (_label, answer) => {
        const t = setupFire({
          ...now,
          script: () => ({
            probeForm: bySequence([openGate(GATE_HASH), openGate(SECOND_GATE_HASH)]),
            book: bySequence([answer, { kind: 'booked', reservationId: 777 }]),
          }),
        });
        expect(await t.run()).toEqual({ kind: 'booked', reservationId: 777, choice: CHOICE_A });
        expect(t.api.calls.map((c) => c.name)).toEqual([
          'probeForm',
          'book',
          'getDay',
          'getDay',
          'getDay',
          'getDay',
          'getDay',
          'probeForm',
          'book',
        ]);
        const books = t.api.callsOf('book');
        expect((books[1]?.monoMs ?? 0) - (books[0]?.monoMs ?? 0)).toBeGreaterThanOrEqual(12_000);
        expect(t.api.bookRequests.map((r) => r.account.hash)).toEqual([GATE_HASH, SECOND_GATE_HASH]);
        expect(t.api.bookWithoutFreshProbe).toBe(0);
        expect(t.api.maxActiveBooks).toBe(1);
        expect(t.sink.kinds()).toEqual(['window_open', 'ambiguous', 'booked']);
        expect(t.stored()).toMatchObject({ state: 'booked', reservationId: 777, attempts: 2 });
      },
    );

    it('a booking that only shows up at the next gate (daily_limit) is recognised as ours, nothing more is sent', async () => {
      const t = setupFire({
        ...now,
        script: () => ({
          probeForm: bySequence([openGate(), { kind: 'daily_limit' }]),
          book: () => ({ kind: 'ambiguous' }),
          getDay: (date, nth) => makeDay(date, nth >= 5 ? { own: [CHOICE_A] } : {}),
        }),
      });
      expect(await t.run()).toEqual({ kind: 'booked', reservationId: null, choice: CHOICE_A });
      expect(t.api.count('book')).toBe(1);
      expect(t.api.count('getDay')).toBe(6);
    });

    it.each(unclear)('%s: nothing found and no attempts left -> failed ambiguous_unresolved (the cap still holds)', async (_label, answer) => {
      const t = setupFire({ ...now, script: () => ({ book: () => answer }) });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'ambiguous_unresolved' });
      expect(t.api.count('book')).toBe(3);
      expect(t.api.count('getDay')).toBe(15);
      expect(t.api.bookWithoutFreshProbe).toBe(0);
      const polls = t.api.callsOf('getDay').map((c) => c.monoMs);
      for (let i = 1; i < polls.length; i++) {
        if (i % 5 !== 0) expect((polls[i] ?? 0) - (polls[i - 1] ?? 0)).toBeGreaterThanOrEqual(3000);
      }
      expect(t.sink.kinds()).toEqual(['window_open', 'ambiguous', 'ambiguous', 'ambiguous', 'failed']);
      expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'ambiguous_unresolved', attempts: 3 });
    });

    it('with a single attempt allowed nothing is ever re-sent: one request, five polls, ambiguous_unresolved', async () => {
      const t = setupFire({ ...now, deps: { options: { maxAttempts: 1 } }, script: () => ({ book: () => ({ kind: 'ambiguous' }) }) });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'ambiguous_unresolved' });
      expect(t.api.count('book')).toBe(1);
      expect(t.api.count('getDay')).toBe(5);
      expect(t.api.count('probeForm')).toBe(1);
      expect(t.sink.kinds()).toEqual(['window_open', 'ambiguous', 'failed']);
    });

    it('when the window time ran out during the wait nothing is re-sent either, and the reason keeps the alarm (not window_timeout)', async () => {
      const t = setupFire({
        ...now,
        deps: { options: { windowLimitMs: 5000 } },
        script: () => ({ book: () => ({ kind: 'rejected', outcome: { kind: 'server_error', status: 502 } }) }),
      });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'ambiguous_unresolved' });
      expect(t.api.count('book')).toBe(1);
      expect(t.stored().attempts).toBe(1);
    });

    it('the number and spacing of the calendar checks are configurable', async () => {
      const t = setupFire({
        ...now,
        deps: { options: { reconcilePolls: 2, reconcileIntervalMs: 1500, maxAttempts: 1 } },
        script: () => ({ book: () => ({ kind: 'ambiguous' }) }),
      });
      await t.run();
      expect(t.api.count('getDay')).toBe(2);
      const polls = t.api.callsOf('getDay');
      expect((polls[1]?.monoMs ?? 0) - (polls[0]?.monoMs ?? 0)).toBeGreaterThanOrEqual(1500);
    });

    it('an exception thrown by book() is treated as unclear: reconcile first, no immediate retry', async () => {
      const t = setupFire({
        ...now,
        script: () => ({
          book: (_request, nth) => {
            if (nth === 0) throw new Error('boom');
            return { kind: 'booked', reservationId: 31 };
          },
        }),
      });
      expect(await t.run()).toEqual({ kind: 'booked', reservationId: 31, choice: CHOICE_A });
      expect(t.api.calls.map((c) => c.name).slice(0, 8)).toEqual(['probeForm', 'book', 'getDay', 'getDay', 'getDay', 'getDay', 'getDay', 'probeForm']);
      expect(t.sink.kinds()).toContain('ambiguous');
    });

    it('failed calendar reads count as polls (the bounded wait still ends)', async () => {
      const t = setupFire({
        ...now,
        deps: { options: { maxAttempts: 1 } },
        script: () => ({
          book: () => ({ kind: 'ambiguous' }),
          getDay: () => {
            throw new Error('network down');
          },
        }),
      });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'ambiguous_unresolved' });
      expect(t.api.count('getDay')).toBe(5);
    });

    it('a calendar read that finds the session gone logs in ONCE and goes on', async () => {
      const t = setupFire({
        ...now,
        script: () => ({
          book: () => ({ kind: 'ambiguous' }),
          getDay: (date, nth) => {
            if (nth === 0) throw new AuthExpiredError();
            return makeDay(date, { own: [CHOICE_A] });
          },
        }),
      });
      expect((await t.run()).kind).toBe('booked');
      expect(t.api.count('login')).toBe(1);
    });

    it('the stop flag raised during the wait ends the job before anything is re-sent (the calendar wait itself is not cut)', async () => {
      const t = setupFire({
        ...now,
        script: () => ({
          book: () => {
            t.store.setStopped(true);
            return { kind: 'ambiguous' };
          },
        }),
      });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'stopped' });
      expect(t.api.count('book')).toBe(1);
      expect(t.api.count('getDay')).toBe(5);
    });
  });

  describe('an answer nobody understands', () => {
    const unknown = { kind: 'rejected', outcome: { kind: 'unknown', status: 200, message: 'something new' } } as const;

    it('stops the job: one request, never re-sent, the owner is alerted, and the calendar is watched for the full wait', async () => {
      const t = setupFire({ ...now, script: () => ({ book: () => unknown }) });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'unknown_response' });
      expect(t.api.count('book')).toBe(1);
      expect(t.api.count('probeForm')).toBe(1);
      expect(t.api.count('getDay')).toBe(5);
      const polls = t.api.callsOf('getDay').map((c) => c.monoMs);
      for (let i = 1; i < polls.length; i++) expect((polls[i] ?? 0) - (polls[i - 1] ?? 0)).toBeGreaterThanOrEqual(3000);
      expect(t.sink.kinds()).toEqual(['window_open', 'ambiguous', 'failed']);
      expect(t.sink.ofKind('ambiguous')[0]?.detail).toContain('not understood');
      expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'unknown_response', attempts: 1 });
    });

    it('if the booking exists (e.g. success without a readable id) it is recorded as booked, even when the calendar lags', async () => {
      const immediate = setupFire({ ...now, script: () => ({ book: () => unknown, ...ownOn(CHOICE_A) }) });
      expect(await immediate.run()).toEqual({ kind: 'booked', reservationId: null, choice: CHOICE_A });
      expect(immediate.api.count('book')).toBe(1);
      expect(immediate.sink.kinds()).toEqual(['window_open', 'ambiguous', 'booked']);

      const lagging = setupFire({
        ...now,
        script: () => ({ book: () => unknown, getDay: (date, nth) => makeDay(date, nth >= 3 ? { own: [CHOICE_A] } : {}) }),
      });
      expect(await lagging.run()).toEqual({ kind: 'booked', reservationId: null, choice: CHOICE_A });
      expect(lagging.api.count('getDay')).toBe(4);
      expect(lagging.api.count('book')).toBe(1);
      expect(lagging.stored()).toMatchObject({ state: 'booked', bookedChoice: CHOICE_A });
    });

    it('a slot that is not free (taken by somebody else) rules that choice out and the next choice is tried on a fresh probe', async () => {
      const t = setupFire({
        ...now,
        script: () => ({
          probeForm: bySequence([openGate(GATE_HASH), openGate(SECOND_GATE_HASH)]),
          book: bySequence([unknown, { kind: 'booked', reservationId: 888 }]),
          getDay: (date) => makeDay(date, { taken: [CHOICE_A] }),
        }),
      });
      expect(await t.run()).toEqual({ kind: 'booked', reservationId: 888, choice: CHOICE_B });
      expect(t.api.bookRequests.map((r) => r.slot.courtId)).toEqual([9, 10]);
      expect(t.api.bookRequests.map((r) => r.account.hash)).toEqual([GATE_HASH, SECOND_GATE_HASH]);
      expect(t.api.count('getDay')).toBe(5);
      expect(t.api.bookWithoutFreshProbe).toBe(0);
      expect(t.stored()).toMatchObject({ state: 'booked', attempts: 2, bookedChoice: CHOICE_B });
    });

    it('the same slot is never sent twice after an unknown answer, taken or not', async () => {
      const t = setupFire({ ...now, script: () => ({ book: () => unknown, getDay: (date) => makeDay(date, { taken: [CHOICE_A] }) }) });
      const result = await t.run();
      expect(result).toEqual({ kind: 'failed', reason: 'unknown_response' });
      expect(t.api.bookRequests.map((r) => r.slot.courtId)).toEqual([9, 10]);
    });

    it('with no other choice left the job ends (no_choice_available), nothing more is sent', async () => {
      const t = setupFire({
        ...now,
        job: { choices: [CHOICE_A] },
        script: () => ({ book: () => unknown, getDay: (date) => makeDay(date, { taken: [CHOICE_A] }) }),
      });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'no_choice_available' });
      expect(t.api.count('book')).toBe(1);
    });

    it('a free slot or an unreadable calendar does NOT move on: the job stops', async () => {
      const unreadable = setupFire({
        ...now,
        script: () => ({ book: () => unknown, getDay: () => { throw new Error('network down'); } }),
      });
      expect(await unreadable.run()).toEqual({ kind: 'failed', reason: 'unknown_response' });
      expect(unreadable.api.count('book')).toBe(1);
    });

    it('a shutdown during the calendar wait leaves the job in `firing` for recovery', async () => {
      const controller = new AbortController();
      const t = setupFire({
        ...now,
        deps: { signal: controller.signal },
        script: () => ({
          book: () => {
            controller.abort();
            return unknown;
          },
        }),
      });
      expect(await t.run()).toEqual({ kind: 'aborted' });
      expect(t.stored().state).toBe('firing');
    });
  });

  describe('not_sent (the request never left this machine)', () => {
    it('is retried after a short pause, through a FRESH probe, and counted as an attempt only in the store', async () => {
      const t = setupFire({
        ...now,
        script: () => ({ book: bySequence([{ kind: 'not_sent' }, { kind: 'booked', reservationId: 12 }]) }),
      });
      expect(await t.run()).toEqual({ kind: 'booked', reservationId: 12, choice: CHOICE_A });
      expect(t.api.calls.map((c) => c.name)).toEqual(['probeForm', 'book', 'probeForm', 'book']);
      expect(t.api.bookWithoutFreshProbe).toBe(0);
      expect(t.clock.sleeps).toContain(300);
      expect(t.stored().attempts).toBe(2);
    });

    it('does not use up the attempt cap, but is bounded by its own limit', async () => {
      const t = setupFire({ ...now, script: () => ({ book: () => ({ kind: 'not_sent' }) }) });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'not_sent_exhausted' });
      expect(t.api.count('book')).toBe(6);
      expect(t.api.bookWithoutFreshProbe).toBe(0);
    });

    it('a genuine attempt after not_sent still counts toward the cap', async () => {
      const t = setupFire({
        ...now,
        script: () => ({
          book: bySequence([
            { kind: 'not_sent' },
            { kind: 'rejected', outcome: { kind: 'not_open_yet' } },
            { kind: 'rejected', outcome: { kind: 'not_open_yet' } },
            { kind: 'rejected', outcome: { kind: 'not_open_yet' } },
          ]),
        }),
      });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'max_attempts' });
      expect(t.api.count('book')).toBe(4);
    });
  });

  it('a court the guard refuses inside book() fails the job without any retry', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        book: () => {
          throw new CourtNotAllowedError(1, '2026-10-20');
        },
      }),
    });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'court_not_allowed' });
    expect(t.api.count('book')).toBe(1);
    expect(t.api.count('getDay')).toBe(0);
  });

  it('a booking recorded while the job was cancelled in the meantime is still stored as booked', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        book: () => {
          t.store.transition(1, 'firing', 'cancelled', 0);
          return { kind: 'booked', reservationId: 55 };
        },
      }),
    });
    expect((await t.run()).kind).toBe('booked');
    expect(t.stored()).toMatchObject({ state: 'booked', reservationId: 55 });
    expect(t.sink.kinds()).toContain('booked');
  });

  it('payment by card: the booking becomes needs_payment (only when explicitly allowed)', async () => {
    const t = setupFire({ ...now, job: { payment: 'card' }, deps: { allowCardPayment: true } });
    expect(await t.run()).toEqual({ kind: 'needs_payment', reservationId: 100_002, choice: CHOICE_A });
    expect(t.stored()).toMatchObject({ state: 'needs_payment', reservationId: 100_002 });
    expect(t.sink.kinds()).toEqual(['window_open', 'needs_payment']);
    expect(t.api.bookRequests[0]?.payment).toBe('card');
  });

  it('the job date is passed on exactly as stored', async () => {
    const t = setupFire({ ...now, job: { gameDate: parseGameDate('2026-10-20') } });
    await t.run();
    expect(t.api.bookRequests[0]?.slot.gameDate).toBe('2026-10-20');
  });
});
