import { describe, expect, it } from 'vitest';
import { parseGameDate } from '../../src/config/gameDate.js';
import { gameDayEndsAtMs } from '../../src/sniper/gameDay.js';
import { madridInstant } from '../qa/_helpers.js';
import type { ClockCalibration } from '../../src/sniper/clock.js';
import { ACCOUNT, GAME_DATE, GATE_HASH, OPENS_AT_MS, closedGate, gateAt } from './_fakes.js';
import { MINUTE, setupRunner } from './_runnerHarness.js';

describe('runner: pickup, preflight and firing on a virtual timeline', () => {
  it('does nothing until 10 minutes before the window opens', async () => {
    const t = setupRunner();
    await t.drive(t.opensAtMs - 10 * MINUTE - 1000);
    expect(t.api.calls).toEqual([]);
    expect(t.stored().state).toBe('scheduled');
    expect(t.sink.events).toEqual([]);
  });

  it('picks the job up at T-10 min: scheduled -> warming, `armed`, preflight, `preflight_ok`', async () => {
    const t = setupRunner();
    await t.drive(t.opensAtMs - 10 * MINUTE + 10_000);
    expect(t.stored().state).toBe('warming');
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_ok']);
    expect(t.api.calls[0]?.name).toBe('login');
    expect(t.api.calls[0]?.atMs).toBeGreaterThanOrEqual(t.opensAtMs - 10 * MINUTE);
    expect(t.sink.ofKind('preflight_ok')[0]).toMatchObject({ walletCents: 10_000, quoteCents: 1902 });
    expect(t.sink.ofKind('armed')[0]?.job.state).toBe('warming');
  });

  it('runs the whole story: warm up, fire 3 s before the window, book exactly once after it opened', async () => {
    const t = setupRunner();
    await t.drive(t.opensAtMs + 30_000);

    expect(t.sink.kinds()).toEqual(['armed', 'preflight_ok', 'window_open', 'booked']);
    expect(t.store.statesOf(1)).toEqual(['warming', 'firing', 'firing', 'booked']);
    expect(t.stored()).toMatchObject({ state: 'booked', reservationId: 100_002, bookedChoice: { courtId: 9, startMinutes: 1080 }, attempts: 1 });
    expect(t.api.count('login')).toBe(1);
    expect(t.api.count('book')).toBe(1);
    expect(t.api.count('cancel')).toBe(0);

    const firingProbes = t.api.callsOf('probeForm').filter((call) => call.serverMs > t.opensAtMs - 60_000);
    expect(firingProbes[0]?.serverMs).toBeGreaterThanOrEqual(t.opensAtMs - 3000);
    expect(firingProbes[0]?.serverMs).toBeLessThanOrEqual(t.opensAtMs - 2000);
    const book = t.api.callsOf('book')[0];
    expect(book?.serverMs).toBeGreaterThanOrEqual(t.opensAtMs);
    expect(book?.serverMs).toBeLessThanOrEqual(t.opensAtMs + 250);
    expect(t.api.bookRequests[0]?.account).toEqual({ accountId: ACCOUNT.accountId, hash: GATE_HASH });
    expect(t.api.bookWithoutFreshProbe).toBe(0);
  });

  it('never sleeps longer than one second in one call, over the whole 15 minutes', async () => {
    const t = setupRunner();
    await t.drive(t.opensAtMs + 30_000);
    expect(t.clock.maxSleepMs()).toBeLessThanOrEqual(1000);
    expect(t.clock.sleeps.length).toBeGreaterThan(900);
  });

  it('keeps the session alive every 5 minutes while waiting, plus one check a minute before the window', async () => {
    const t = setupRunner();
    await t.drive(t.opensAtMs + 5000);
    const keepAlives = t.api.callsOf('keepAlive').map((call) => call.serverMs);
    expect(keepAlives).toHaveLength(2);
    expect(keepAlives[0]).toBeGreaterThanOrEqual(t.opensAtMs - 5 * MINUTE);
    expect(keepAlives[0]).toBeLessThanOrEqual(t.opensAtMs - 5 * MINUTE + 8000);
    expect(keepAlives[1]).toBeGreaterThanOrEqual(t.opensAtMs - 60_000);
    expect(keepAlives[1]).toBeLessThanOrEqual(t.opensAtMs - 60_000 + 2500);
    expect(t.api.count('login')).toBe(1);
  });

  it('a keep-alive that fails is answered by ONE login and the job still fires', async () => {
    const t = setupRunner({
      script: () => ({
        keepAlive: (nth) => {
          if (nth === 0) throw new Error('socket hang up');
        },
      }),
    });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.api.count('login')).toBe(2);
    expect(t.stored().state).toBe('booked');
  });

  it('a keep-alive that fails together with the re-login re-runs the preflight later (and still fires)', async () => {
    const t = setupRunner({
      script: () => ({
        keepAlive: (nth) => {
          if (nth === 0) throw new Error('down');
        },
        login: (nth) => {
          if (nth === 1) throw new Error('down');
        },
      }),
    });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.stored().state).toBe('booked');
    expect(t.sink.ofKind('preflight_failed').map((e) => e.reason)).toContain('auth');
  });

  it('uses the account id of the preflight, with the hash of the form that opened', async () => {
    const t = setupRunner({ script: () => ({ getAccountContext: () => ({ accountId: 777, hash: 'd'.repeat(40) }) }) });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.api.bookRequests[0]?.account.accountId).toBe(777);
    expect(t.api.bookRequests[0]?.account.hash).toBe(GATE_HASH);
  });

  it('leaves jobs of later days alone while an earlier one is handled', async () => {
    const t = setupRunner();
    const later = t.addJob(parseGameDate('2026-10-27'));
    await t.drive(t.opensAtMs + 30_000);
    expect(t.stored(later.id).state).toBe('scheduled');
    expect(t.api.calls.every((call) => call.gameDate === undefined || call.gameDate !== '2026-10-27')).toBe(true);
  });
});

