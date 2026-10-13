import type { Transformer } from 'grammy';
import type { Env } from './config/env.js';
import type { Clock, JobService, JobStore, ReservaplayApi } from './contracts.js';
import { createJobService } from './jobs/service.js';
import { openJobStore } from './jobs/store.js';
import { resolveDbLocation } from './runtime/dbPath.js';
import { describeError } from './runtime/errors.js';
import { createLogger, scoped, type AppLogger } from './runtime/logger.js';
import { createOwnerApi } from './runtime/ownerApi.js';
import { createSiteApi } from './runtime/site.js';
import { announcedStateOf, reannounceResults, type ResultLedger } from './sniper/announce.js';
import { createSystemClock, type ClockCalibration } from './sniper/clock.js';
import type { OpenRule } from './sniper/openTime.js';
import { recoverJobs, type RecoveryOptions } from './sniper/recovery.js';
import { createSniperRunner, type RunnerOptions, type SniperRunner } from './sniper/runner.js';
import { createTelegramBot } from './telegram/bot.js';
import type { JobNotifier, TelegramBotHandle } from './telegram/types.js';

export type AppClock = Clock & ClockCalibration;

/**
 * The job store plus the one thing shutdown needs from it. A store that also keeps the ledger of delivered results
 * (the SQLite one does) makes results survive a crash or a long Telegram outage; without it they are in-memory only.
 */
export type AppStore = JobStore & { close(): void } & Partial<ResultLedger>;

/** Everything a test may replace. Whatever is left out is built for real from the environment. */
export interface AppOverrides {
  readonly logger?: AppLogger;
  readonly clock?: AppClock;
  /** Replaces the whole ReservaPlay client. */
  readonly api?: ReservaplayApi;
  /** Keeps the real client but sends its requests through this function (fake site). */
  readonly fetchImpl?: typeof fetch;
  /** Used instead of opening DB_PATH. The app closes it on shutdown, like a store it opened itself. */
  readonly store?: AppStore;
  /** Installed on the Telegram API: a fake transport. */
  readonly telegramTransformer?: Transformer;
  readonly openRule?: OpenRule;
  readonly sniper?: Partial<RunnerOptions>;
  readonly recovery?: Partial<RecoveryOptions>;
  /** Real milliseconds shutdown waits for undelivered notifications (default 15 s). */
  readonly notificationDrainMs?: number;
  /** Called when Telegram long polling dies after startup; the sniper keeps running either way. */
  readonly onTelegramFatal?: (error: unknown) => void;
}

export interface App {
  readonly service: JobService;
  readonly store: JobStore;
  readonly runner: SniperRunner;
  readonly telegram: TelegramBotHandle;
  readonly clock: Clock;
  readonly logger: AppLogger;
  /** Order: recover jobs left over from the last run, start the sniper, then connect Telegram. */
  start(): Promise<void>;
  /** Order: Telegram, sniper, pending notifications, store. Safe to call twice. */
  stop(): Promise<void>;
}

/** Retries of an undelivered result are given this long to finish before the process goes away. */
const NOTIFICATION_DRAIN_MS = 15_000;

