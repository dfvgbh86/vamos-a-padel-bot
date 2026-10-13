import type { Clock, JobStore, ReservaplayApi } from '../contracts.js';
import { AuthExpiredError } from '../reservaplay/errors.js';
import { describeError } from './errors.js';
import type { AppLogger } from './logger.js';

/** What the owner-facing services (job creation, /wallet, /status, the date picker) may ask of the site. */
export type OwnerApi = Pick<ReservaplayApi, 'getDay' | 'getWallet' | 'quote' | 'keepAlive'>;

/**
 * The sniper takes over the session this long before a window opens (its preflight starts 10 minutes ahead).
 * Within it, an owner request never logs in: a login wipes the shared cookie jar and would pull the session
 * out from under the sniper's requests.
 */
export const QUIET_BEFORE_OPEN_MS = 15 * 60_000;

export interface OwnerApiDeps {
  readonly api: ReservaplayApi;
  readonly store: JobStore;
  readonly clock: Clock;
  readonly logger: AppLogger;
  readonly quietBeforeOpenMs?: number;
}

/**
 * The sniper logs in only for a job that is about to fire, so without this the owner's requests (the date picker
 * of /new, the balance check when a job is created, /wallet, /status) would fail with "session expired" for most of
 * the day. A request that finds the session gone logs in ONCE and repeats, unless the sniper needs the session
 * right now. Owner requests run one at a time so that none overlaps a login.
 */
export const createOwnerApi = (deps: OwnerApiDeps): OwnerApi => {
  const { api, store, clock, logger } = deps;
  const quietMs = deps.quietBeforeOpenMs ?? QUIET_BEFORE_OPEN_MS;
  let tail: Promise<unknown> = Promise.resolve();

  const sniperNeedsSession = (): boolean => {
    try {
      const nowMs = clock.nowMs();
      return store
        .list({ states: ['scheduled', 'warming', 'firing'] })
        .some((job) => job.state !== 'scheduled' || job.opensAtMs - nowMs <= quietMs);
    } catch (error) {
      logger.warn(describeError(error), 'could not read the jobs; assuming the sniper needs the session');
      return true;
    }
  };

  const withSession = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof AuthExpiredError)) throw error;
      if (sniperNeedsSession()) {
        logger.info({}, 'session expired during the booking preparation: the owner request does not log in');
        throw error;
      }
      logger.info({}, 'session expired: logging in for an owner request');
      await api.login();
      return call();
    }
  };

  const serial = <T>(call: () => Promise<T>): Promise<T> => {
    const run = tail.then(() => withSession(call));
    tail = run.catch(() => undefined);
    return run;
  };

  return {
    getDay: (gameDate) => serial(() => api.getDay(gameDate)),
    getWallet: () => serial(() => api.getWallet()),
    quote: (slot, payment) => serial(() => api.quote(slot, payment)),
    keepAlive: () => serial(() => api.keepAlive()),
  };
};
