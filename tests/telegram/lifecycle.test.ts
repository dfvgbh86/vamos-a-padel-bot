import { describe, expect, it, vi } from 'vitest';
import { createTelegramBot } from '../../src/telegram/bot.js';
import { STARTUP_DEADLINE_MS } from '../../src/telegram/poller.js';
import type { TelegramLogger } from '../../src/telegram/types.js';
import { createExpiringStore, DRAFT_TTL_MS } from '../../src/telegram/sessions.js';
import { withTimeout, TIMED_OUT } from '../../src/telegram/timeout.js';
import { FakeClock, FakeJobService, makeJob } from './_fakes.js';
import { createFakeTransport, createLogRecorder, FAKE_TOKEN, messageUpdate, OWNER_ID, STRANGER_ID } from './_harness.js';

const build = (onFatalError?: (error: unknown) => void) => {
  const transport = createFakeTransport();
  const logs = createLogRecorder();
  const clock = new FakeClock();
  const handle = createTelegramBot({
    token: FAKE_TOKEN,
    allowedUserIds: [OWNER_ID],
    service: new FakeJobService(),
    clock,
    logger: logs.logger,
    apiTransformer: transport.transformer,
    ...(onFatalError === undefined ? {} : { onFatalError }),
  });
  return { transport, logs, handle, clock };
};

const settleFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('long polling lifecycle', () => {
  it('start() initialises, publishes the menu, drops the webhook and polls only messages and button presses', async () => {
    const { transport, handle } = build();
    await handle.start();
    expect(transport.calls.map((call) => call.method).slice(0, 3)).toEqual(['getMe', 'setMyCommands', 'deleteWebhook']);
    await vi.waitFor(() => expect(transport.of('getUpdates').length).toBeGreaterThan(0));
    expect(transport.of('getUpdates')[0]?.payload['allowed_updates']).toEqual(['message', 'callback_query']);
    await handle.stop();
  });

  it('processes queued updates: the owner is answered, a stranger is ignored', async () => {
    const { transport, handle } = build();
    transport.queueUpdates([messageUpdate('/help'), messageUpdate('/help', { fromId: STRANGER_ID })]);
    await handle.start();
    await vi.waitFor(() => expect(transport.of('sendMessage')).toHaveLength(1));
    expect(transport.of('sendMessage')[0]?.payload['chat_id']).toBe(OWNER_ID);
    await handle.stop();
    expect(transport.of('sendMessage')).toHaveLength(1);
  });

  it('stop() ends polling and start() can be called again', async () => {
    const { transport, handle } = build();
    await handle.start();
    expect(handle.bot.isRunning()).toBe(true);
    await handle.stop();
    expect(handle.bot.isRunning()).toBe(false);
    transport.clear();
    await handle.start();
    expect(handle.bot.isRunning()).toBe(true);
    await handle.stop();
  });

  it('start() twice does not start a second loop', async () => {
    const { transport, handle } = build();
    await handle.start();
    await handle.start();
    expect(transport.of('deleteWebhook')).toHaveLength(1);
    await handle.stop();
  });

  it('stop() without start() is harmless', async () => {
    const { handle } = build();
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it('start() rejects when Telegram refuses the token, and a later start() may try again', async () => {
    const { transport, handle } = build();
    transport.failNext('getMe', { code: 401, description: 'Unauthorized' });
    await expect(handle.start()).rejects.toThrow(/Unauthorized/);
    expect(handle.bot.isRunning()).toBe(false);
    await handle.start();
    expect(handle.bot.isRunning()).toBe(true);
    await handle.stop();
  });

  it('stop() survives a failing final getUpdates (network down at shutdown) and start() works again afterwards', async () => {
    const { transport, logs, handle } = build();
    await handle.start();
    await vi.waitFor(() => expect(transport.of('getUpdates').length).toBeGreaterThan(0));
    transport.failNext('getUpdates', { code: 502, description: 'Bad Gateway' });
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(handle.bot.isRunning()).toBe(false);
    expect(logs.entries.some((entry) => entry.level === 'warn' && entry.msg?.includes('while stopping'))).toBe(true);

    transport.clear();
    await handle.start();
    expect(handle.bot.isRunning()).toBe(true);
    expect(transport.of('deleteWebhook')).toHaveLength(1);
    await handle.stop();
  });

  it('stop() survives a dead network connection at shutdown', async () => {
    const { transport, handle } = build();
    await handle.start();
    await vi.waitFor(() => expect(transport.of('getUpdates').length).toBeGreaterThan(0));
    transport.setOffline(true);
    await expect(handle.stop()).resolves.toBeUndefined();
    expect(handle.bot.isRunning()).toBe(false);
  });

  it('a failing setMyCommands is only a warning', async () => {
    const { transport, logs, handle } = build();
    transport.failNext('setMyCommands', { code: 500, description: 'Internal Server Error' });
    await handle.start();
    expect(logs.entries.some((entry) => entry.level === 'warn' && entry.msg?.includes('command menu'))).toBe(true);
    await handle.stop();
  });

  it('when polling dies later (another instance took over: 409) the error is logged and reported once', async () => {
    const onFatalError = vi.fn();
    const { transport, logs, handle } = build(onFatalError);
    transport.failNext('getUpdates', { code: 409, description: 'Conflict: terminated by other getUpdates request' });
    await handle.start();
    await vi.waitFor(() => expect(onFatalError).toHaveBeenCalledTimes(1));
    expect(logs.entries.some((entry) => entry.level === 'error' && entry.msg?.includes('long polling stopped'))).toBe(true);
    expect(handle.bot.isRunning()).toBe(false);
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it('an onFatalError callback that throws is logged and cannot crash the process', async () => {
    const onFatalError = vi.fn(() => {
      throw new Error('callback blew up');
    });
    const { transport, logs, handle } = build(onFatalError);
    transport.failNext('getUpdates', { code: 409, description: 'Conflict: terminated by other getUpdates request' });
    await handle.start();
    await vi.waitFor(() => expect(logs.entries.some((entry) => entry.msg?.includes('onFatalError threw'))).toBe(true));
    expect(onFatalError).toHaveBeenCalledTimes(1);
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it('after polling died, start() brings it back', async () => {
    const onFatalError = vi.fn();
    const { transport, handle } = build(onFatalError);
    transport.failNext('getUpdates', { code: 409, description: 'Conflict: terminated by other getUpdates request' });
    await handle.start();
    await vi.waitFor(() => expect(onFatalError).toHaveBeenCalledTimes(1));
    transport.clear();
    await handle.start();
    expect(handle.bot.isRunning()).toBe(true);
    expect(transport.of('deleteWebhook')).toHaveLength(1);
    await handle.stop();
  });

  it('the bot token never appears in the log', async () => {
    const { transport, logs, handle } = build();
    transport.failNext('getUpdates', { code: 409, description: `Conflict ${FAKE_TOKEN}` });
    await handle.start().catch(() => undefined);
    await vi.waitFor(() => expect(logs.entries.some((entry) => entry.level === 'error')).toBe(true));
    expect(logs.dump()).not.toContain(FAKE_TOKEN);
  });
});

describe('Telegram unreachable at boot (the PC wakes before Wi-Fi is up)', () => {
  it('start() still settles at the startup deadline, never hangs, and says it keeps connecting', async () => {
    const { transport, logs, handle, clock } = build();
    clock.sleepMode = 'immediate';
    transport.setOffline(true);
    await expect(handle.start()).resolves.toBeUndefined();
    expect(handle.bot.isRunning()).toBe(false);
    expect(logs.entries.some((entry) => entry.level === 'warn' && entry.msg?.includes('keeps connecting'))).toBe(true);
    expect(clock.sleeps).toContain(STARTUP_DEADLINE_MS);
    await handle.stop();
  });

  it('the startup deadline is short enough that nothing waiting for start() can miss a 07:00 window', () => {
    expect(STARTUP_DEADLINE_MS).toBeGreaterThan(0);
    expect(STARTUP_DEADLINE_MS).toBeLessThanOrEqual(15_000);
  });

  it('the notifier works while start() is still connecting: it never depends on start()', async () => {
    const { transport, handle, clock } = build();
    clock.sleepMode = 'immediate';
    transport.setOffline(true);
    await handle.start();
    transport.setOffline(false);
    await handle.notifier.emit({ kind: 'expired', job: makeJob() });
    expect(transport.of('sendMessage')).toHaveLength(1);
    await handle.stop();
  });

  it('keeps connecting in the background and starts polling once the network is back', async () => {
    const { transport, handle, clock } = build();
    clock.sleepMode = 'immediate';
    transport.setOffline(true);
    await handle.start();
    expect(transport.of('getMe').length).toBeGreaterThan(0);

    transport.setOffline(false);
    await vi.waitFor(() => expect(handle.bot.isRunning()).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() => expect(transport.of('getUpdates').length).toBeGreaterThan(0));
    expect(transport.of('getUpdates')[0]?.payload['allowed_updates']).toEqual(['message', 'callback_query']);
    expect(transport.of('deleteWebhook')).toHaveLength(1);
    await handle.stop();
  });

  it('a start() that comes while the first one is still connecting shares it', async () => {
    const { transport, handle, clock } = build();
    clock.sleepMode = 'immediate';
    transport.setOffline(true);
    await Promise.all([handle.start(), handle.start()]);
    transport.setOffline(false);
    await vi.waitFor(() => expect(handle.bot.isRunning()).toBe(true), { timeout: 5_000 });
    await settleFor(50);
    expect(transport.of('deleteWebhook')).toHaveLength(1);
    await handle.stop();
  });

  it('a token refused only after the deadline is reported through onFatalError, once', async () => {
    const onFatalError = vi.fn();
    const { transport, logs, handle, clock } = build(onFatalError);
    clock.sleepMode = 'immediate';
    transport.setOffline(true);
    await handle.start();

    transport.failNext('getMe', { code: 401, description: 'Unauthorized' });
    transport.setOffline(false);
    await vi.waitFor(() => expect(onFatalError).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(logs.entries.some((entry) => entry.level === 'error' && entry.msg?.includes('long polling'))).toBe(true);
    expect(handle.bot.isRunning()).toBe(false);
    await handle.stop();
  });

  it('stop() while still connecting ends the background attempts for good', async () => {
    const { transport, handle, clock } = build();
    clock.sleepMode = 'immediate';
    transport.setOffline(true);
    await handle.start();
    await expect(handle.stop()).resolves.toBeUndefined();

    await settleFor(150);
    const attempts = transport.of('getMe').length;
    transport.setOffline(false);
    await settleFor(700);
    expect(transport.of('getMe').length).toBe(attempts);
    expect(handle.bot.isRunning()).toBe(false);
    expect(transport.of('getUpdates')).toHaveLength(0);
  });

  it('after a stop() during connection, start() begins afresh', async () => {
    const { transport, handle, clock } = build();
    clock.sleepMode = 'immediate';
    transport.setOffline(true);
    await handle.start();
    await handle.stop();
    transport.setOffline(false);
    await handle.start();
    await vi.waitFor(() => expect(handle.bot.isRunning()).toBe(true));
    await handle.stop();
  });

  it('a healthy start() resolves because polling runs, without any deadline warning', async () => {
    const { transport, logs, handle } = build();
    await handle.start();
    expect(handle.bot.isRunning()).toBe(true);
    expect(transport.of('getMe')).toHaveLength(1);
    expect(logs.entries.some((entry) => entry.level === 'warn')).toBe(false);
    await handle.stop();
  });

  it('a transient connection failure that heals before the deadline is absorbed by start()', async () => {
    const { transport, handle } = build();
    transport.setOffline(true);
    const started = handle.start();
    await settleFor(120);
    transport.setOffline(false);
    await started;
    expect(handle.bot.isRunning()).toBe(true);
    await handle.stop();
  });
});

describe('the in-memory conversation store', () => {
  it('returns an entry until it expires, then forgets it', () => {
    const clock = new FakeClock(1_000);
    const store = createExpiringStore<{ expiresAtMs: number; value: string }>(clock);
    store.set(1, { expiresAtMs: 1_000 + DRAFT_TTL_MS, value: 'a' });
    expect(store.get(1)?.value).toBe('a');
    clock.now += DRAFT_TTL_MS - 1;
    expect(store.get(1)?.value).toBe('a');
    clock.now += 1;
    expect(store.get(1)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('keeps users apart, replaces entries and deletes them', () => {
    const clock = new FakeClock(0);
    const store = createExpiringStore<{ expiresAtMs: number; value: number }>(clock);
    store.set(1, { expiresAtMs: 10, value: 1 });
    store.set(2, { expiresAtMs: 10, value: 2 });
    store.set(1, { expiresAtMs: 10, value: 3 });
    expect(store.get(1)?.value).toBe(3);
    expect(store.get(2)?.value).toBe(2);
    store.delete(1);
    expect(store.get(1)).toBeUndefined();
    expect(store.size()).toBe(1);
  });

  it('counts only live entries', () => {
    const clock = new FakeClock(0);
    const store = createExpiringStore<{ expiresAtMs: number }>(clock);
    for (let user = 1; user <= 50; user += 1) store.set(user, { expiresAtMs: 5 });
    clock.now = 10;
    store.set(99, { expiresAtMs: 100 });
    expect(store.size()).toBe(1);
    expect(store.get(1)).toBeUndefined();
  });
});

describe('withTimeout', () => {
  it('returns the value of work that finishes in time', async () => {
    await expect(withTimeout(Promise.resolve(5), 1000, new FakeClock())).resolves.toBe(5);
  });

  it('rejects when the work fails in time', async () => {
    await expect(withTimeout(Promise.reject(new Error('x')), 1000, new FakeClock())).rejects.toThrow('x');
  });

  it('gives up on work that never finishes, and swallows its late failure', async () => {
    const clock = new FakeClock();
    clock.sleepMode = 'immediate';
    let fail: (error: Error) => void = () => undefined;
    const work = new Promise<number>((_resolve, reject) => {
      fail = reject;
    });
    await expect(withTimeout(work, 1000, clock)).resolves.toBe(TIMED_OUT);
    fail(new Error('late'));
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('logger compatibility', () => {
  it('accepts a pino logger as it is', async () => {
    const { default: pino } = await import('pino');
    const logger: TelegramLogger = pino({ level: 'silent' });
    const handle = createTelegramBot({
      token: FAKE_TOKEN,
      allowedUserIds: [OWNER_ID],
      service: new FakeJobService(),
      clock: new FakeClock(),
      logger,
      apiTransformer: createFakeTransport().transformer,
    });
    expect(handle.notifier).toBeDefined();
  });
});
