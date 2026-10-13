import { describe, expect, it } from 'vitest';
import { AuthExpiredError, LoginFailedError, UnexpectedResponseError } from '../../src/reservaplay/errors.js';
import { TransportError } from '../../src/reservaplay/http.js';
import { CHOICE_A, CHOICE_B, bySequence, closedGate, makeDay, openGate, type ApiScript } from './_fakes.js';
import { setupFire } from './_fireHarness.js';

const now = { startOffsetMs: 0 } as const;

const failTimes = (count: number, error: () => Error): NonNullable<ApiScript['login']> => (nth) => {
  if (nth < count) throw error();
};

describe('a login that fails at the opening does not end the job while the window is open', () => {
  const errors = [
    ['HTTP 503 (LoginFailedError)', () => new LoginFailedError('Login request refused (HTTP 503)')],
    ['HTTP 429 (LoginFailedError)', () => new LoginFailedError('Login request refused (HTTP 429)')],
    ['a timeout', () => new TransportError('login_submit', 'timeout', true, null)],
    ['an unexpected page', () => new UnexpectedResponseError('Login page answered HTTP 502', 502)],
  ] as const;

  it.each(errors)('%s on the first attempt: logs in on the second and books', async (_label, error) => {
    const t = setupFire({
      ...now,
      script: () => ({ probeForm: bySequence([{ kind: 'login_required' }, openGate()]), login: failTimes(1, error) }),
    });
    expect((await t.run()).kind).toBe('booked');
    expect(t.api.count('login')).toBe(2);
    expect(t.api.count('book')).toBe(1);
    const logins = t.api.callsOf('login');
    expect((logins[1]?.monoMs ?? 0) - (logins[0]?.monoMs ?? 0)).toBeGreaterThanOrEqual(1500);
  });

  it('gives up after a bounded number of attempts with reason auth, nothing sent', async () => {
    const t = setupFire({
      ...now,
      script: () => ({ probeForm: () => ({ kind: 'login_required' }), login: failTimes(100, () => new LoginFailedError('HTTP 503')) }),
    });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'auth' });
    expect(t.api.count('login')).toBe(5);
    expect(t.api.count('book')).toBe(0);
  });

  it('the attempts and the delay are configurable', async () => {
    const t = setupFire({
      ...now,
      deps: { options: { maxLoginAttempts: 2, loginRetryDelayMs: 400 } },
      script: () => ({ probeForm: () => ({ kind: 'login_required' }), login: failTimes(100, () => new LoginFailedError()) }),
    });
    expect((await t.run()).kind).toBe('failed');
    expect(t.api.count('login')).toBe(2);
    expect(t.clock.sleeps).toContain(400);
  });

  it('an error that is not a site or network failure is not retried', async () => {
    const t = setupFire({
      ...now,
      script: () => ({ probeForm: () => ({ kind: 'login_required' }), login: failTimes(100, () => new TypeError('bug')) }),
    });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'auth' });
    expect(t.api.count('login')).toBe(1);
  });

  it('never retries beyond the end of the window', async () => {
    const t = setupFire({
      ...now,
      deps: { options: { windowLimitMs: 5000, loginRetryDelayMs: 4000, maxLoginAttempts: 10 } },
      script: () => ({ probeForm: () => ({ kind: 'login_required' }), login: failTimes(100, () => new LoginFailedError()) }),
    });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'auth' });
    expect(t.api.count('login')).toBe(2);
  });

  it('a shutdown during the retries leaves the job in firing', async () => {
    const controller = new AbortController();
    const t = setupFire({
      ...now,
      deps: { signal: controller.signal },
      script: () => ({
        probeForm: () => ({ kind: 'login_required' }),
        login: () => {
          controller.abort();
          throw new LoginFailedError('HTTP 503');
        },
      }),
    });
    expect(await t.run()).toEqual({ kind: 'aborted' });
    expect(t.api.count('login')).toBe(1);
    expect(t.stored().state).toBe('firing');
  });

  it('failed attempts do not use up the re-logins: a session that dies again later in the window is replaced again', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        probeForm: bySequence([{ kind: 'login_required' }, { kind: 'login_required' }, openGate()]),
        login: (nth) => {
          if (nth === 0) throw new LoginFailedError('HTTP 503');
        },
      }),
    });
    expect((await t.run()).kind).toBe('booked');
    expect(t.api.count('login')).toBe(3);
  });

  it('the login inside a calendar check is retried too', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        book: () => ({ kind: 'ambiguous' }),
        getDay: (date, nth) => {
          if (nth === 0) throw new AuthExpiredError();
          return makeDay(date, { own: [CHOICE_A] });
        },
        login: failTimes(1, () => new LoginFailedError('HTTP 503')),
      }),
    });
    expect((await t.run()).kind).toBe('booked');
    expect(t.api.count('login')).toBe(2);
    expect(t.api.count('book')).toBe(1);
  });
});

