import { describe, expect, it } from 'vitest';
import { AuthExpiredError, UnexpectedResponseError } from '../../src/reservaplay/errors.js';
import { MAX_SLEEP_CHUNK_MS } from '../../src/sniper/clock.js';
import { FAKE_HASH, GATE_HASH, CHOICE_A, OPENS_AT_MS, closedGate, expectPacing, openGate } from './_fakes.js';
import { setupFire } from './_fireHarness.js';

describe('firing: the gate loop', () => {
  it('waits for the lead, polls the closed form, sends exactly ONE booking the moment the form opens', async () => {
    const t = setupFire();
    const result = await t.run();

    expect(result).toEqual({ kind: 'booked', reservationId: 100_002, choice: CHOICE_A });
    const probes = t.api.callsOf('probeForm');
    expect(probes[0]?.serverMs).toBe(OPENS_AT_MS - 3000);
    expect(t.api.count('book')).toBe(1);
    const book = t.api.callsOf('book')[0];
    expect(book?.serverMs).toBeGreaterThanOrEqual(OPENS_AT_MS);
    expect(book?.serverMs).toBeLessThanOrEqual(OPENS_AT_MS + 250);
    expect(probes.filter((p) => p.serverMs < OPENS_AT_MS).length).toBeGreaterThanOrEqual(10);

    expect(t.stored()).toMatchObject({ state: 'booked', reservationId: 100_002, bookedChoice: CHOICE_A, attempts: 1 });
    expect(t.sink.kinds()).toEqual(['window_open', 'booked']);
    expect(t.sink.ofKind('booked')[0]).toMatchObject({ reservationId: 100_002, choice: CHOICE_A });
  });

  it('stores the booking BEFORE the event is emitted', async () => {
    const t = setupFire();
    await t.run();
    expect(t.emitStates).toEqual(['firing', 'booked']);
  });

  it('never probes earlier than the lead before the opening (default 3 s, configurable)', async () => {
    const early = setupFire({ startOffsetMs: -600_000 });
    await early.run();
    expect(early.api.calls[0]?.serverMs).toBe(OPENS_AT_MS - 3000);

    const configured = setupFire({ startOffsetMs: -600_000, deps: { options: { leadMs: 500 } } });
    await configured.run();
    expect(configured.api.calls[0]?.serverMs).toBe(OPENS_AT_MS - 500);
  });

  it('while waiting for the lead it makes no request at all', async () => {
    const t = setupFire({ startOffsetMs: -60_000 });
    await t.run();
    const beforeLead = t.api.calls.filter((call) => call.serverMs < OPENS_AT_MS - 3000);
    expect(beforeLead).toEqual([]);
  });

  it('spaces requests by at least 250 ms and never exceeds 4 requests per second', async () => {
    const t = setupFire();
    await t.run();
    expect(t.api.calls.length).toBeGreaterThan(10);
    expectPacing(t.api.calls);
  });

  it('the booking request is NOT held back by the pacing: it goes out in the same instant as the opening probe', async () => {
    const t = setupFire();
    await t.run();
    const probe = t.api.callsOf('probeForm').at(-1);
    const book = t.api.callsOf('book')[0];
    expect(book?.monoMs).toBe(probe?.monoMs);
  });

  it('spaces requests the same way when every probe takes 600 ms (one request in flight, no overlap)', async () => {
    const t = setupFire({ latency: { probeForm: 600 } });
    await t.run();
    expect(t.api.maxActive).toBe(1);
    expectPacing(t.api.calls);
  });

  it('refuses a minimum gap below 250 ms', async () => {
    const t = setupFire({ deps: { options: { minRequestGapMs: 100 } } });
    await expect(t.run()).rejects.toThrow(RangeError);
    expect(t.api.calls).toEqual([]);
  });

  it('never sleeps longer than one second in one call', async () => {
    const t = setupFire({ startOffsetMs: -1_800_000 });
    await t.run();
    expect(t.clock.maxSleepMs()).toBeLessThanOrEqual(MAX_SLEEP_CHUNK_MS);
    expect(t.clock.sleeps.length).toBeGreaterThan(1700);
  });

  it('uses the FRESH hash of the open gate for the booking, and the account id from preflight', async () => {
    const t = setupFire({ script: () => ({ probeForm: () => openGate(GATE_HASH) }) });
    await t.run();
    const request = t.api.bookRequests[0];
    expect(request?.account).toEqual({ accountId: 12345, hash: GATE_HASH });
    expect(request?.account.hash).not.toBe(FAKE_HASH);
    expect(request).toMatchObject({
      payment: 'wallet',
      slot: { gameDate: '2026-10-20', courtId: 9, startMinutes: 1080, durationMinutes: 90 },
    });
  });

  it('gives up when the window does not open within 90 s of the opening time', async () => {
    const t = setupFire({ script: (clock) => ({ probeForm: () => closedGate(clock) }) });
    const result = await t.run();
    expect(result).toEqual({ kind: 'failed', reason: 'window_timeout' });
    expect(t.api.count('book')).toBe(0);
    expect(t.clock.serverNowMs()).toBeGreaterThan(OPENS_AT_MS + 90_000);
    expect(t.clock.serverNowMs()).toBeLessThan(OPENS_AT_MS + 91_000);
    expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'window_timeout' });
    expect(t.sink.kinds()).toEqual(['failed']);
  });

  it('the time limit is configurable', async () => {
    const t = setupFire({
      script: (clock) => ({ probeForm: () => closedGate(clock) }),
      deps: { options: { windowLimitMs: 10_000 } },
    });
    await t.run();
    expect(t.clock.serverNowMs()).toBeLessThan(OPENS_AT_MS + 11_000);
    expect(t.stored().failureReason).toBe('window_timeout');
  });

  describe('a job picked up after the window opened ("book now")', () => {
    it('fires immediately: first probe at once, no waiting, booking right away', async () => {
      const t = setupFire({ startOffsetMs: 5 * 3_600_000 });
      const startedAt = t.clock.nowMs();
      const result = await t.run();
      expect(result.kind).toBe('booked');
      expect(t.api.calls[0]?.atMs).toBe(startedAt);
      expect(t.api.calls.map((c) => c.name)).toEqual(['probeForm', 'book']);
      expect(t.clock.sleeps).toEqual([]);
    });

    it('gets its own 90 s budget counted from the start of firing, not from the long-gone opening time', async () => {
      const t = setupFire({
        startOffsetMs: 5 * 3_600_000,
        script: (clock) => ({ probeForm: () => closedGate(clock) }),
      });
      const startedAt = t.clock.nowMs();
      const result = await t.run();
      expect(result).toEqual({ kind: 'failed', reason: 'window_timeout' });
      expect(t.api.count('probeForm')).toBeGreaterThan(300);
      expect(t.clock.nowMs() - startedAt).toBeGreaterThan(90_000);
      expect(t.clock.nowMs() - startedAt).toBeLessThan(91_000);
    });

    it('also works when the window opened a few seconds ago', async () => {
      const t = setupFire({ startOffsetMs: 7000 });
      expect((await t.run()).kind).toBe('booked');
      expect(t.api.count('probeForm')).toBe(1);
    });
  });

  it('tolerates a few failed probes (network) and carries on polling', async () => {
    let calls = 0;
    const t = setupFire({
      script: (clock) => ({
        probeForm: () => {
          calls++;
          if (calls === 3 || calls === 4) throw new Error('socket hang up');
          return clock.serverNowMs() >= OPENS_AT_MS ? openGate() : closedGate(clock);
        },
      }),
    });
    expect((await t.run()).kind).toBe('booked');
    expect(t.logger.count('warn')).toBeGreaterThanOrEqual(2);
  });

  describe('probe failures (5xx, resets, timeouts) around the opening', () => {
    const serverDown = (status: number): Error => new UnexpectedResponseError(`HTTP ${String(status)}`, status);

    it('a burst of 503s lasting several seconds at the opening instant is survived: the booking still goes out', async () => {
      const t = setupFire({
        script: (clock) => ({
          probeForm: () => {
            const sinceOpening = clock.serverNowMs() - OPENS_AT_MS;
            if (sinceOpening >= 0 && sinceOpening < 6000) throw serverDown(503);
            return sinceOpening >= 6000 ? openGate() : closedGate(clock);
          },
        }),
      });
      expect(await t.run()).toEqual({ kind: 'booked', reservationId: 100_002, choice: CHOICE_A });
      expect(t.api.count('book')).toBe(1);
      expect(t.api.callsOf('book')[0]?.serverMs).toBeGreaterThanOrEqual(OPENS_AT_MS + 6000);
      expect(t.logger.count('warn')).toBeGreaterThanOrEqual(5);
    });

    it('errors that start before the opening (from the first probe at T-3 s) do not kill the job either', async () => {
      const t = setupFire({
        script: (clock) => ({
          probeForm: () => {
            if (clock.serverNowMs() < OPENS_AT_MS + 1000) throw serverDown(502);
            return openGate();
          },
        }),
      });
      expect((await t.run()).kind).toBe('booked');
      expect(t.api.count('probeForm')).toBeGreaterThan(5);
    });

    it('pauses after a failed probe, so a broken site is probed at most about once per second (never faster than 4 per second)', async () => {
      const t = setupFire({
        script: (clock) => ({
          probeForm: () => {
            if (clock.serverNowMs() < OPENS_AT_MS + 5000) throw serverDown(500);
            return openGate();
          },
        }),
      });
      await t.run();
      expectPacing(t.api.calls);
      const probes = t.api.callsOf('probeForm').map((call) => call.monoMs);
      const failing = probes.filter((_, i) => i > 0 && (probes[i] ?? 0) - (probes[i - 1] ?? 0) >= 750);
      expect(failing.length).toBeGreaterThanOrEqual(5);
      expect(t.api.maxActive).toBe(1);
    });

    it('fails only after 20 s without a single successful probe, and says probe_failed (nothing is sent)', async () => {
      const t = setupFire({ script: () => ({ probeForm: () => { throw serverDown(503); } }) });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'probe_failed' });
      const probes = t.api.callsOf('probeForm');
      const firstFailureAt = probes[0]?.monoMs ?? 0;
      const lastAt = probes.at(-1)?.monoMs ?? 0;
      expect(lastAt - firstFailureAt).toBeGreaterThan(20_000);
      expect(lastAt - firstFailureAt).toBeLessThan(22_000);
      expect(probes.length).toBeGreaterThan(20);
      expect(probes.length).toBeLessThan(40);
      expectPacing(t.api.calls);
      expect(t.api.count('book')).toBe(0);
      expect(t.stored()).toMatchObject({ state: 'failed', failureReason: 'probe_failed' });
    });

    it('the outage limit is configurable', async () => {
      const t = setupFire({
        deps: { options: { maxProbeOutageMs: 3000, probeErrorBackoffMs: 500 } },
        script: () => ({ probeForm: () => { throw new Error('socket hang up'); } }),
      });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'probe_failed' });
      const probes = t.api.callsOf('probeForm');
      expect((probes.at(-1)?.monoMs ?? 0) - (probes[0]?.monoMs ?? 0)).toBeLessThan(4500);
    });

    it('slow failures count by elapsed time, not by number: two 12 s timeouts in a row are already too long', async () => {
      const t = setupFire({
        latency: { probeForm: 12_000 },
        script: () => ({ probeForm: () => { throw new Error('timeout'); } }),
      });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'probe_failed' });
      expect(t.api.count('probeForm')).toBe(2);
    });

    it('a successful probe (even a closed one) restarts the clock of the outage', async () => {
      const t = setupFire({
        script: (clock) => ({
          probeForm: () => {
            const sinceOpening = clock.serverNowMs() - OPENS_AT_MS;
            const failing = (sinceOpening >= -3000 && sinceOpening < 12_000) || (sinceOpening >= 13_000 && sinceOpening < 28_000);
            if (failing) throw serverDown(503);
            return sinceOpening >= 28_000 ? openGate() : closedGate(clock);
          },
        }),
      });
      expect(await t.run()).toMatchObject({ kind: 'booked' });
      expect(t.api.callsOf('book')[0]?.serverMs).toBeGreaterThanOrEqual(OPENS_AT_MS + 28_000);
    });

    it('an expired session on a probe is an answer from the site, not an outage', async () => {
      const t = setupFire({
        script: (clock) => ({
          probeForm: (_slot, nth) => {
            if (nth < 60) throw new AuthExpiredError();
            return clock.serverNowMs() >= OPENS_AT_MS ? openGate() : closedGate(clock);
          },
        }),
        deps: { options: { maxRelogins: 100 } },
      });
      expect((await t.run()).kind).toBe('booked');
      expect(t.api.count('login')).toBe(60);
    });

    it('the window deadline still ends a long outage first when it comes earlier', async () => {
      const t = setupFire({
        startOffsetMs: 0,
        deps: { options: { windowLimitMs: 5000 } },
        script: () => ({ probeForm: () => { throw serverDown(503); } }),
      });
      expect(await t.run()).toEqual({ kind: 'failed', reason: 'window_timeout' });
    });
  });
});
