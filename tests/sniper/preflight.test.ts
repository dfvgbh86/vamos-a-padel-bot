import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { parseGameDate } from '../../src/config/gameDate.js';
import type { Job } from '../../src/contracts.js';
import { AuthExpiredError, LoginFailedError } from '../../src/reservaplay/errors.js';
import type { ClockCalibration } from '../../src/sniper/clock.js';
import { runPreflight, type PreflightDeps } from '../../src/sniper/preflight.js';
import {
  ACCOUNT,
  FAKE_HASH,
  GAME_DATE,
  NO_HOLIDAYS,
  OPENS_AT_MS,
  FakeApi,
  FakeClock,
  RecordingLogger,
  expectPacing,
  gateAt,
  makeDay,
  makeJob,
  makeRig,
  type ApiScript,
} from './_fakes.js';

const date = parseGameDate;
const ALL_COURTS = [1, 2, 3, 4, 7, 8, 9, 10, 11, 12];

interface Setup {
  readonly script?: (clock: FakeClock) => ApiScript;
  readonly job?: Partial<Job>;
  readonly deps?: Partial<PreflightDeps>;
  /** Clock start; default = T-10 min before the window of 2026-10-20 opens (2026-10-13 06:50 Madrid). */
  readonly startMs?: number;
}

const setup = (options: Setup = {}) => {
  const rig = makeRig({}, options.startMs ?? OPENS_AT_MS - 600_000);
  rig.api.script = { probeForm: gateAt(rig.clock, OPENS_AT_MS), ...options.script?.(rig.clock) };
  const job = makeJob({ state: 'warming', ...options.job });
  const deps: PreflightDeps = {
    api: rig.api,
    clock: rig.clock,
    calibration: rig.clock,
    holidays: NO_HOLIDAYS,
    logger: rig.logger,
    ...options.deps,
  };
  return { ...rig, job, deps, run: () => runPreflight(job, deps) };
};

describe('preflight: the happy path', () => {
  it('logs in once, reads the account context, checks the wallet and probes the closed form', async () => {
    const t = setup();
    const result = await t.run();
    expect(result).toMatchObject({
      ok: true,
      account: ACCOUNT,
      walletCents: 10_000,
      quoteCents: 1902,
      requiredCents: 1902,
    });
    const names = t.api.calls.map((c) => c.name);
    expect(names.slice(0, 5)).toEqual(['login', 'getDay', 'getAccountContext', 'getWallet', 'quote']);
    expect(names.slice(5)).toEqual(['probeForm', 'probeForm', 'probeForm', 'probeForm', 'probeForm']);
    expect(t.api.count('login')).toBe(1);
  });

  it('emits no events and touches no job: it only returns a result', async () => {
    const t = setup();
    await t.run();
    await t.queue.flush();
    expect(t.sink.events).toEqual([]);
    expect(t.store.transitions).toEqual([]);
    expect(t.api.count('book')).toBe(0);
    expect(t.api.count('cancel')).toBe(0);
  });

  it('quotes the FIRST choice for the job duration and probes the same slot', async () => {
    const t = setup({ job: { durationMinutes: 120 } });
    await t.run();
    expect(t.api.callsOf('quote')[0]).toMatchObject({ gameDate: GAME_DATE, courtId: 9 });
    expect(t.api.callsOf('probeForm').every((c) => c.gameDate === GAME_DATE && c.courtId === 9)).toBe(true);
  });

  it('spaces its requests (never faster than about 4 per second)', async () => {
    const t = setup();
    await t.run();
    expectPacing(t.api.calls);
  });

  it('never logs the hash, and returns the context only in the result', async () => {
    const t = setup();
    await t.run();
    expect(t.logger.dump()).not.toContain(FAKE_HASH);
  });

  it('a job without choices cannot be checked', async () => {
    const t = setup({ job: { choices: [] } });
    expect(await t.run()).toMatchObject({ ok: false, reason: 'other' });
    expect(t.api.calls).toEqual([]);
  });
});