describe('a form page nobody understands, when nothing was sent', () => {
  const unknown = { kind: 'unknown' } as const;

  it.each([1, 2])('%s unknown page(s) followed by an open form: the booking goes ahead, no calendar look', async (pages) => {
    const t = setupFire({
      ...now,
      script: () => ({ probeForm: bySequence([...Array.from({ length: pages }, () => unknown), openGate()]) }),
    });
    expect((await t.run()).kind).toBe('booked');
    expect(t.api.count('probeForm')).toBe(pages + 1);
    expect(t.api.count('getDay')).toBe(0);
    expect(t.api.count('book')).toBe(1);
  });

  it('unknown pages that are not consecutive never add up', async () => {
    const t = setupFire({
      ...now,
      script: (clock) => ({
        probeForm: bySequence([unknown, closedGate(clock), unknown, closedGate(clock), unknown, closedGate(clock), openGate()]),
      }),
    });
    expect((await t.run()).kind).toBe('booked');
    expect(t.api.count('getDay')).toBe(0);
  });

  it('keeps probing at the normal pace (never faster than 4 requests per second)', async () => {
    const t = setupFire({ ...now, script: () => ({ probeForm: bySequence([unknown, unknown, openGate()]) }) });
    await t.run();
    const probes = t.api.callsOf('probeForm');
    for (let i = 1; i < probes.length; i++) {
      expect((probes[i]?.monoMs ?? 0) - (probes[i - 1]?.monoMs ?? 0)).toBeGreaterThanOrEqual(250);
    }
  });

  it('the tolerance is configurable', async () => {
    const t = setupFire({
      ...now,
      deps: { options: { maxUnknownFormProbes: 1 } },
      script: () => ({ probeForm: bySequence([unknown, openGate()]) }),
    });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'unknown_form' });
    expect(t.api.count('book')).toBe(0);
  });

  it('after the calendar ruled a choice out, the next choice starts with a fresh count', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        probeForm: () => unknown,
        getDay: (date) => makeDay(date, { taken: [CHOICE_A] }),
      }),
    });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'unknown_form' });
    expect(t.api.callsOf('probeForm').map((c) => c.courtId)).toEqual([9, 9, 9, 10, 10, 10]);
    expect(t.api.count('book')).toBe(0);
  });
});

describe('a booking answer that says "not processed" (408, 425, 429)', () => {
  const throttled = (status: number) => ({ kind: 'rejected', outcome: { kind: 'unknown', status, message: null } }) as const;

  it.each([408, 425, 429])('%s: the calendar is checked, then a FRESH gate allows one more request', async (status) => {
    const t = setupFire({
      ...now,
      script: () => ({
        probeForm: bySequence([openGate(), openGate()]),
        book: bySequence([throttled(status), { kind: 'booked', reservationId: 31 }]),
      }),
    });
    expect(await t.run()).toEqual({ kind: 'booked', reservationId: 31, choice: CHOICE_A });
    expect(t.api.calls.map((c) => c.name)).toEqual(['probeForm', 'book', 'getDay', 'getDay', 'probeForm', 'book']);
    expect(t.api.bookWithoutFreshProbe).toBe(0);
    expect(t.api.maxActiveBooks).toBe(1);
    expect(t.sink.kinds()).toEqual(['window_open', 'ambiguous', 'booked']);
    expect(t.stored()).toMatchObject({ state: 'booked', attempts: 2 });
  });

  it('when the calendar shows our booking after all, it is recorded and nothing is sent again', async () => {
    const t = setupFire({ ...now, script: () => ({ book: () => throttled(429), getDay: (date) => makeDay(date, { own: [CHOICE_B] }) }) });
    expect(await t.run()).toEqual({ kind: 'booked', reservationId: null, choice: CHOICE_B });
    expect(t.api.count('book')).toBe(1);
  });

  it('keeps being throttled: bounded by the attempt cap', async () => {
    const t = setupFire({ ...now, script: () => ({ book: () => throttled(429) }) });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'ambiguous_unresolved' });
    expect(t.api.count('book')).toBe(3);
  });

  it('an unreadable calendar leaves it unresolved: nothing is sent again', async () => {
    const t = setupFire({
      ...now,
      script: () => ({
        book: () => throttled(429),
        getDay: () => {
          throw new Error('network down');
        },
      }),
    });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'ambiguous_unresolved' });
    expect(t.api.count('book')).toBe(1);
  });

  it.each([200, 403, 404, 302, 0])('status %s is still an answer nobody understands: stop, never re-send', async (status) => {
    const t = setupFire({ ...now, script: () => ({ book: () => throttled(status) }) });
    expect(await t.run()).toEqual({ kind: 'failed', reason: 'unknown_response' });
    expect(t.api.count('book')).toBe(1);
    expect(t.api.count('getDay')).toBe(5);
  });
});
