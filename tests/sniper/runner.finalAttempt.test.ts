import { describe, expect, it } from 'vitest';
import { LoginFailedError, UnexpectedResponseError } from '../../src/reservaplay/errors.js';
import { MINUTE, setupRunner } from './_runnerHarness.js';

describe('runner: the site comes back shortly before the opening', () => {
  it('a preflight that is NOT due by the slowed schedule still runs in the last seconds, and the job books', async () => {
    const t = setupRunner({
      script: (clock, opens) => ({
        login: () => {
          if (clock.nowMs() < opens - 30_000) throw new LoginFailedError('Login request refused (HTTP 503)');
        },
      }),
    });
    await t.drive(t.opensAtMs + 30_000);

    expect(t.stored().state).toBe('booked');
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_failed', 'preflight_ok', 'window_open', 'booked']);
    const logins = t.api.callsOf('login').map((call) => call.serverMs);
    expect(logins.at(-1)).toBeGreaterThanOrEqual(t.opensAtMs - 24_000);
    expect(logins.at(-1)).toBeLessThan(t.opensAtMs - 3000);
    expect(t.api.count('book')).toBe(1);
  });

  it('the same for a context that could not be read for another reason (no sample slot): not failed without a last try', async () => {
    const t = setupRunner({
      script: (clock, opens) => ({
        getAccountContext: () => {
          if (clock.nowMs() < opens - 30_000) throw new UnexpectedResponseError('Booking form answered HTTP 502', 502);
          return { accountId: 12345, hash: 'a'.repeat(40) };
        },
      }),
    });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.stored().state).toBe('booked');
  });

  it('when the site stays down the job still fails at firing time, after exactly one extra try shortly before firing starts', async () => {
    const t = setupRunner({
      script: () => ({
        login: () => {
          throw new LoginFailedError('Login request refused (HTTP 503)');
        },
      }),
    });
    await t.drive(t.opensAtMs + 10_000);

    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'auth' });
    const logins = t.api.callsOf('login').map((call) => call.serverMs);
    expect(logins.filter((at) => at >= t.opensAtMs - 24_000).length).toBe(1);
    expect(t.api.count('probeForm')).toBe(0);
    expect(t.api.count('book')).toBe(0);
  });

  it('the extra try runs once, not on every tick of the last seconds', async () => {
    const t = setupRunner({ script: () => ({ getWallet: () => ({ balanceCents: 500 }) }) });
    await t.drive(t.opensAtMs + 10_000);

    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'no_funds' });
    const wallets = t.api.callsOf('getWallet').map((call) => call.serverMs);
    expect(wallets.filter((at) => at >= t.opensAtMs - 24_000).length).toBeLessThanOrEqual(2);
  });

  it('a negative lead is refused', () => {
    expect(() => setupRunner({ options: { finalPreflightLeadMs: -1 } })).toThrow(RangeError);
  });

  it('a job picked up late is not preflighted twice in a row because of the extra try', async () => {
    const t = setupRunner({
      startOffsetMs: -(MINUTE / 2),
      script: () => ({
        login: () => {
          throw new LoginFailedError('HTTP 503');
        },
      }),
    });
    await t.drive(t.opensAtMs + 10_000);
    const logins = t.api.callsOf('login').map((call) => call.serverMs);
    expect(logins.length).toBeLessThanOrEqual(2);
    expect(t.stored().state).toBe('failed');
  });
});