describe('preflight: login and session', () => {
  it('a rejected login is reason auth and nothing else is tried', async () => {
    const t = setup({
      script: () => ({
        login: () => {
          throw new LoginFailedError();
        },
      }),
    });
    expect(await t.run()).toMatchObject({ ok: false, reason: 'auth' });
    expect(t.api.calls.map((c) => c.name)).toEqual(['login']);
  });

  it('a session that dies right after login (AuthExpiredError later on) is reason auth', async () => {
    const t = setup({
      script: () => ({
        getDay: () => {
          throw new AuthExpiredError();
        },
      }),
    });
    expect(await t.run()).toMatchObject({ ok: false, reason: 'auth' });
  });

  it('a network failure during login is reason other (the runner retries), not auth', async () => {
    const t = setup({
      script: () => ({
        login: () => {
          throw new Error('getaddrinfo ENOTFOUND');
        },
      }),
    });
    expect(await t.run()).toMatchObject({ ok: false, reason: 'other' });
  });

  it('with reuseSession it checks the session instead of logging in again', async () => {
    const t = setup({ deps: { reuseSession: true } });
    expect((await t.run()).ok).toBe(true);
    expect(t.api.count('keepAlive')).toBe(1);
    expect(t.api.count('login')).toBe(0);
  });

  it('with reuseSession a dead session is replaced by exactly one login', async () => {
    const t = setup({
      deps: { reuseSession: true },
      script: () => ({
        keepAlive: () => {
          throw new AuthExpiredError();
        },
      }),
    });
    expect((await t.run()).ok).toBe(true);
    expect(t.api.count('login')).toBe(1);
  });

  it('with reuseSession a network error in keep-alive does not trigger a login', async () => {
    const t = setup({
      deps: { reuseSession: true },
      script: () => ({
        keepAlive: () => {
          throw new Error('socket hang up');
        },
      }),
    });
    expect(await t.run()).toMatchObject({ ok: false, reason: 'other' });
    expect(t.api.count('login')).toBe(0);
  });
});

