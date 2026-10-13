import type { Job } from '../contracts.js';
import { createEventQueue, flushWithin } from './events.js';
import { runFiring } from './fire.js';
import { resolveFireOptions } from './fireTypes.js';
import { isGameDatePassed } from './gameDay.js';
import {
  resolveRunnerOptions,
  type RunnerContext,
  type SniperRunnerDeps,
  type WarmState,
} from './runnerContext.js';
import { expireJob, failPending, keepSessionAlive, preflightStep, warmStateFor } from './runnerWarm.js';
import { describeError } from './types.js';

export type { RunnerOptions, SniperRunnerDeps } from './runnerContext.js';

export interface SniperRunner {
  /** Starts the 1 s tick loop. Run `recoverJobs` first. */
  start(): void;
  /** Stops ticking, interrupts a firing run (its job stays `firing` for recovery) and drains pending events. */
  stop(): Promise<void>;
  /** One pass over the due jobs; the loop calls this every second. */
  tick(): Promise<void>;
  /** Resolves when every emitted event has been handed to the sink. */
  flushEvents(): Promise<void>;
}

const SHUTDOWN_FLUSH_TIMEOUT_MS = 5000;

const byOpeningTime = (a: Job, b: Job): number => a.opensAtMs - b.opensAtMs || a.id - b.id;

/** scheduled -> warming. Null when the job was refused or someone else moved it. */
const pickUp = (ctx: RunnerContext, job: Job): Job | null => {
  const { deps } = ctx;
  if (job.payment === 'card' && deps.allowCardPayment !== true) {
    failPending(ctx, job, 'card_payment_disabled');
    return null;
  }
  const warming = deps.store.transition(job.id, 'scheduled', 'warming', deps.clock.nowMs());
  if (warming === undefined) return null;
  ctx.logger.info({ jobId: warming.id, opensAtMs: warming.opensAtMs }, 'job picked up');
  ctx.events.emit({ kind: 'armed', job: warming });
  return warming;
};

/**
 * The wallet may have been topped up since the last check: one last look before giving up on a no_funds job. Only a
 * price the site itself named can end the job: a guess never keeps it from firing, the site's answer decides (an
 * answer nobody understands stops the job safely, and a refused booking costs nothing).
 */
const fundsStillMissing = async (ctx: RunnerContext, warm: WarmState): Promise<boolean> => {
  if (warm.requiredCents === null || warm.requiredIsEstimate) {
    ctx.logger.info({}, 'the shortage rests on an estimate, not on a quoted price; firing anyway');
    return false;
  }
  try {
    const wallet = await ctx.deps.api.getWallet();
    return wallet.balanceCents < warm.requiredCents;
  } catch (error) {
    ctx.logger.warn(describeError(error), 'final wallet check failed; firing anyway');
    return false;
  }
};

const fireJob = async (ctx: RunnerContext, job: Job): Promise<void> => {
  const { deps } = ctx;
  const warm = warmStateFor(ctx, job);
  if (warm.account === null) {
    failPending(ctx, job, warm.failure ?? 'other');
    return;
  }
  if (warm.failure === 'no_funds' && (await fundsStillMissing(ctx, warm))) {
    failPending(ctx, job, 'no_funds');
    return;
  }
  const firing = deps.store.transition(job.id, 'warming', 'firing', deps.clock.nowMs());
  ctx.warms.delete(job.id);
  if (firing === undefined) return;
  const result = await runFiring(firing, {
    api: deps.api,
    clock: deps.clock,
    store: deps.store,
    events: ctx.events,
    holidays: deps.holidays,
    logger: ctx.logger,
    account: warm.account,
    signal: ctx.abort.signal,
    options: ctx.opts.fire,
    ...(deps.allowCardPayment === undefined ? {} : { allowCardPayment: deps.allowCardPayment }),
  });
  ctx.lastSessionActivityAtMs = deps.clock.nowMs();
  ctx.logger.info({ jobId: job.id, result: result.kind }, 'firing finished');
};

const processJob = async (ctx: RunnerContext, listed: Job): Promise<void> => {
  const { deps, opts } = ctx;
  let job = deps.store.get(listed.id);
  if (job === undefined || (job.state !== 'scheduled' && job.state !== 'warming')) return;
  const now = deps.clock.nowMs();
  if (isGameDatePassed(job.gameDate, now)) return expireJob(ctx, job);

  const fireAtMs = job.opensAtMs - ctx.fireLeadMs;
  if (deps.store.isStopped()) {
    if (now >= fireAtMs) failPending(ctx, job, 'stopped');
    return;
  }

  if (job.state === 'scheduled') {
    if (now < job.opensAtMs - opts.warmupLeadMs) return;
    const warming = pickUp(ctx, job);
    if (warming === null) return;
    job = warming;
  }

  const warm = warmStateFor(ctx, job);
  // A recheck or keep-alive started now would delay the first probe past the opening; fire() copes with a dead session.
  const quiet = warm.account !== null && deps.clock.nowMs() >= fireAtMs - opts.fireQuietMs;
  if (!quiet) {
    if (!warm.ready) {
      const lastChance = warm.account === null && !warm.finalPreflightStarted && deps.clock.nowMs() >= fireAtMs - opts.finalPreflightLeadMs;
      if (lastChance) warm.finalPreflightStarted = true;
      if ((lastChance || deps.clock.nowMs() >= warm.nextPreflightAtMs) && !(await preflightStep(ctx, job, warm))) return;
    } else {
      await keepSessionAlive(ctx, job, warm);
    }
  }
  if (deps.clock.nowMs() >= fireAtMs) await fireJob(ctx, job);
};

export const createSniperRunner = (deps: SniperRunnerDeps): SniperRunner => {
  const opts = resolveRunnerOptions(deps.options);
  const fireLeadMs = resolveFireOptions(opts.fire).leadMs;
  const ctx: RunnerContext = {
    deps,
    opts,
    events: createEventQueue(deps.events, deps.logger),
    warms: new Map(),
    logger: deps.logger,
    fireLeadMs,
    abort: new AbortController(),
    sessionReady: false,
    lastSessionActivityAtMs: deps.clock.nowMs(),
  };
  let ticking = false;
  let stopping = false;
  let loop: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      const jobs = [...deps.store.list({ states: ['scheduled', 'warming'] })].sort(byOpeningTime);
      for (const job of jobs) {
        if (ctx.abort.signal.aborted) return;
        try {
          await processJob(ctx, job);
        } catch (error) {
          ctx.logger.error({ jobId: job.id, ...describeError(error) }, 'processing a job failed');
        }
      }
    } catch (error) {
      ctx.logger.error(describeError(error), 'tick failed');
    } finally {
      ticking = false;
    }
  };

  const run = async (): Promise<void> => {
    while (!stopping) {
      await tick();
      if (stopping) return;
      await deps.clock.sleep(opts.tickMs);
    }
  };

  return {
    start: () => {
      if (loop !== null) return;
      stopping = false;
      ctx.abort = new AbortController();
      loop = run();
    },
    stop: async () => {
      stopping = true;
      ctx.abort.abort();
      const running = loop;
      loop = null;
      if (running !== null) await running;
      await flushWithin(ctx.events, SHUTDOWN_FLUSH_TIMEOUT_MS);
    },
    tick,
    flushEvents: () => ctx.events.flush(),
  };
};