const drained = async (notifier: JobNotifier, ms: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((done) => {
    timer = setTimeout(() => done(false), ms);
  });
  try {
    return await Promise.race([notifier.idle().then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const ledgerOf = (store: AppStore): ResultLedger | null => {
  if (typeof store.unannouncedResults !== 'function' || typeof store.markAnnounced !== 'function') return null;
  return {
    unannouncedResults: (sinceMs) => store.unannouncedResults?.(sinceMs) ?? [],
    markAnnounced: (jobId, state) => store.markAnnounced?.(jobId, state),
  };
};

const assemble = (env: Env, overrides: AppOverrides, logger: AppLogger, clock: AppClock, store: AppStore): App => {
  const secrets = [env.telegramBotToken, env.password, env.username];
  const api = overrides.api ?? createSiteApi(env, clock, scoped(logger, 'reservaplay'), overrides.fetchImpl);
  const openRule = overrides.openRule === undefined ? {} : { openRule: overrides.openRule };
  const ledger = ledgerOf(store);

  const service = createJobService({
    store,
    api: createOwnerApi({ api, store, clock, logger: scoped(logger, 'owner') }),
    clock,
    holidays: env.holidays,
    logger: scoped(logger, 'jobs'),
    ...openRule,
  });

  const telegram = createTelegramBot({
    token: env.telegramBotToken,
    allowedUserIds: env.allowedUserIds,
    service,
    clock,
    logger: scoped(logger, 'telegram'),
    ...openRule,
    onDelivered: (event) => {
      const state = announcedStateOf(event);
      if (state === null || ledger === null) return;
      try {
        ledger.markAnnounced(event.job.id, state);
      } catch (error) {
        logger.warn({ jobId: event.job.id, ...describeError(error, secrets) }, 'could not record that a result was delivered');
      }
    },
    ...(overrides.telegramTransformer === undefined ? {} : { apiTransformer: overrides.telegramTransformer }),
    onFatalError: (error) => {
      logger.error(
        { ...describeError(error, secrets) },
        'telegram polling stopped: commands no longer work, but booking jobs and result notifications continue; restart the bot',
      );
      overrides.onTelegramFatal?.(error);
    },
  });

  const runner = createSniperRunner({
    api,
    clock,
    calibration: clock,
    store,
    events: telegram.notifier,
    holidays: env.holidays,
    logger: scoped(logger, 'sniper'),
    ...(overrides.sniper === undefined ? {} : { options: overrides.sniper }),
  });

  let phase: 'created' | 'started' | 'stopped' = 'created';
  let stopping: Promise<void> | undefined;

  const step = async (name: string, work: () => Promise<void> | void): Promise<void> => {
    try {
      await work();
    } catch (error) {
      logger.error({ step: name, ...describeError(error, secrets) }, 'shutdown step failed');
    }
  };

  const shutdown = async (): Promise<void> => {
    phase = 'stopped';
    logger.info({}, 'stopping');
    await step('telegram', () => telegram.stop());
    await step('sniper', () => runner.stop());
    await step('notifications', async () => {
      if (!(await drained(telegram.notifier, overrides.notificationDrainMs ?? NOTIFICATION_DRAIN_MS))) {
        logger.warn({}, 'some notifications could not be delivered before shutdown');
      }
    });
    await step('store', () => store.close());
    logger.info({}, 'stopped');
  };

  const stop = (): Promise<void> => (stopping ??= shutdown());

  const start = async (): Promise<void> => {
    if (phase !== 'created') throw new Error(phase === 'started' ? 'The app is already started' : 'The app was stopped and cannot start again');
    phase = 'started';
    try {
      logger.info(
        { allowedUsers: env.allowedUserIds.length, holidays: env.holidays.size, stopFlag: store.isStopped() },
        'starting',
      );
      if (ledger !== null) {
        await reannounceResults({ ledger, events: telegram.notifier, clock, logger: scoped(logger, 'announce') });
      }
      await recoverJobs({
        api,
        clock,
        store,
        events: telegram.notifier,
        logger: scoped(logger, 'recovery'),
        ...(overrides.recovery === undefined ? {} : { options: overrides.recovery }),
      });
      runner.start();
      await telegram.start();
      logger.info({}, 'running');
    } catch (error) {
      await stop();
      throw error;
    }
  };

  return { service, store, runner, telegram, clock, logger, start, stop };
};

/**
 * Builds the whole bot from a validated environment. Opening the job store is the first thing that happens; if
 * anything after it cannot be built (an invalid allowlist, a malformed token) the store is closed again and the
 * error is thrown. Nothing talks to the network until start().
 */
export const createApp = (env: Env, overrides: AppOverrides = {}): App => {
  const logger = overrides.logger ?? createLogger(env.logLevel);
  const clock = overrides.clock ?? createSystemClock();
  const store = overrides.store ?? openJobStore(resolveDbLocation(env.dbPath));
  try {
    return assemble(env, overrides, logger, clock, store);
  } catch (error) {
    try {
      store.close();
    } catch (closeError) {
      logger.error(describeError(closeError), 'could not close the job store');
    }
    throw error;
  }
};
