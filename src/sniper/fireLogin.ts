import { AuthExpiredError, LoginFailedError, UnexpectedResponseError } from '../reservaplay/errors.js';
import { TransportError } from '../reservaplay/http.js';
import { sleepFor } from './clock.js';
import type { FireContext } from './fireContext.js';
import { abortedResult, failJob } from './fireFinish.js';
import type { FireResult } from './fireTypes.js';
import { describeError } from './types.js';

export type LoginOutcome = 'ok' | 'failed' | 'aborted';

/**
 * At the opening the site is overloaded and a login is refused or times out like any other request. Credentials were
 * proven by preflight minutes earlier, so every failure the site or the network can cause is worth a short retry;
 * anything else (a bug) is not.
 */
const isRetryableLoginError = (error: unknown): boolean =>
  error instanceof LoginFailedError ||
  error instanceof TransportError ||
  error instanceof UnexpectedResponseError ||
  error instanceof AuthExpiredError;

/** Paced login with a bounded number of attempts, spaced by `loginRetryDelayMs`, never beyond the firing deadline. */
export const loginPersistently = async (ctx: FireContext): Promise<LoginOutcome> => {
  const { api, clock, logger, signal } = ctx.deps;
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted === true) return 'aborted';
    await ctx.pace();
    try {
      await api.login();
      return 'ok';
    } catch (error) {
      logger.warn({ jobId: ctx.job.id, attempt, ...describeError(error) }, 'login during firing failed');
      if (!isRetryableLoginError(error) || attempt >= ctx.opts.maxLoginAttempts) return 'failed';
      if (clock.nowMs() + ctx.opts.loginRetryDelayMs > ctx.deadlineMs) return 'failed';
      await sleepFor(clock, ctx.opts.loginRetryDelayMs);
    }
  }
};

/** Replaces a dead session. `maxRelogins` counts successful logins only; failed attempts are bounded separately. */
export const relogin = async (ctx: FireContext): Promise<FireResult | null> => {
  if (ctx.relogins >= ctx.opts.maxRelogins) return failJob(ctx, 'auth');
  const outcome = await loginPersistently(ctx);
  if (outcome === 'aborted') return abortedResult(ctx);
  if (outcome === 'failed') return failJob(ctx, 'auth');
  ctx.relogins++;
  ctx.openGate = null;
  return null;
};
