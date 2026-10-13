import type { Bot } from 'grammy';
import type { Clock } from '../contracts.js';
import { COMMAND_MENU } from './commands.js';
import { ACCEPTED_UPDATE_TYPES } from './guard.js';
import { describeError } from './text.js';
import { withTimeout } from './timeout.js';
import type { TelegramLogger } from './types.js';

/** grammY retries a dead connection forever: start() stops waiting after this long and the bot keeps connecting. */
export const STARTUP_DEADLINE_MS = 10_000;
/** The last getUpdates of bot.stop() only confirms the final update; it must not hold a shutdown for long. */
export const STOP_CONFIRM_DEADLINE_MS = 5_000;

export interface PollerDeps {
  readonly bot: Bot;
  readonly clock: Clock;
  readonly logger: TelegramLogger;
  readonly secrets: readonly string[];
  readonly onFatalError?: (error: unknown) => void;
}

export interface Poller {
  /** See TelegramBotHandle.start. */
  start(): Promise<void>;
  /** See TelegramBotHandle.stop. */
  stop(): Promise<void>;
}

interface Run {
  readonly abort: AbortController;
  /** What start() returns: polling runs, or the startup deadline passed, or Telegram refused the token in time. */
  readonly ready: Promise<void>;
  /** Settles when the run is over (stopped, failed, or never connected); never rejects. */
  readonly ended: Promise<void>;
}

/** grammY ships its own AbortSignal typing, which differs from the global one only in type declarations. */
const forGrammy = (signal: AbortSignal): never => signal as never;

/**
 * Long polling with a bounded start(). Connecting (getMe, deleteWebhook) is retried by grammY with no end while the
 * network is down, so it runs in the background: start() waits for it only up to STARTUP_DEADLINE_MS, and stop()
 * aborts it. Whatever fails after start() has returned goes to the log and to `onFatalError`.
 */
export const createPoller = (deps: PollerDeps): Poller => {
  const { bot, clock, logger, secrets } = deps;
  let current: Run | undefined;

  const publishMenu = async (signal: AbortSignal): Promise<void> => {
    try {
      await bot.api.setMyCommands([...COMMAND_MENU], undefined, forGrammy(signal));
    } catch (error) {
      if (!signal.aborted) logger.warn(describeError(error, secrets), 'telegram: could not publish the command menu');
    }
  };

  /** Resolves when polling ends (bot.stop()), rejects when connecting or polling fails. */
  const connectAndPoll = async (signal: AbortSignal, onPolling: () => void): Promise<void> => {
    await bot.init(forGrammy(signal));
    if (signal.aborted) return;
    await publishMenu(signal);
    if (signal.aborted) return;
    await bot.start({ allowed_updates: [...ACCEPTED_UPDATE_TYPES], onStart: onPolling });
  };

  const launch = (): Run => {
    const abort = new AbortController();
    const { signal } = abort;
    let announced = false;
    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: unknown) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const release = (): void => {
      if (current?.abort === abort) current = undefined;
    };

    const onPolling = (): void => {
      if (announced) logger.info({}, 'telegram: connected after the startup deadline, long polling runs');
      announced = true;
      resolveReady();
    };

    const onFailure = (error: unknown): void => {
      release();
      if (signal.aborted) return;
      if (!announced) {
        announced = true;
        rejectReady(error);
        return;
      }
      logger.error(describeError(error, secrets), 'telegram: long polling stopped with an error');
      try {
        deps.onFatalError?.(error);
      } catch (callbackError) {
        logger.error(describeError(callbackError, secrets), 'telegram: onFatalError threw');
      }
    };

    const ended = connectAndPoll(signal, onPolling)
      .then(() => undefined, onFailure)
      .finally(() => {
        release();
        resolveReady();
      });

    void clock.sleep(STARTUP_DEADLINE_MS).then(
      () => {
        if (announced || signal.aborted) return;
        announced = true;
        logger.warn({}, 'telegram: not connected yet; start() returns and the bot keeps connecting in the background');
        resolveReady();
      },
      () => undefined,
    );

    return { abort, ready, ended };
  };

  const start = (): Promise<void> => {
    current ??= launch();
    return current.ready;
  };

  const stop = async (): Promise<void> => {
    const run = current;
    if (run === undefined) return;
    run.abort.abort();
    try {
      await withTimeout(bot.stop(), STOP_CONFIRM_DEADLINE_MS, clock);
    } catch (error) {
      logger.warn(describeError(error, secrets), 'telegram: could not confirm the last update while stopping');
    }
    await run.ended;
    if (current === run) current = undefined;
  };

  return { start, stop };
};
