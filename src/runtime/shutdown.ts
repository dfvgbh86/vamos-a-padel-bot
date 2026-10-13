import { describeError } from './errors.js';
import type { AppLogger } from './logger.js';

type Listener = (...args: unknown[]) => void;

/** The slice of `process` the guards use, so tests can drive them with a plain event emitter. */
export interface ProcessLike {
  readonly platform: string;
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
}

export interface Stoppable {
  stop(): Promise<void>;
}

export interface ShutdownDeps {
  readonly app: Stoppable;
  readonly logger: AppLogger;
  readonly target: ProcessLike;
  readonly exit: (code: number) => void;
  /** Values to mask in anything that is logged about a failure. */
  readonly secrets?: readonly string[];
  /** After this long a stuck shutdown is abandoned. */
  readonly forceAfterMs?: number;
  /** Test seam; defaults to a real timer. Returns the function that cancels it. */
  readonly startTimer?: (callback: () => void, ms: number) => () => void;
}

export const DEFAULT_FORCE_AFTER_MS = 30_000;

const realTimer = (callback: () => void, ms: number): (() => void) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

/** Ctrl+C everywhere, termination requests on POSIX, and Ctrl+Break / closing the console window on Windows. */
export const shutdownSignals = (platform: string): readonly string[] =>
  platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];

/**
 * First signal: stop the app in order and exit 0. A second signal, a failing stop or a stop that hangs: exit 1 at once.
 * Returns a function that removes the handlers.
 */
export const registerShutdown = (deps: ShutdownDeps): (() => void) => {
  const { app, logger, target, exit } = deps;
  const startTimer = deps.startTimer ?? realTimer;
  const forceAfterMs = deps.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS;
  let requested = false;

  const onSignal = (signal: string): void => {
    if (requested) {
      logger.warn({ signal }, 'second shutdown signal: exiting without waiting');
      exit(1);
      return;
    }
    requested = true;
    logger.info({ signal }, 'shutdown requested');
    const cancelForce = startTimer(() => {
      logger.error({}, 'shutdown took too long: exiting');
      exit(1);
    }, forceAfterMs);
    app.stop().then(
      () => {
        cancelForce();
        exit(0);
      },
      (error: unknown) => {
        cancelForce();
        logger.error(describeError(error, deps.secrets), 'shutdown failed');
        exit(1);
      },
    );
  };

  const handlers = shutdownSignals(target.platform).map((signal) => {
    const handler = (): void => onSignal(signal);
    target.on(signal, handler);
    return { signal, handler };
  });
  return () => {
    for (const { signal, handler } of handlers) target.off(signal, handler);
  };
};

/**
 * A rejected promise that nobody awaited is logged and the bot keeps running: a booking in progress must not die
 * because of a stray failure elsewhere. An uncaught exception leaves the process in an unknown state: it is stopped
 * in order and the process exits with a failure.
 */
export const registerProcessGuards = (deps: ShutdownDeps): (() => void) => {
  const { app, logger, target, exit } = deps;
  const startTimer = deps.startTimer ?? realTimer;
  let dying = false;

  const onRejection = (reason: unknown): void => {
    logger.error(describeError(reason, deps.secrets), 'unhandled promise rejection');
  };
  const onException = (error: unknown): void => {
    logger.error(describeError(error, deps.secrets), 'uncaught exception: stopping');
    if (dying) {
      exit(1);
      return;
    }
    dying = true;
    startTimer(() => exit(1), deps.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS);
    app.stop().then(
      () => exit(1),
      () => exit(1),
    );
  };

  target.on('unhandledRejection', onRejection);
  target.on('uncaughtException', onException);
  return () => {
    target.off('unhandledRejection', onRejection);
    target.off('uncaughtException', onException);
  };
};