describe('preflight: the sample slot for the account context', () => {
  it('starts at the newest open day (19 Oct at 06:50 on 13 Oct) and takes an allowed court, never an academy court', async () => {
    const t = setup({
      script: () => ({ getDay: (day) => makeDay(day, { courts: ALL_COURTS }) }),
    });
    await t.run();
    expect(t.api.callsOf('getDay')[0]?.gameDate).toBe('2026-10-19');
    const sample = t.api.callsOf('getAccountContext')[0];
    expect(sample).toMatchObject({ gameDate: '2026-10-19', courtId: 4 });
  });

  it('skips days on which the account already has a booking (no form would render there)', async () => {
    const t = setup({
      script: () => ({
        getDay: (day) => makeDay(day, day === '2026-10-19' ? { own: [{ courtId: 4, startMinutes: 1080 }] } : {}),
      }),
    });
    await t.run();
    expect(t.api.callsOf('getDay').map((c) => c.gameDate)).toEqual(['2026-10-19', '2026-10-18']);
    expect(t.api.callsOf('getAccountContext')[0]?.gameDate).toBe('2026-10-18');
  });

  it("never samples on the job's own date when the account already has a booking there", async () => {
    // 07:01 on 13 Oct: 20 Oct (the job's date) is the newest open day
    const t = setup({
      startMs: OPENS_AT_MS + 60_000,
      script: () => ({
        getDay: (day) => makeDay(day, day === GAME_DATE ? { own: [{ courtId: 10, startMinutes: 1170 }] } : {}),
      }),
    });
    expect((await t.run()).ok).toBe(true);
    expect(t.api.callsOf('getDay')[0]?.gameDate).toBe(GAME_DATE);
    expect(t.api.callsOf('getAccountContext').every((c) => c.gameDate !== GAME_DATE)).toBe(true);
    expect(t.api.callsOf('getAccountContext')[0]?.gameDate).toBe('2026-10-19');
  });

  it("the job's own date is fine as a sample when the account has no booking there", async () => {
    const t = setup({ startMs: OPENS_AT_MS + 60_000 });
    await t.run();
    expect(t.api.callsOf('getAccountContext')[0]?.gameDate).toBe(GAME_DATE);
  });

  it('skips days without a free slot on an allowed court, and slots shorter than the 60 minute minimum', async () => {
    const t = setup({
      script: () => ({
        getDay: (day) => {
          if (day === '2026-10-19') return makeDay(day, { taken: ALL_COURTS.flatMap((courtId) => [{ courtId, startMinutes: 1080 }, { courtId, startMinutes: 1170 }]) });
          if (day === '2026-10-18') return makeDay(day, { durationMinutes: 30 });
          return makeDay(day);
        },
      }),
    });
    await t.run();
    expect(t.api.callsOf('getAccountContext')[0]?.gameDate).toBe('2026-10-17');
  });

  it('a form that does not open for one day moves on to the previous day', async () => {
    const t = setup({
      script: () => ({
        getAccountContext: (sample) => {
          if (sample.gameDate === '2026-10-19') throw new Error('form not open');
          return ACCOUNT;
        },
      }),
    });
    expect((await t.run()).ok).toBe(true);
    expect(t.api.callsOf('getAccountContext').map((c) => c.gameDate)).toEqual(['2026-10-19', '2026-10-18']);
  });

  it('gives up after 7 days with reason other', async () => {
    const t = setup({
      script: () => ({
        getAccountContext: () => {
          throw new Error('form not open');
        },
      }),
    });
    expect(await t.run()).toMatchObject({ ok: false, reason: 'other' });
    expect(t.api.callsOf('getDay').map((c) => c.gameDate)).toEqual([
      '2026-10-19',
      '2026-10-18',
      '2026-10-17',
      '2026-10-16',
      '2026-10-15',
      '2026-10-14',
      '2026-10-13',
    ]);
  });

  it('the number of days is configurable and the search never goes before today', async () => {
    const few = setup({
      deps: { options: { sampleSearchDays: 2 } },
      script: () => ({ getAccountContext: () => { throw new Error('closed'); } }),
    });
    await few.run();
    expect(few.api.count('getDay')).toBe(2);

    const many = setup({ deps: { options: { sampleSearchDays: 30 } }, script: () => ({ getAccountContext: () => { throw new Error('closed'); } }) });
    await many.run();
    expect(many.api.callsOf('getDay').at(-1)?.gameDate).toBe('2026-10-13');
  });

  it('a calendar failure on one day moves on to the next', async () => {
    const t = setup({
      script: () => ({
        getDay: (day) => {
          if (day === '2026-10-19') throw new Error('timeout');
          return makeDay(day);
        },
      }),
    });
    expect((await t.run()).ok).toBe(true);
    expect(t.api.callsOf('getAccountContext')[0]?.gameDate).toBe('2026-10-18');
  });

  it('weekend days allow every court (the academy rule only applies on weekdays)', async () => {
    const t = setup({
      startMs: DateTime.fromISO('2026-10-17T10:00:00', { zone: 'Europe/Madrid' }).toMillis(),
      script: () => ({ getDay: (day) => makeDay(day, { courts: ALL_COURTS }) }),
      job: { gameDate: date('2026-10-24'), opensAtMs: OPENS_AT_MS + 4 * 86_400_000 },
    });
    await t.run();
    // 17 Oct 10:00 -> newest open day is 24 Oct (Saturday): court 1 is allowed there
    expect(t.api.callsOf('getAccountContext')[0]).toMatchObject({ gameDate: '2026-10-24', courtId: 1 });
  });

  it('a holiday counts like a weekend', async () => {
    const t = setup({
      startMs: DateTime.fromISO('2026-12-01T10:00:00', { zone: 'Europe/Madrid' }).toMillis(),
      deps: { holidays: new Set([date('2026-12-08')]) },
      script: () => ({ getDay: (day) => makeDay(day, { courts: ALL_COURTS }) }),
      job: { gameDate: date('2026-12-08'), opensAtMs: DateTime.fromISO('2026-12-01T07:00:00', { zone: 'Europe/Madrid' }).toMillis() },
    });
    await t.run();
    expect(t.api.callsOf('getAccountContext')[0]).toMatchObject({ gameDate: '2026-12-08', courtId: 1 });
  });

  it('follows the club time zone across the end of summer time (25 Oct 2026, window opens 07:00 CET = 06:00Z)', async () => {
    const before = setup({ startMs: Date.UTC(2026, 9, 25, 5, 59, 59) });
    await before.run();
    expect(before.api.callsOf('getDay')[0]?.gameDate).toBe('2026-10-31');

    const after = setup({ startMs: Date.UTC(2026, 9, 25, 6, 0, 0) });
    await after.run();
    expect(after.api.callsOf('getDay')[0]?.gameDate).toBe('2026-11-01');
  });
});

