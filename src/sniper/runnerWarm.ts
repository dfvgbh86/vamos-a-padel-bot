import type { Job, PreflightFailure } from '../contracts.js';
import { MAX_CLOCK_OFFSET_MS } from './clock.js';
import { runPreflight, type PreflightResult } from './preflight.js';
import { newWarmState, type RunnerContext, type WarmState } from './runnerContext.js';
import { describeError } from './types.js';

export const warmStateFor = (ctx: RunnerContext, job: Job): WarmState => {
  const existing = ctx.warms.get(job.id);
  if (existing !== undefined) return existing;
  const created = newWarmState(ctx.deps.clock.nowMs());
  ctx.warms.set(job.id, created);
  return created;
};

/** Terminal failure of a job that has not started firing (scheduled or warming). */
export const failPending = (ctx: RunnerContext, job: Job, reason: string): void => {
  const updated = ctx.deps.store.transition(job.id, ['scheduled', 'warming'], 'failed', ctx.deps.clock.nowMs(), {
    failureReason: reason,
  });
  ctx.warms.delete(job.id);
  if (updated === undefined) return;
  ctx.logger.warn({ jobId: job.id, reason }, 'job failed before firing');
  ctx.events.emit({ kind: 'failed', job: updated, reason });
};

export const expireJob = (ctx: RunnerContext, job: Job): void => {
  const updated = ctx.deps.store.transition(job.id, ['scheduled', 'warming'], 'expired', ctx.deps.clock.nowMs(), {
    failureReason: 'game_date_passed',
  });
  ctx.warms.delete(job.id);
  if (updated === undefined) return;
  ctx.logger.info({ jobId: job.id }, 'job expired: the game date has passed');
  ctx.events.emit({ kind: 'expired', job: updated });
};

const announceFailure = (ctx: RunnerContext, job: Job, warm: WarmState, reason: PreflightFailure, detail: string): void => {
  if (warm.announced === reason) return;
  warm.announced = reason;
  ctx.events.emit({ kind: 'preflight_failed', job, reason, detail });
};

/** Every reading of the site clock was beyond the sanity limit: firing would go by a PC clock that is badly wrong. */
const CLOCK_DETAIL =
  `wallet and session are fine, but the server clock differs from the PC clock by more than ${String(MAX_CLOCK_OFFSET_MS / 60_000)} minutes: ` +
  'check the PC date and time (the bot fires by the PC clock)';

const announceReady = (ctx: RunnerContext, job: Job, warm: WarmState, result: Extract<PreflightResult, { ok: true }>): void => {
  const clock = result.clock;
  if (clock !== null && clock.absurd > 0 && clock.observations === 0) {
    if (warm.clockWarned) return;
    warm.clockWarned = true;
    warm.announced = 'other';
    ctx.events.emit({ kind: 'preflight_failed', job, reason: 'other', detail: CLOCK_DETAIL });
    return;
  }
  if (warm.announced === 'ok') return;
  warm.announced = 'ok';
  ctx.events.emit({ kind: 'preflight_ok', job, walletCents: result.walletCents, quoteCents: result.quoteCents });
};

/**
 * One preflight run and its consequences. Returns false when the job was failed for good (a booking on that day
 * already exists). no_funds / window_unknown / other keep the job armed and are repeated every minute; a session
 * that cannot be established is retried until firing time, more slowly after a few failures (a site outage or a
 * throttled login looks like a rejected password and must not end the job minutes before the window).
 */
export const preflightStep = async (ctx: RunnerContext, job: Job, warm: WarmState): Promise<boolean> => {
  const { deps, opts } = ctx;
  const result = await runPreflight(job, {
    api: deps.api,
    clock: deps.clock,
    holidays: deps.holidays,
    logger: ctx.logger,
    reuseSession: ctx.sessionReady,
    estimatedCostCents: opts.estimatedCostCents,
    options: opts.preflight,
    ...(deps.calibration === undefined ? {} : { calibration: deps.calibration }),
  });
  const now = deps.clock.nowMs();

  if (result.ok) {
    ctx.sessionReady = true;
    ctx.lastSessionActivityAtMs = now;
    warm.account = result.account;
    warm.requiredCents = result.requiredCents;
    warm.requiredIsEstimate = result.requiredIsEstimate;
    warm.ready = true;
    warm.failure = null;
    warm.authAttempts = 0;
    announceReady(ctx, job, warm, result);
    return true;
  }

  ctx.sessionReady = result.reason !== 'auth';
  if (result.account !== undefined) warm.account = result.account;
  if (result.requiredCents !== undefined) {
    warm.requiredCents = result.requiredCents;
    warm.requiredIsEstimate = result.requiredIsEstimate ?? true;
  }
  warm.ready = false;
  warm.failure = result.reason;
  announceFailure(ctx, job, warm, result.reason, result.detail);

  if (result.reason === 'daily_limit') {
    failPending(ctx, job, 'daily_limit');
    return false;
  }
  if (result.reason === 'auth') {
    warm.authAttempts++;
    const slowdown = warm.authAttempts >= opts.authFastRetries ? 2 : 1;
    warm.nextPreflightAtMs = now + opts.authRetryEveryMs * slowdown;
    return true;
  }
  warm.nextPreflightAtMs = now + opts.recheckEveryMs;
  return true;
};

/**
 * Keeps the session warm: every few minutes and once more shortly before the window opens. A dead session is
 * re-established with ONE login; if that fails too, the next tick runs a full preflight again.
 */
export const keepSessionAlive = async (ctx: RunnerContext, job: Job, warm: WarmState): Promise<void> => {
  const { deps, opts } = ctx;
  const now = deps.clock.nowMs();
  const regularDue = now - ctx.lastSessionActivityAtMs >= opts.keepAliveEveryMs;
  const finalDue = !warm.finalSessionCheckDone && now >= job.opensAtMs - opts.sessionCheckLeadMs;
  if (!regularDue && !finalDue) return;
  if (finalDue) warm.finalSessionCheckDone = true;
  try {
    await deps.api.keepAlive();
    ctx.lastSessionActivityAtMs = deps.clock.nowMs();
    return;
  } catch (error) {
    ctx.logger.warn({ jobId: job.id, ...describeError(error) }, 'keep-alive failed; logging in again');
  }
  try {
    await deps.api.login();
    ctx.lastSessionActivityAtMs = deps.clock.nowMs();
  } catch (error) {
    ctx.logger.warn({ jobId: job.id, ...describeError(error) }, 're-login failed; preflight will be repeated');
    ctx.sessionReady = false;
    warm.ready = false;
    warm.failure = 'auth';
    warm.nextPreflightAtMs = deps.clock.nowMs() + opts.authRetryEveryMs;
    announceFailure(ctx, job, warm, 'auth', 'the session was lost and logging in again failed');
  }
};
