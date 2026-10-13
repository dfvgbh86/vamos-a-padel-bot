import { describe, expect, it } from 'vitest';
import { LoginFailedError } from '../../src/reservaplay/errors.js';
import { gateAt, type FakeClock } from './_fakes.js';
import { MINUTE, setupRunner } from './_runnerHarness.js';

describe('runner: not enough money (no_funds)', () => {
  const wallet = (balanceCents: number | ((nowMs: number) => number)) => (clock: FakeClock) => ({
    getWallet: () => ({ balanceCents: typeof balanceCents === 'function' ? balanceCents(clock.nowMs()) : balanceCents }),
  });

  it('stays armed, tells the owner once, re-checks every minute, and fails at firing time without sending anything', async () => {
    const t = setupRunner({ script: wallet(500) });
    await t.drive(t.opensAtMs + 10_000);

    expect(t.sink.kinds()).toEqual(['armed', 'preflight_failed', 'failed']);
    expect(t.sink.ofKind('preflight_failed')[0]).toMatchObject({ reason: 'no_funds', detail: 'need 19.02 EUR, wallet has 5.00 EUR' });
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'no_funds' });
    expect(t.api.count('book')).toBe(0);
    expect(t.api.callsOf('probeForm').every((call) => call.serverMs < t.opensAtMs - 9 * MINUTE)).toBe(true);

    const checks = t.api.callsOf('getWallet').map((call) => call.serverMs);
    expect(checks.length).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < checks.length - 1; i++) {
      expect((checks[i] ?? 0) - (checks[i - 1] ?? 0)).toBeGreaterThanOrEqual(59_000);
      expect((checks[i] ?? 0) - (checks[i - 1] ?? 0)).toBeLessThanOrEqual(63_000);
    }
    expect(checks.at(-1)).toBeGreaterThanOrEqual(t.opensAtMs - 4000);
  });

  it('re-checks over the same session: one login, keep-alive instead of logging in again', async () => {
    const t = setupRunner({ script: wallet(500) });
    await t.drive(t.opensAtMs + 10_000);
    expect(t.api.count('login')).toBe(1);
    expect(t.api.count('keepAlive')).toBeGreaterThanOrEqual(9);
  });

  it('money arrives at T-4 min: `preflight_ok` follows and the booking goes ahead', async () => {
    const t = setupRunner({ script: (clock, opens) => wallet(() => (clock.nowMs() >= opens - 4 * MINUTE ? 10_000 : 500))(clock) });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_failed', 'preflight_ok', 'window_open', 'booked']);
    expect(t.stored().state).toBe('booked');
  });

  it('money arrives after the last re-check but before firing: the final wallet look lets it fire', async () => {
    const t = setupRunner({ script: (clock, opens) => wallet(() => (clock.nowMs() >= opens - 30_000 ? 10_000 : 500))(clock) });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_failed', 'window_open', 'booked']);
    expect(t.stored().state).toBe('booked');
  });

  it('a failing final wallet look does not stop the job from firing (the gate decides)', async () => {
    const t = setupRunner({
      script: (clock, opens) => ({
        getWallet: () => {
          if (clock.nowMs() >= opens - 5000) throw new Error('timeout');
          return { balanceCents: 500 };
        },
      }),
    });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.api.count('book')).toBe(1);
  });

  it('a job picked up late with no money fails at once, the owner is told why', async () => {
    const t = setupRunner({ startOffsetMs: 3_600_000, script: wallet(500) });
    await t.drive(t.clock.nowMs() + 20_000);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_failed', 'failed']);
    expect(t.stored().failureReason).toBe('no_funds');
    expect(t.api.count('book')).toBe(0);
  });

  describe('a shortage that rests on an estimate (the site cannot quote before its window opens)', () => {
    const unquotable = (): never => {
      throw new Error('window closed');
    };
    const estimated = (balanceCents: number) => () => ({ getWallet: () => ({ balanceCents }), quote: unquotable });

    it('warns the owner once, but never keeps the job from firing: no extra wallet look, the site decides', async () => {
      const t = setupRunner({ script: estimated(1000) });
      await t.drive(t.opensAtMs + 30_000);

      expect(t.sink.kinds()).toEqual(['armed', 'preflight_failed', 'window_open', 'booked']);
      expect(t.sink.ofKind('preflight_failed')[0]).toMatchObject({ reason: 'no_funds', detail: 'need 19.02 EUR (estimate), wallet has 10.00 EUR' });
      expect(t.stored().state).toBe('booked');
      expect(t.api.count('book')).toBe(1);
      expect(t.api.callsOf('getWallet').every((call) => call.serverMs < t.opensAtMs - 3000)).toBe(true);
    });

    it('a 60 minute job with 15.00 EUR is not short at all (the flat 19.02 would have failed it): no warning, booked', async () => {
      const t = setupRunner({ job: { durationMinutes: 60 }, script: estimated(1500) });
      await t.drive(t.opensAtMs + 30_000);
      expect(t.sink.kinds()).toEqual(['armed', 'preflight_ok', 'window_open', 'booked']);
      expect(t.stored().state).toBe('booked');
    });

    it('a 180 minute job is warned about at preflight time (38.04 EUR), not only when the window opens', async () => {
      const t = setupRunner({ job: { durationMinutes: 180 }, script: estimated(3000) });
      await t.drive(t.opensAtMs - 9 * MINUTE);
      expect(t.sink.ofKind('preflight_failed')[0]).toMatchObject({ reason: 'no_funds', detail: 'need 38.04 EUR (estimate), wallet has 30.00 EUR' });
      expect(t.stored().state).toBe('warming');
    });

    it('if the site then refuses the booking for lack of money the answer is not understood: it stops safely, nothing is retried', async () => {
      const t = setupRunner({
        script: () => ({
          ...estimated(1000)(),
          book: () => ({ kind: 'rejected', outcome: { kind: 'unknown', status: 200, message: 'saldo insuficiente' } }),
        }),
      });
      await t.drive(t.opensAtMs + 60_000);
      expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'unknown_response', attempts: 1 });
      expect(t.api.count('book')).toBe(1);
    });

    it('a shortage on a price the site did quote still ends the job without any request', async () => {
      const t = setupRunner({ script: () => ({ getWallet: () => ({ balanceCents: 500 }), quote: () => ({ totalCents: 1902, walletPayable: true }) }) });
      await t.drive(t.opensAtMs + 10_000);
      expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'no_funds' });
      expect(t.api.count('book')).toBe(0);
    });
  });

  it('the price quoted by the site is what counts, not the typical one', async () => {
    const t = setupRunner({ script: () => ({ getWallet: () => ({ balanceCents: 2000 }), quote: () => ({ totalCents: 2500, walletPayable: false }) }) });
    await t.drive(t.opensAtMs - 9 * MINUTE);
    expect(t.sink.ofKind('preflight_failed')[0]?.detail).toBe('need 25.00 EUR, wallet has 20.00 EUR');
  });
});

