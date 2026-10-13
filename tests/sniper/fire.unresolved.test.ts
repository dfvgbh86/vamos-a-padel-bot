import { describe, expect, it } from 'vitest';
import { CHOICE_A, makeDay, openGate, bySequence, type ApiScript } from './_fakes.js';
import { setupFire } from './_fireHarness.js';

const now = { startOffsetMs: 0 } as const;

const ambiguous = { kind: 'ambiguous' } as const;
const serverError = { kind: 'rejected', outcome: { kind: 'server_error', status: 502 } } as const;
const limit = { kind: 'rejected', outcome: { kind: 'daily_limit' } } as const;

const unreadable: Pick<ApiScript, 'getDay'> = {
  getDay: () => {
    throw new Error('network down');
  },
};
const emptyCalendar: Pick<ApiScript, 'getDay'> = { getDay: (date) => makeDay(date, { courts: [] }) };
const courtsWithoutSlots: Pick<ApiScript, 'getDay'> = {
  getDay: (date) => ({ gameDate: date, courts: makeDay(date).courts.map((court) => ({ ...court, slots: [] })) }),
};

describe('an unclear answer is never followed by a second add_event while the calendar could not be read (CONTRACT C3)', () => {
  const answers = [
    ['ambiguous', ambiguous],
    ['server_error', serverError],
  ] as const;
  const blind = [
    ['every calendar read fails', unreadable],
    ['the calendar has no courts', emptyCalendar],
    ['the calendar has courts without slots', courtsWithoutSlots],
  ] as const;

  for (const [answerLabel, answer] of answers) {
    for (const [blindLabel, calendar] of blind) {
      it(`${answerLabel} and ${blindLabel}: ambiguous_unresolved, exactly one request`, async () => {
        const t = setupFire({
          ...now,
          deps: { options: { maxAttempts: 3 } },
          script: () => ({ book: () => answer, ...calendar }),
        });
        expect(await t.run()).toEqual({ kind: 'failed', reason: 'ambiguous_unresolved' });
        expect(t.api.count('book')).toBe(1);
        expect(t.api.count('probeForm')).toBe(1);
        expect(t.sink.kinds()).toEqual(['window_open', 'ambiguous', 'failed']);
        expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'ambiguous_unresolved', attempts: 1 });
      });
    }
  }

  it('a calendar that was read once with slots (nothing of ours) still allows going back to the gate', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        probeForm: bySequence([openGate(), openGate()]),
        book: bySequence([ambiguous, { kind: 'booked', reservationId: 5 }]),
        getDay: (date, nth) => {
          if (nth < 4) throw new Error('network down');
          return makeDay(date);
        },
      }),
    });
    expect((await t.run()).kind).toBe('booked');
    expect(t.api.count('book')).toBe(2);
  });
});

describe('the site says "you already have a booking" after our own request', () => {
  const polls = 5;

  it('as the answer to the POST, calendar shows nothing: alert as ambiguous, not a plain daily_limit', async () => {
    const t = setupFire({ ...now, script: () => ({ book: () => limit }) });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'ambiguous_unresolved' });
    expect(t.api.count('book')).toBe(1);
    expect(t.api.count('getDay')).toBe(polls);
    expect(t.sink.kinds()).toEqual(['window_open', 'ambiguous', 'failed']);
    expect(t.sink.ofKind('ambiguous')[0]?.detail).toContain('probably');
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'ambiguous_unresolved', attempts: 1 });
  });

  it('at the gate after an unclear answer, calendar shows nothing: alert as ambiguous, nothing more is sent', async () => {
    const t = setupFire({
      ...now,
      script: () => ({ probeForm: bySequence([openGate(), { kind: 'daily_limit' }]), book: () => ambiguous }),
    });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'ambiguous_unresolved' });
    expect(t.api.count('book')).toBe(1);
    expect(t.api.count('getDay')).toBe(2 * polls);
    expect(t.sink.kinds()).toEqual(['window_open', 'ambiguous', 'ambiguous', 'failed']);
    expect(t.sink.ofKind('ambiguous')[1]?.detail).toContain('probably');
  });

  it('the calendar shows our booking only on a later poll: it is recorded as booked', async () => {
    const t = setupFire({
      ...now,
      script: () => ({ book: () => limit, getDay: (date, nth) => makeDay(date, nth >= 3 ? { own: [CHOICE_A] } : {}) }),
    });
    expect(await t.run()).toEqual({ kind: 'booked', reservationId: null, choice: CHOICE_A });
    expect(t.api.count('getDay')).toBe(4);
  });

  it('with no request sent by this job the plain daily_limit failure and the single poll stay', async () => {
    const t = setupFire({ ...now, script: () => ({ probeForm: () => ({ kind: 'daily_limit' }) }) });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'daily_limit' });
    expect(t.api.count('getDay')).toBe(1);
    expect(t.sink.kinds()).toEqual(['failed']);
  });
});