describe('runner: nothing slows down the first probe', () => {
  const PREFLIGHT_CALLS = ['login', 'keepAlive', 'getDay', 'getAccountContext', 'getWallet', 'quote'];
  const unquotable = (): never => {
    throw new Error('window closed');
  };

  it('a job that keeps being rechecked (money missing on an estimate) starts no recheck in the last 10 s: the first probe is on time', async () => {
    const t = setupRunner({
      options: { recheckEveryMs: 4000 },
      script: () => ({ getWallet: () => ({ balanceCents: 500 }), quote: unquotable }),
    });
    await t.drive(t.opensAtMs + 30_000);

    const fireAtMs = t.opensAtMs - 3000;
    expect(t.api.callsOf('getWallet').length).toBeGreaterThan(20);
    expect(t.api.calls.filter((call) => call.serverMs > t.opensAtMs - 13_000 && PREFLIGHT_CALLS.includes(call.name))).toEqual([]);
    const firstFiringProbe = t.api.callsOf('probeForm').find((call) => call.serverMs > t.opensAtMs - 13_000);
    expect(firstFiringProbe?.serverMs).toBeGreaterThanOrEqual(fireAtMs);
    expect(firstFiringProbe?.serverMs).toBeLessThanOrEqual(fireAtMs + 1500);
    expect(t.stored().state).toBe('booked');
  });

  it('with the quiet period switched off the same job is rechecked right up to the start of firing (what the option is for)', async () => {
    const t = setupRunner({
      options: { recheckEveryMs: 4000, fireQuietMs: 0 },
      script: () => ({ getWallet: () => ({ balanceCents: 500 }), quote: unquotable }),
    });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.api.calls.some((call) => call.serverMs > t.opensAtMs - 9000 && PREFLIGHT_CALLS.includes(call.name))).toBe(true);
  });

  it('regular keep-alives stop in the last 10 s too (the check one minute before the window is kept)', async () => {
    const t = setupRunner({ options: { keepAliveEveryMs: 1000 } });
    await t.drive(t.opensAtMs + 30_000);
    const keepAlives = t.api.callsOf('keepAlive').map((call) => call.serverMs);
    expect(keepAlives.length).toBeGreaterThan(100);
    expect(keepAlives.filter((at) => at > t.opensAtMs - 13_000)).toEqual([]);
    expect(t.stored().state).toBe('booked');
  });

  it('a session that is gone when firing starts is handled by the firing loop with ONE login, not by a late recheck', async () => {
    let served = false;
    const t = setupRunner({
      script: (clock, opens) => ({
        probeForm: () => {
          if (!served && clock.nowMs() >= opens - 3000) {
            served = true;
            return { kind: 'login_required' };
          }
          return gateAt(clock, opens)();
        },
      }),
    });
    await t.drive(t.opensAtMs + 60_000);
    expect(t.stored().state).toBe('booked');
    expect(t.api.count('login')).toBe(2);
    expect(t.api.callsOf('login')[1]?.serverMs).toBeGreaterThanOrEqual(t.opensAtMs - 3000);
  });
});