describe('preflight: funds', () => {
  const wallet = (balanceCents: number): ApiScript => ({ getWallet: () => ({ balanceCents }) });

  it('too little money -> no_funds with the amounts, and the account is still returned', async () => {
    const t = setup({ script: () => wallet(500) });
    const result = await t.run();
    expect(result).toMatchObject({ ok: false, reason: 'no_funds', detail: 'need 19.02 EUR, wallet has 5.00 EUR', account: ACCOUNT, requiredCents: 1902 });
    expect(t.api.count('probeForm')).toBe(0);
  });

  it('exactly enough money passes', async () => {
    const t = setup({ script: () => wallet(1902) });
    expect((await t.run()).ok).toBe(true);
  });

  it('the price comes from the site when it can quote', async () => {
    const t = setup({ script: () => ({ ...wallet(2000), quote: () => ({ totalCents: 2500, walletPayable: false }) }) });
    expect(await t.run()).toMatchObject({ ok: false, reason: 'no_funds', detail: 'need 25.00 EUR, wallet has 20.00 EUR', requiredCents: 2500 });
  });

  it.each([
    ['cannot quote (throws)', () => { throw new Error('window closed'); }],
    ['quote without a total', () => ({ totalCents: null, walletPayable: false })],
  ])('when the site %s the estimate is used (and says so)', async (_label, quote) => {
    const t = setup({ script: () => ({ ...wallet(1000), quote }) });
    const result = await t.run();
    expect(result).toMatchObject({ ok: false, reason: 'no_funds', detail: 'need 19.02 EUR (estimate), wallet has 10.00 EUR', requiredCents: 1902 });
  });

  it('an unquotable price with enough money passes even though the site says the wallet is not selectable yet', async () => {
    const t = setup({ script: () => ({ ...wallet(5000), quote: () => ({ totalCents: null, walletPayable: false }) }) });
    expect(await t.run()).toMatchObject({ ok: true, quoteCents: null, requiredCents: 1902 });
  });

  it('the estimate is configurable', async () => {
    const t = setup({
      script: () => ({ ...wallet(2000), quote: () => ({ totalCents: null, walletPayable: false }) }),
      deps: { estimatedCostCents: 3000 },
    });
    expect(await t.run()).toMatchObject({ ok: false, reason: 'no_funds', requiredCents: 3000 });
  });

  it('a quoted price with money in the wallet but the wallet option disabled is no_funds', async () => {
    const t = setup({ script: () => ({ ...wallet(5000), quote: () => ({ totalCents: 1902, walletPayable: false }) }) });
    expect(await t.run()).toMatchObject({ ok: false, reason: 'no_funds' });
  });

  it('a card job does not need money in the wallet', async () => {
    const t = setup({ script: () => wallet(0), job: { payment: 'card' } });
    expect((await t.run()).ok).toBe(true);
  });

  it('a dead session while reading the wallet is reason auth', async () => {
    const t = setup({ script: () => ({ getWallet: () => { throw new AuthExpiredError(); } }) });
    expect(await t.run()).toMatchObject({ ok: false, reason: 'auth', account: ACCOUNT });
  });

  it('a dead session while quoting the price is reason auth too (the quote fallback must not swallow it)', async () => {
    const t = setup({ script: () => ({ quote: () => { throw new AuthExpiredError(); } }) });
    expect(await t.run()).toMatchObject({ ok: false, reason: 'auth', account: ACCOUNT });
    expect(t.api.count('probeForm')).toBe(0);
  });

  describe('the estimate (the site only quotes a slot whose window is open)', () => {
    const unquotable = (): never => {
      throw new Error('window closed');
    };

    it.each([
      [60, 1268],
      [90, 1902],
      [120, 2536],
      [180, 3804],
    ])('a %s minute job is estimated at %s cents, and the result says it is only a guess', async (durationMinutes, cents) => {
      const t = setup({ job: { durationMinutes }, script: () => ({ ...wallet(10_000), quote: unquotable }) });
      expect(await t.run()).toMatchObject({ ok: true, requiredCents: cents, requiredIsEstimate: true, quoteCents: null });
    });

    it('a wallet that covers 60 minutes but not 90 is fine for the short job and short for the long one', async () => {
      const short = setup({ job: { durationMinutes: 60 }, script: () => ({ ...wallet(1500), quote: unquotable }) });
      expect((await short.run()).ok).toBe(true);

      const normal = setup({ job: { durationMinutes: 90 }, script: () => ({ ...wallet(1500), quote: unquotable }) });
      expect(await normal.run()).toMatchObject({ ok: false, reason: 'no_funds', detail: 'need 19.02 EUR (estimate), wallet has 15.00 EUR' });
    });

    it('a long job is warned about early: the shortage shows at the time of the preflight, not at the window', async () => {
      const t = setup({ job: { durationMinutes: 180 }, script: () => ({ ...wallet(3000), quote: unquotable }) });
      expect(await t.run()).toMatchObject({
        ok: false,
        reason: 'no_funds',
        detail: 'need 38.04 EUR (estimate), wallet has 30.00 EUR',
        requiredCents: 3804,
        requiredIsEstimate: true,
      });
    });

    it('the configured estimate is the 90 minute price and is scaled as well', async () => {
      const t = setup({ job: { durationMinutes: 60 }, deps: { estimatedCostCents: 3000 }, script: () => ({ ...wallet(1000), quote: unquotable }) });
      expect(await t.run()).toMatchObject({ ok: false, requiredCents: 2000, requiredIsEstimate: true });
    });

    it('a price named by the site is exact, never scaled, and flagged as such', async () => {
      const ok = setup({ job: { durationMinutes: 60 }, script: () => ({ ...wallet(10_000), quote: () => ({ totalCents: 1300, walletPayable: true }) }) });
      expect(await ok.run()).toMatchObject({ ok: true, requiredCents: 1300, requiredIsEstimate: false, quoteCents: 1300 });

      const short = setup({ script: () => ({ ...wallet(500) }) });
      expect(await short.run()).toMatchObject({ ok: false, reason: 'no_funds', requiredCents: 1902, requiredIsEstimate: false });
    });
  });
});