describe('runner: the session cannot be established (auth)', () => {
  it('is retried one minute apart, then every two minutes, until firing time; only then the job fails and the owner is told once', async () => {
    const t = setupRunner({
      script: () => ({
        login: () => {
          throw new LoginFailedError();
        },
      }),
    });
    await t.drive(t.opensAtMs + 10_000);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_failed', 'failed']);
    expect(t.sink.ofKind('preflight_failed')[0]?.reason).toBe('auth');
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'auth' });
    const failedAt = t.store.transitions.find((tr) => tr.to === 'failed')?.atMs ?? 0;
    expect(failedAt).toBeGreaterThanOrEqual(t.opensAtMs - 3000);
    expect(failedAt).toBeLessThan(t.opensAtMs - 1500);

    const logins = t.api.callsOf('login').map((call) => call.serverMs);
    expect(logins.length).toBeGreaterThanOrEqual(5);
    expect(logins.length).toBeLessThanOrEqual(7);
    const gaps = logins.slice(1).map((at, i) => at - (logins[i] ?? 0));
    expect(gaps[0]).toBeGreaterThanOrEqual(60_000);
    expect(gaps[0]).toBeLessThan(65_000);
    expect(gaps[1]).toBeGreaterThanOrEqual(60_000);
    for (const gap of gaps.slice(2, -1)) expect(gap).toBeGreaterThanOrEqual(120_000);
    expect(logins.at(-1)).toBeGreaterThanOrEqual(t.opensAtMs - 24_000);
    expect(t.api.count('probeForm')).toBe(0);
    expect(t.api.count('book')).toBe(0);
  });

  it('a login that is refused for several minutes (site outage, throttling) does not end the job: it books once the site is back', async () => {
    const t = setupRunner({
      script: (clock, opens) => ({
        login: () => {
          if (clock.nowMs() < opens - 4 * MINUTE) throw new LoginFailedError('HTTP 503');
        },
      }),
    });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_failed', 'preflight_ok', 'window_open', 'booked']);
    expect(t.sink.ofKind('preflight_failed')[0]?.reason).toBe('auth');
    expect(t.stored().state).toBe('booked');
    expect(t.api.count('login')).toBeGreaterThanOrEqual(4);
  });

  it('a login that works on the second try carries the job through to the booking', async () => {
    const t = setupRunner({
      script: () => ({
        login: (nth) => {
          if (nth === 0) throw new LoginFailedError();
        },
      }),
    });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_failed', 'preflight_ok', 'window_open', 'booked']);
    expect(t.stored().state).toBe('booked');
  });

  it('the number of quick retries is configurable (after them the pace halves)', async () => {
    const t = setupRunner({
      options: { authFastRetries: 1 },
      script: () => ({
        login: () => {
          throw new LoginFailedError();
        },
      }),
    });
    await t.drive(t.opensAtMs - 5 * MINUTE);
    const logins = t.api.callsOf('login').map((call) => call.serverMs);
    expect(logins.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < logins.length; i++) expect((logins[i] ?? 0) - (logins[i - 1] ?? 0)).toBeGreaterThanOrEqual(120_000);
    expect(t.stored().state).toBe('warming');
  });

  it('a job picked up after the window opened with a login that fails is failed at once (no retrying into the void)', async () => {
    const t = setupRunner({
      startOffsetMs: 3_600_000,
      script: () => ({
        login: () => {
          throw new LoginFailedError();
        },
      }),
    });
    await t.drive(t.clock.nowMs() + 20_000);
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'auth' });
    expect(t.api.count('login')).toBe(1);
    expect(t.api.count('book')).toBe(0);
  });
});