describe('runner: a job created after the window opened ("book now")', () => {
  it('is picked up at once, warmed up and fired immediately - it does not wait for anything', async () => {
    const t = setupRunner({ startOffsetMs: 3 * 3_600_000 });
    const startedAt = t.clock.nowMs();
    await t.drive(startedAt + 30_000);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_ok', 'window_open', 'booked']);
    expect(t.stored().state).toBe('booked');
    expect(t.api.callsOf('book')[0]?.atMs).toBeLessThan(startedAt + 6000);
    expect(t.api.count('probeForm')).toBe(2);
  });

  it('a window that opened a moment ago behaves the same', async () => {
    const t = setupRunner({ startOffsetMs: 4000 });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.stored().state).toBe('booked');
  });

  it('the game date has passed: expired, nothing contacted, the owner is told', async () => {
    const end = gameDayEndsAtMs(GAME_DATE);
    const t = setupRunner({ startOffsetMs: end - OPENS_AT_MS + 5 * 3_600_000 });
    await t.drive(t.clock.nowMs() + 3000);
    expect(t.stored()).toMatchObject({ state: 'expired', failureReason: 'game_date_passed' });
    expect(t.api.calls).toEqual([]);
    expect(t.sink.kinds()).toEqual(['expired']);
  });

  it('the very last second of the game day is still bookable; midnight in the club time zone is not', async () => {
    const end = gameDayEndsAtMs(GAME_DATE);
    expect(end).toBe(madridInstant('2026-10-21', 0));

    const lastSecond = setupRunner({ startOffsetMs: end - 1000 - OPENS_AT_MS });
    await lastSecond.drive(end + 30_000);
    expect(lastSecond.sink.kinds()).toContain('armed');
    expect(lastSecond.stored().state).toBe('booked');

    const atMidnight = setupRunner({ startOffsetMs: end - OPENS_AT_MS });
    await atMidnight.drive(end + 3000);
    expect(atMidnight.stored().state).toBe('expired');
    expect(atMidnight.api.calls).toEqual([]);
  });

  it('a window that never opens ends in window_timeout 90 s after firing started, and nothing is booked', async () => {
    const t = setupRunner({ startOffsetMs: 3 * 3_600_000, script: (clock) => ({ probeForm: () => closedGate(clock) }) });
    await t.drive(t.clock.nowMs() + 200_000);
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'window_timeout' });
    expect(t.api.count('book')).toBe(0);
  });
});

describe('runner: payment mode', () => {
  it('refuses a card job by default: failed, nothing contacted', async () => {
    const t = setupRunner({ job: { payment: 'card' } });
    await t.drive(t.opensAtMs + 10_000);
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'card_payment_disabled' });
    expect(t.api.calls).toEqual([]);
    expect(t.sink.kinds()).toEqual(['failed']);
  });

  it('refuses it also when the flag is anything but true', async () => {
    const t = setupRunner({ job: { payment: 'card' }, deps: { allowCardPayment: false } });
    await t.drive(t.opensAtMs + 10_000);
    expect(t.stored().state).toBe('failed');
    expect(t.api.count('book')).toBe(0);
  });

  it('with the flag it books by card and ends in needs_payment', async () => {
    const t = setupRunner({ job: { payment: 'card' }, deps: { allowCardPayment: true } });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_ok', 'window_open', 'needs_payment']);
    expect(t.stored().state).toBe('needs_payment');
    expect(t.api.bookRequests[0]?.payment).toBe('card');
  });
});

