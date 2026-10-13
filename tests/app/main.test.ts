import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { App } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { main, type MainDeps } from '../../src/main.js';
import type { ProcessLike } from '../../src/runtime/shutdown.js';

/** Synthetic values only. */
const ENV = {
  TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN-NOT-REAL',
  TELEGRAM_ALLOWED_USER_IDS: '42',
  RESERVAPLAY_USERNAME: 'test-player',
  RESERVAPLAY_PASSWORD: 'synthetic-password-0001',
};

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
};

const fakeApp = (overrides: Partial<App> = {}): App =>
  ({
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    ...overrides,
  }) as unknown as App;

const setup = (patch: Partial<MainDeps> = {}) => {
  const target: ProcessLike & EventEmitter = Object.assign(new EventEmitter(), { platform: 'linux' });
  const written: string[] = [];
  const exit = vi.fn();
  const deps: MainDeps = {
    env: ENV,
    target,
    writeError: (text, done) => {
      written.push(text);
      done();
    },
    exit,
    ...patch,
  };
  return { deps, target, written, exit };
};

describe('main: configuration errors', () => {
  it('an empty environment prints one clear line naming the keys and exits with 1; nothing is built', async () => {
    const createApp = vi.fn();
    const { deps, written, exit } = setup({ env: {}, createApp });
    await main(deps);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^Fatal: Configuration error \(missing: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, RESERVAPLAY_USERNAME, RESERVAPLAY_PASSWORD\)/);
    expect(written[0]?.endsWith('\n')).toBe(true);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(createApp).not.toHaveBeenCalled();
  });

  it('an empty allowlist is a startup error naming the key', async () => {
    const { deps, written, exit } = setup({ env: { ...ENV, TELEGRAM_ALLOWED_USER_IDS: '' } });
    await main(deps);
    expect(written[0]).toContain('TELEGRAM_ALLOWED_USER_IDS');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('the line never contains a configured value', async () => {
    const { deps, written } = setup({ env: { ...ENV, TELEGRAM_ALLOWED_USER_IDS: 'sentinel-ids-0001', LOG_LEVEL: 'sentinel-level' } });
    await main(deps);
    const text = written.join('');
    for (const value of ['sentinel-ids-0001', 'sentinel-level', ENV.TELEGRAM_BOT_TOKEN, ENV.RESERVAPLAY_PASSWORD, ENV.RESERVAPLAY_USERNAME]) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain('invalid: TELEGRAM_ALLOWED_USER_IDS, LOG_LEVEL');
  });

  it('exits only after the message was written (the exit callback runs from the write)', async () => {
    const order: string[] = [];
    const { deps } = setup({
      env: {},
      writeError: (_text, done) => {
        order.push('written');
        setImmediate(() => {
          order.push('flushed');
          done();
        });
      },
      exit: () => void order.push('exit'),
    });
    await main(deps);
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['written', 'flushed', 'exit']);
  });
});

describe('main: starting the app', () => {
  it('loads the environment, builds the app from it and starts it; nothing is printed or exited', async () => {
    const app = fakeApp();
    const createApp = vi.fn((_env: Env) => app);
    const { deps, written, exit } = setup({ createApp });
    await main(deps);
    expect(createApp).toHaveBeenCalledTimes(1);
    expect(createApp.mock.calls[0]?.[0]).toMatchObject({ telegramBotToken: ENV.TELEGRAM_BOT_TOKEN, allowedUserIds: [42], username: 'test-player' });
    expect(app.start).toHaveBeenCalledTimes(1);
    expect(written).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('hands the overrides to createApp', async () => {
    const createApp = vi.fn((_env: Env, _overrides?: unknown) => fakeApp());
    const overrides = { sniper: { tickMs: 500 } };
    await main(setup({ createApp, overrides }).deps);
    expect(createApp.mock.calls[0]?.[1]).toBe(overrides);
  });

  it('registers shutdown on Ctrl+C: the app is stopped and the process exits with 0', async () => {
    const app = fakeApp();
    const { deps, target, exit } = setup({ createApp: () => app });
    await main(deps);
    expect(target.listenerCount('SIGINT')).toBe(1);
    expect(target.listenerCount('SIGTERM')).toBe(1);
    target.emit('SIGINT');
    await flush();
    expect(app.stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('guards against stray rejections', async () => {
    const { deps, target } = setup({ createApp: () => fakeApp() });
    await main(deps);
    expect(target.listenerCount('unhandledRejection')).toBe(1);
    expect(target.listenerCount('uncaughtException')).toBe(1);
  });
});

describe('main: failures while building or starting', () => {
  it('a failing start prints the message only, with secrets hidden, and exits with 1', async () => {
    const app = fakeApp({
      start: vi.fn(async () => {
        throw new Error(`Call to getMe failed with ${ENV.TELEGRAM_BOT_TOKEN} and ${ENV.RESERVAPLAY_PASSWORD} (${'e'.repeat(40)})`);
      }),
    });
    const { deps, written, exit } = setup({ createApp: () => app });
    await main(deps);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^Fatal: Call to getMe failed with \[hidden\] and \[hidden\]/);
    expect(written[0]).not.toContain(ENV.TELEGRAM_BOT_TOKEN);
    expect(written[0]).not.toContain(ENV.RESERVAPLAY_PASSWORD);
    expect(written[0]).not.toContain('e'.repeat(40));
    expect(written[0]).not.toMatch(/\n\s+at /);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a createApp that throws (for instance a store that cannot be opened) ends the same way', async () => {
    const { deps, written, exit } = setup({
      createApp: () => {
        throw new Error('unable to open database file');
      },
    });
    await main(deps);
    expect(written).toEqual(['Fatal: unable to open database file\n']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('an error without a message still says what it was', async () => {
    const { deps, written } = setup({
      createApp: () => {
        throw new RangeError('');
      },
    });
    await main(deps);
    expect(written).toEqual(['Fatal: RangeError\n']);
  });
});