describe('runner: other preflight outcomes', () => {
  it('"you already have a booking on that day": the job can never succeed -> failed daily_limit at once', async () => {
    const t = setupRunner({ script: () => ({ probeForm: () => ({ kind: 'daily_limit' }) }) });
    await t.drive(t.opensAtMs + 10_000);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_failed', 'failed']);
    expect(t.sink.ofKind('preflight_failed')[0]?.reason).toBe('daily_limit');
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'daily_limit' });
    expect(t.api.count('book')).toBe(0);
    expect(t.api.callsOf('probeForm').length).toBeLessThanOrEqual(1);
  });

  it('an unreadable form page: reported once, checked again every minute, and fine again later', async () => {
    const t = setupRunner({
      script: (clock, opens) => ({
        probeForm: () => (clock.nowMs() < opens - 5 * MINUTE ? { kind: 'unknown' } : gateAt(clock, opens)()),
      }),
    });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_failed', 'preflight_ok', 'window_open', 'booked']);
    expect(t.sink.ofKind('preflight_failed')[0]?.reason).toBe('window_unknown');
  });

  it('an unreadable form page that never gets better: the job still fires and the gate stops it (nothing sent)', async () => {
    const t = setupRunner({ script: () => ({ probeForm: () => ({ kind: 'unknown' }) }) });
    await t.drive(t.opensAtMs + 10_000);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_failed', 'failed']);
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'unknown_form' });
    expect(t.api.count('book')).toBe(0);
  });

  it('a preflight that could not read the account context at all cannot fire: failed, nothing sent', async () => {
    const t = setupRunner({
      script: () => ({
        getAccountContext: () => {
          throw new Error('form not open');
        },
      }),
    });
    await t.drive(t.opensAtMs + 10_000);
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'other' });
    expect(t.api.count('book')).toBe(0);
    expect(t.api.callsOf('probeForm')).toEqual([]);
  });

  it('a repeated problem is announced once, not every minute', async () => {
    const t = setupRunner({ script: () => ({ getWallet: () => ({ balanceCents: 0 }) }) });
    await t.drive(t.opensAtMs - 3 * MINUTE);
    expect(t.sink.ofKind('preflight_failed')).toHaveLength(1);
  });
});