describe('runner: summer-time changes (the opening instant is 07:00 club time, and the clock never sleeps long)', () => {
  const timeline = async (date: string, expectedOpensAtMs: number) => {
    const gameDate = parseGameDate(date);
    const t = setupRunner({ gameDate, startOffsetMs: -15 * MINUTE });
    expect(t.opensAtMs).toBe(expectedOpensAtMs);
    await t.drive(t.opensAtMs + 30_000);
    expect(t.stored().state).toBe('booked');
    expect(t.api.calls[0]?.serverMs).toBeGreaterThanOrEqual(expectedOpensAtMs - 10 * MINUTE);
    expect(t.api.calls[0]?.serverMs).toBeLessThanOrEqual(expectedOpensAtMs - 10 * MINUTE + 2000);
    const firing = t.api.callsOf('probeForm').filter((call) => call.serverMs > expectedOpensAtMs - 60_000);
    expect(firing[0]?.serverMs).toBeGreaterThanOrEqual(expectedOpensAtMs - 3000);
    expect(t.api.callsOf('book')[0]?.serverMs).toBeGreaterThanOrEqual(expectedOpensAtMs);
    expect(t.api.callsOf('book')[0]?.serverMs).toBeLessThanOrEqual(expectedOpensAtMs + 250);
    expect(t.clock.maxSleepMs()).toBeLessThanOrEqual(1000);
  };

  it('autumn change: 1 Nov opens on 25 Oct at 07:00 CET = 06:00Z (not 05:00Z)', async () => {
    await timeline('2026-11-01', madridInstant('2026-10-25', 7));
    expect(madridInstant('2026-10-25', 7)).toBe(Date.UTC(2026, 9, 25, 6, 0, 0));
  });

  it('spring change: 4 Apr 2027 opens on 28 Mar at 07:00 CEST = 05:00Z', async () => {
    await timeline('2027-04-04', madridInstant('2027-03-28', 7));
    expect(madridInstant('2027-03-28', 7)).toBe(Date.UTC(2027, 2, 28, 5, 0, 0));
  });

  it('a long wait on the day of the change is made of one-second ticks and touches the site not at all', async () => {
    const t = setupRunner({ gameDate: parseGameDate('2026-11-01'), startOffsetMs: -100 * MINUTE });
    await t.drive(t.opensAtMs - 11 * MINUTE);
    expect(t.api.calls).toEqual([]);
    expect(t.clock.maxSleepMs()).toBeLessThanOrEqual(1000);
    expect(t.clock.sleeps.length).toBeGreaterThan(5000);
  });
});

describe('runner: the emergency stop', () => {
  it('raised after warm-up and still set at firing time: the job fails with `stopped`, no probe, no booking', async () => {
    const t = setupRunner();
    await t.drive(t.opensAtMs - 5 * MINUTE);
    t.store.setStopped(true);
    const callsBefore = t.api.calls.length;
    await t.drive(t.opensAtMs + 10_000);
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'stopped' });
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_ok', 'failed']);
    expect(t.api.count('book')).toBe(0);
    expect(t.api.calls.length).toBe(callsBefore);
  });

  it('raised before the job was picked up: nothing is contacted at all, the job fails at firing time', async () => {
    const t = setupRunner();
    t.store.setStopped(true);
    await t.drive(t.opensAtMs + 10_000);
    expect(t.api.calls).toEqual([]);
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'stopped' });
    expect(t.sink.kinds()).toEqual(['failed']);
  });

  it('raised and lifted again before the window: the job carries on and books', async () => {
    const t = setupRunner();
    t.store.setStopped(true);
    await t.drive(t.opensAtMs - 7 * MINUTE);
    expect(t.api.calls).toEqual([]);
    t.store.setStopped(false);
    await t.drive(t.opensAtMs + 30_000);
    expect(t.stored().state).toBe('booked');
  });
});

