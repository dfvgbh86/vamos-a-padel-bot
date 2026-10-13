import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../../src/runtime/logger.js';
import {
  DEFAULT_FORCE_AFTER_MS,
  registerProcessGuards,
  registerShutdown,
  shutdownSignals,
  type ProcessLike,
} from '../../src/runtime/shutdown.js';

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
};

const fakeProcess = (platform = 'linux'): ProcessLike & EventEmitter & { platform: string } => Object.assign(new EventEmitter(), { platform });

const fakeLogger = () => {
  const lines: string[] = [];
  const at = (level: string) => (obj: object, msg?: string) => void lines.push(`${level} ${msg ?? ''} ${JSON.stringify(obj)}`);
  const logger: AppLogger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
  return { logger, lines };
};

/** A timer the test fires by hand. */
const fakeTimer = () => {
  const timers: { callback: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    timers,
    startTimer: (callback: () => void, ms: number) => {
      const timer = { callback, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    fireAll: () => timers.filter((timer) => !timer.cancelled).forEach((timer) => timer.callback()),
  };
};

const deferred = () => {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe('shutdown signals', () => {
  it('are Ctrl+C and termination everywhere, plus Ctrl+Break / console close on Windows', () => {
    expect(shutdownSignals('linux')).toEqual(['SIGINT', 'SIGTERM']);
    expect(shutdownSignals('darwin')).toEqual(['SIGINT', 'SIGTERM']);
    expect(shutdownSignals('win32')).toEqual(['SIGINT', 'SIGTERM', 'SIGBREAK']);
  });
});

describe('registerShutdown', () => {
  const setup = (platform = 'linux') => {
    const target = fakeProcess(platform);
    const log = fakeLogger();
    const timer = fakeTimer();
    const stop = deferred();
    const app = { stop: vi.fn(() => stop.promise) };
    const exit = vi.fn();
    const unregister = registerShutdown({ app, logger: log.logger, target, exit, startTimer: timer.startTimer });
    return { target, log, timer, stop, app, exit, unregister };
  };

  it.each(['SIGINT', 'SIGTERM'])('%s stops the app, then exits with 0', async (signal) => {
    const { target, app, exit, stop } = setup();
    target.emit(signal);
    expect(app.stop).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    stop.resolve();
    await flush();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('listens for SIGBREAK on Windows only', () => {
    expect(setup('win32').target.listenerCount('SIGBREAK')).toBe(1);
    expect(setup('linux').target.listenerCount('SIGBREAK')).toBe(0);
  });

  it('a second signal exits at once with 1, without waiting for the first stop', async () => {
    const { target, app, exit } = setup();
    target.emit('SIGINT');
    target.emit('SIGINT');
    expect(app.stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a stop that fails exits with 1 and says so in the log', async () => {
    const { target, exit, stop, log } = setup();
    target.emit('SIGTERM');
    stop.reject(new Error('could not close'));
    await flush();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.lines.join('\n')).toContain('shutdown failed');
  });

  it('a stop that hangs is abandoned after the deadline', async () => {
    const { target, exit, timer } = setup();
    target.emit('SIGINT');
    expect(timer.timers).toHaveLength(1);
    expect(timer.timers[0]?.ms).toBe(DEFAULT_FORCE_AFTER_MS);
    expect(exit).not.toHaveBeenCalled();
    timer.fireAll();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a stop that finishes cancels the deadline', async () => {
    const { target, stop, timer, exit } = setup();
    target.emit('SIGINT');
    stop.resolve();
    await flush();
    expect(timer.timers[0]?.cancelled).toBe(true);
    timer.fireAll();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('unregistering removes every handler', () => {
    const { target, unregister } = setup('win32');
    unregister();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) expect(target.listenerCount(signal)).toBe(0);
  });

  it('logs the signal that was received', () => {
    const { target, log } = setup();
    target.emit('SIGTERM');
    expect(log.lines.join('\n')).toContain('shutdown requested');
    expect(log.lines.join('\n')).toContain('SIGTERM');
  });

  it('masks configured secrets that appear in a stop failure', async () => {
    const target = fakeProcess();
    const log = fakeLogger();
    const exit = vi.fn();
    registerShutdown({
      app: { stop: () => Promise.reject(new Error('refused for synthetic-password-0001')) },
      logger: log.logger,
      target,
      exit,
      secrets: ['synthetic-password-0001'],
      startTimer: fakeTimer().startTimer,
    });
    target.emit('SIGINT');
    await flush();
    expect(log.lines.join('\n')).not.toContain('synthetic-password-0001');
  });
});

describe('registerProcessGuards', () => {
  const setup = () => {
    const target = fakeProcess();
    const log = fakeLogger();
    const timer = fakeTimer();
    const stop = deferred();
    const app = { stop: vi.fn(() => stop.promise) };
    const exit = vi.fn();
    const unregister = registerProcessGuards({ app, logger: log.logger, target, exit, startTimer: timer.startTimer });
    return { target, log, timer, stop, app, exit, unregister };
  };

  it('an unhandled rejection is logged and the bot keeps running', async () => {
    const { target, log, app, exit } = setup();
    target.emit('unhandledRejection', new Error('stray failure'));
    await flush();
    expect(log.lines.join('\n')).toContain('unhandled promise rejection');
    expect(app.stop).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('an uncaught exception stops the app in order and exits with 1', async () => {
    const { target, app, exit, stop, log } = setup();
    target.emit('uncaughtException', new Error('invariant broken'));
    expect(app.stop).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    stop.resolve();
    await flush();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.lines.join('\n')).toContain('uncaught exception');
  });

  it('a second uncaught exception while stopping exits at once', () => {
    const { target, exit } = setup();
    target.emit('uncaughtException', new Error('first'));
    target.emit('uncaughtException', new Error('second'));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a stop that hangs after an uncaught exception is abandoned', () => {
    const { target, exit, timer } = setup();
    target.emit('uncaughtException', new Error('boom'));
    timer.fireAll();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits with 1 even when the stop fails', async () => {
    const { target, exit, stop } = setup();
    target.emit('uncaughtException', new Error('boom'));
    stop.reject(new Error('and the stop failed too'));
    await flush();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('unregistering removes both handlers', () => {
    const { target, unregister } = setup();
    unregister();
    expect(target.listenerCount('unhandledRejection')).toBe(0);
    expect(target.listenerCount('uncaughtException')).toBe(0);
  });
});