describe('preflight: clock calibration and the closed form', () => {
  it('probes the closed target form five times and feeds every server reading to the clock', async () => {
    const t = setup();
    t.api.latencyMs = { probeForm: 400 };
    const result = await t.run();
    expect(t.clock.observations).toHaveLength(5);
    for (const observation of t.clock.observations) {
      expect(observation.serverTimeMs % 1000).toBe(0);
      expect(observation.roundTripMs).toBe(400);
      expect(observation.receivedAtLocalMs).toBeGreaterThan(observation.serverTimeMs - 1);
    }
    expect(result).toMatchObject({ ok: true, clock: { observations: 5, absurd: 0 } });
  });

  it('works without a calibrator: one probe, no clock report', async () => {
    const t = setup({ deps: { calibration: undefined } });
    const result = await t.run();
    expect(t.api.count('probeForm')).toBe(1);
    expect(result).toMatchObject({ ok: true, clock: null });
  });

  it('absurd server readings are reported, not applied', async () => {
    const absurd: ClockCalibration = {
      localNowMs: () => 0,
      offsetMs: () => 0,
      observeServerTime: () => ({ accepted: false, absurd: true, sampleOffsetMs: 7_200_000, offsetMs: 0, sampleCount: 0 }),
    };
    const t = setup({ deps: { calibration: absurd } });
    expect(await t.run()).toMatchObject({ ok: true, clock: { observations: 0, absurd: 5, offsetMs: 0 } });
    expect(t.logger.entries.some((e) => e.level === 'warn' && e.msg.includes('absurd'))).toBe(true);
  });

  it('a closed page without a clock reading is simply not used for calibration', async () => {
    const t = setup({ script: () => ({ probeForm: () => ({ kind: 'window_closed', serverCheckTime: null }) }) });
    expect(await t.run()).toMatchObject({ ok: true, clock: { observations: 0 } });
  });

  it('end to end the calibration moves a PC clock that is 30 s slow onto the server time', async () => {
    const logger = new RecordingLogger();
    const slow = new FakeClock(OPENS_AT_MS - 630_000, { skewMs: 30_000, applyObservations: true });
    const api = new FakeApi(slow, { probeForm: gateAt(slow, OPENS_AT_MS) });
    const result = await runPreflight(makeJob({ state: 'warming' }), {
      api,
      clock: slow,
      calibration: slow,
      holidays: NO_HOLIDAYS,
      logger,
    });
    expect(result.ok).toBe(true);
    expect(Math.abs(slow.nowMs() - slow.serverNowMs())).toBeLessThanOrEqual(500);
  });

  it('a window that is already open needs no calibration: the first probe ends it', async () => {
    const t = setup({ startMs: OPENS_AT_MS + 3_600_000 });
    const result = await t.run();
    expect(t.api.count('probeForm')).toBe(1);
    expect(result).toMatchObject({ ok: true, clock: { observations: 0 } });
  });

  it('the account already has a booking on the job date -> daily_limit (the job can never succeed)', async () => {
    const t = setup({ startMs: OPENS_AT_MS + 60_000, script: () => ({ probeForm: () => ({ kind: 'daily_limit' }) }) });
    expect(await t.run()).toMatchObject({ ok: false, reason: 'daily_limit', account: ACCOUNT });
  });

  it('a login page instead of the form -> auth', async () => {
    const t = setup({ script: () => ({ probeForm: () => ({ kind: 'login_required' }) }) });
    expect(await t.run()).toMatchObject({ ok: false, reason: 'auth' });
  });

  it('a page nobody understands -> window_unknown (the account is kept so the job can still fire)', async () => {
    const t = setup({ script: () => ({ probeForm: () => ({ kind: 'unknown' }) }) });
    expect(await t.run()).toMatchObject({ ok: false, reason: 'window_unknown', account: ACCOUNT });
  });

  it('the server refusing the duration -> other', async () => {
    const t = setup({ script: () => ({ probeForm: () => ({ kind: 'too_short' }) }) });
    expect(await t.run()).toMatchObject({ ok: false, reason: 'other' });
  });

  it('an unexpected exception is reason other, carries only its name, and keeps the account', async () => {
    const t = setup({ script: (clock) => ({ probeForm: () => { void clock; throw new Error(`secret ${FAKE_HASH}`); } }) });
    const result = await t.run();
    expect(result).toMatchObject({ ok: false, reason: 'other', detail: 'Error', account: ACCOUNT });
    expect(result.ok ? '' : result.detail).not.toContain(FAKE_HASH);
    expect(t.logger.dump()).not.toContain(FAKE_HASH);
  });
});