describe('runner: a PC clock that is badly wrong', () => {
  const absurd = (): ClockCalibration => ({
    localNowMs: () => 0,
    offsetMs: () => 0,
    observeServerTime: () => ({ accepted: false, absurd: true, sampleOffsetMs: 300_000, offsetMs: 0, sampleCount: 0 }),
  });

  it('every server reading beyond the sanity limit: the owner is told to check the PC clock (once), and the job still fires', async () => {
    const t = setupRunner({ deps: { calibration: absurd() } });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_failed', 'window_open', 'booked']);
    const warning = t.sink.ofKind('preflight_failed')[0];
    expect(warning?.reason).toBe('other');
    expect(warning?.detail).toMatch(/PC/);
    expect(warning?.detail).toMatch(/clock/);
    expect(t.sink.ofKind('preflight_ok')).toEqual([]);
    expect(t.stored().state).toBe('booked');
  });

  it('the warning is not repeated when the preflight has to be run again later', async () => {
    const t = setupRunner({
      deps: { calibration: absurd() },
      script: () => ({
        keepAlive: (nth) => {
          if (nth === 0) throw new Error('down');
        },
        login: (nth) => {
          if (nth === 1) throw new Error('down');
        },
      }),
    });
    await t.drive(t.opensAtMs + 30_000);
    expect(t.stored().state).toBe('booked');
    expect(t.sink.ofKind('preflight_failed').filter((event) => event.detail.includes('clock'))).toHaveLength(1);
    expect(t.api.count('probeForm')).toBeGreaterThan(10);
  });

  it('a calibrator that accepts at least one reading raises no alarm', async () => {
    const t = setupRunner();
    await t.drive(t.opensAtMs - 9 * MINUTE);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_ok']);
  });

  it('a closed page that carries no clock reading at all is no alarm (nothing was judged absurd)', async () => {
    const t = setupRunner({ script: () => ({ probeForm: () => ({ kind: 'window_closed', serverCheckTime: null }) }) });
    await t.drive(t.opensAtMs - 9 * MINUTE);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_ok']);
  });

  it('a mix of accepted and ignored readings is not an alarm either', async () => {
    let readings = 0;
    const mixed: ClockCalibration = {
      localNowMs: () => 0,
      offsetMs: () => 0,
      observeServerTime: () =>
        readings++ === 0
          ? { accepted: false, absurd: true, sampleOffsetMs: 300_000, offsetMs: 0, sampleCount: 0 }
          : { accepted: true, absurd: false, sampleOffsetMs: 0, offsetMs: 0, sampleCount: 1 },
    };
    const t = setupRunner({ deps: { calibration: mixed } });
    await t.drive(t.opensAtMs - 9 * MINUTE);
    expect(t.sink.kinds()).toEqual(['armed', 'preflight_ok']);
  });
});

describe('runner: the clock follows the server', () => {
  it('a PC clock that is 40 s slow is corrected during preflight, so firing starts 3 s before the REAL opening', async () => {
    const t = setupRunner({ clock: { skewMs: 40_000, applyObservations: true } });
    await t.drive(t.opensAtMs - 20_000);
    expect(Math.abs(t.clock.offsetMs() - 40_000)).toBeLessThanOrEqual(500);
    await t.drive(t.opensAtMs + 60_000);
    const firing = t.api.callsOf('probeForm').filter((call) => call.serverMs > t.opensAtMs - 60_000);
    expect(firing[0]?.serverMs).toBeGreaterThanOrEqual(t.opensAtMs - 4000);
    expect(firing[0]?.serverMs).toBeLessThanOrEqual(t.opensAtMs - 1000);
    expect(t.stored().state).toBe('booked');
    expect(t.api.callsOf('book')[0]?.serverMs).toBeLessThanOrEqual(t.opensAtMs + 1000);
  });

  it('without calibration the same PC would fire 37 s late (this is what the calibration is for)', async () => {
    const t = setupRunner({ clock: { skewMs: 40_000, applyObservations: false } });
    await t.drive(t.opensAtMs + 60_000);
    const book = t.api.callsOf('book')[0];
    expect(book?.serverMs).toBeGreaterThan(t.opensAtMs + 30_000);
  });
});

