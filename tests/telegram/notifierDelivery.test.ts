import { GrammyError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import type { JobEvent } from '../../src/contracts.js';
import { createNotifier, formatJobEvent } from '../../src/telegram/notifier.js';
import type { TelegramLogger } from '../../src/telegram/types.js';
import { OPENS_21_MS, date, makeJob } from './_fakes.js';
import { createHarness, createLogRecorder, FAKE_TOKEN, OWNER_ID } from './_harness.js';

const job = makeJob({
  id: 12,
  gameDate: date('2026-10-21'),
  opensAtMs: OPENS_21_MS,
  choices: [
    { courtId: 9, startMinutes: 1080 },
    { courtId: 10, startMinutes: 1170 },
  ],
});

const booked: JobEvent = { kind: 'booked', job, reservationId: 100002, choice: { courtId: 9, startMinutes: 1080 } };
const windowOpen: JobEvent = { kind: 'window_open', job };

const botError = (code: number, description = 'Telegram says no', retryAfter?: number): GrammyError =>
  new GrammyError(
    'x',
    { ok: false, error_code: code, description, ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }) },
    'sendMessage',
    {},
  );

const make = (sendMessage: ReturnType<typeof vi.fn>, chats: readonly number[] = [OWNER_ID], logger?: TelegramLogger) => {
  const sleeps: number[] = [];
  const notifier = createNotifier({ sendMessage } as never, chats, logger, [], {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { notifier, sleeps };
};

describe('createNotifier: the happy path', () => {
  it('sends the formatted event to every owner chat as HTML without link previews', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const { notifier } = make(sendMessage, [OWNER_ID, 43]);
    await notifier.emit(booked);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      OWNER_ID,
      formatJobEvent(booked),
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
      expect.any(AbortSignal),
    );
    expect(sendMessage.mock.calls[1]?.[0]).toBe(43);
  });

  it('bounds every send with a deadline so a stuck connection cannot hold emit() for long', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    await make(sendMessage).notifier.emit(booked);
    const signal = sendMessage.mock.calls[0]?.[3] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('a send that works needs no pause and no retry', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const { notifier, sleeps } = make(sendMessage);
    await notifier.emit(booked);
    await notifier.idle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('idle() resolves at once when nothing is waiting for a retry', async () => {
    await expect(make(vi.fn()).notifier.idle()).resolves.toBeUndefined();
  });
});

describe('createNotifier: a transient failure no longer loses the event', () => {
  it('a network error is retried after a pause, and the retry delivers the very same text', async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error('read ECONNRESET')).mockResolvedValue({});
    const { notifier, sleeps } = make(sendMessage);
    await notifier.emit(booked);
    await notifier.idle();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[1]).toBe(formatJobEvent(booked));
    expect(sendMessage.mock.calls[1]?.[2]).toEqual({ parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    expect(sleeps).toEqual([2_000]);
  });

  it('a send that ran into its own deadline (a TimeoutError) is retried too', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const sendMessage = vi.fn().mockRejectedValueOnce(timeout).mockResolvedValue({});
    const { notifier } = make(sendMessage);
    await notifier.emit(booked);
    await notifier.idle();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it.each([500, 502, 503])('Bot API error %i is retried', async (code) => {
    const sendMessage = vi.fn().mockRejectedValueOnce(botError(code)).mockResolvedValue({});
    const { notifier } = make(sendMessage);
    await notifier.emit(booked);
    await notifier.idle();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('429 waits at least as long as Telegram asks (retry_after)', async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(botError(429, 'Too Many Requests: retry after 7', 7)).mockResolvedValue({});
    const { notifier, sleeps } = make(sendMessage);
    await notifier.emit(booked);
    await notifier.idle();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([7_000]);
  });

  it('429 without retry_after uses the normal pause', async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(botError(429)).mockResolvedValue({});
    const { notifier, sleeps } = make(sendMessage);
    await notifier.emit(booked);
    await notifier.idle();
    expect(sleeps).toEqual([2_000]);
  });

  it('429 with a tiny retry_after still keeps the normal pause', async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(botError(429, 'Too Many Requests', 1)).mockResolvedValue({});
    const { notifier, sleeps } = make(sendMessage);
    await notifier.emit(booked);
    await notifier.idle();
    expect(sleeps).toEqual([2_000]);
  });

  it('429 that asks for an hour is not waited for: logged and dropped', async () => {
    const logs = createLogRecorder();
    const sendMessage = vi.fn().mockRejectedValue(botError(429, 'Too Many Requests', 3_600));
    const { notifier, sleeps } = make(sendMessage, [OWNER_ID], logs.logger);
    await notifier.emit(booked);
    await notifier.idle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(logs.entries.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('emit() returns after the first attempt: it never waits for a retry, so later events are not held back', async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue({});
    const pauses: (() => void)[] = [];
    const notifier = createNotifier({ sendMessage } as never, [OWNER_ID], undefined, [], {
      sleep: () => new Promise<void>((resolve) => pauses.push(resolve)),
    });

    await notifier.emit(windowOpen);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await notifier.emit(booked);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[1]).toBe(formatJobEvent(booked));

    pauses.forEach((release) => release());
    await notifier.idle();
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[2]?.[1]).toBe(formatJobEvent(windowOpen));
  });

  it('a retry reaches only the chat that failed', async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue({});
    const { notifier } = make(sendMessage, [OWNER_ID, 43]);
    await notifier.emit(booked);
    await notifier.idle();
    expect(sendMessage.mock.calls.map((call) => call[0])).toEqual([OWNER_ID, 43, OWNER_ID]);
  });

  it('a failure for one chat does not stop the next chat', async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(botError(403, 'Forbidden: bot was blocked by the user')).mockResolvedValue({});
    const { notifier } = make(sendMessage, [OWNER_ID, 43]);
    await notifier.emit(booked);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[0]).toBe(43);
  });

  it('a transient failure for one chat does not delay the next chat behind the retry pause', async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue({});
    const notifier = createNotifier({ sendMessage } as never, [OWNER_ID, 43], undefined, [], { sleep: () => new Promise(() => undefined) });
    await notifier.emit(booked);
    expect(sendMessage.mock.calls.map((call) => call[0])).toEqual([OWNER_ID, 43]);
  });
});

describe('createNotifier: bounded retries', () => {
  it.each<[string, JobEvent]>([
    ['booked', booked],
    ['needs_payment', { kind: 'needs_payment', job, reservationId: 100003 }],
    ['failed', { kind: 'failed', job, reason: 'slot taken' }],
    ['ambiguous', { kind: 'ambiguous', job, detail: 'timeout after sending' }],
    ['preflight_failed', { kind: 'preflight_failed', job, reason: 'no_funds', detail: '' }],
    ['expired', { kind: 'expired', job }],
  ])('%s: the owner must see it, so retries go on for hours (quick at first, then every minute) before it is given up', async (_name, event) => {
    const logs = createLogRecorder();
    const sendMessage = vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT'));
    const { notifier, sleeps } = make(sendMessage, [OWNER_ID], logs.logger);
    await expect(notifier.emit(event)).resolves.toBeUndefined();
    await notifier.idle();

    expect(sleeps.slice(0, 5)).toEqual([2_000, 5_000, 15_000, 30_000, 60_000]);
    expect(sleeps.slice(4).every((ms) => ms === 60_000)).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(sleeps.length + 1);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(5 * 3_600_000);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(7 * 3_600_000);
    const errors = logs.entries.filter((entry) => entry.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.obj).toMatchObject({ eventKind: event.kind });
  });

  it.each<[string, JobEvent]>([
    ['armed', { kind: 'armed', job }],
    ['preflight_ok', { kind: 'preflight_ok', job, walletCents: 4000, quoteCents: 1902 }],
    ['window_open', windowOpen],
  ])('%s is routine: three attempts only', async (_name, event) => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT'));
    const { notifier, sleeps } = make(sendMessage);
    await notifier.emit(event);
    await notifier.idle();
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2_000, 5_000]);
  });

  it('stops retrying as soon as one attempt gets through', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(botError(502))
      .mockResolvedValue({});
    const { notifier, sleeps } = make(sendMessage);
    await notifier.emit(booked);
    await notifier.idle();
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2_000, 5_000]);
  });

  it.each([401, 403, 404])('Bot API error %i is permanent (bot blocked, wrong chat): never retried', async (code) => {
    const logs = createLogRecorder();
    const sendMessage = vi.fn().mockRejectedValue(botError(code, 'Forbidden: bot was blocked by the user'));
    const { notifier, sleeps } = make(sendMessage, [OWNER_ID], logs.logger);
    await notifier.emit(booked);
    await notifier.idle();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(logs.entries.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('never throws, and logs the failure without the message text', async () => {
    const logs = createLogRecorder();
    const sendMessage = vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT'));
    const { notifier } = make(sendMessage, [OWNER_ID], logs.logger);
    await expect(notifier.emit(booked)).resolves.toBeUndefined();
    await notifier.idle();
    expect(logs.entries.some((entry) => entry.level === 'error')).toBe(true);
    expect(logs.dump()).toContain('"eventKind":"booked"');
    expect(logs.dump()).not.toContain('100002');
  });

  it('a failed attempt that will be retried is only a warning, the give-up is the error', async () => {
    const logs = createLogRecorder();
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue({});
    const { notifier } = make(sendMessage, [OWNER_ID], logs.logger);
    await notifier.emit(booked);
    await notifier.idle();
    expect(logs.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
    expect(logs.entries.some((entry) => entry.level === 'error')).toBe(false);
  });

  it('never throws without a logger either', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('down'));
    const { notifier } = make(sendMessage);
    await expect(notifier.emit(booked)).resolves.toBeUndefined();
    await expect(notifier.idle()).resolves.toBeUndefined();
  });

  it('a pause that fails cannot break anything: the event is dropped and logged', async () => {
    const logs = createLogRecorder();
    const sendMessage = vi.fn().mockRejectedValue(new Error('down'));
    const notifier = createNotifier({ sendMessage } as never, [OWNER_ID], logs.logger, [], {
      sleep: () => Promise.reject(new Error('timer broke')),
    });
    await expect(notifier.emit(booked)).resolves.toBeUndefined();
    await expect(notifier.idle()).resolves.toBeUndefined();
    expect(logs.entries.some((entry) => entry.level === 'error')).toBe(true);
  });
});

describe('createNotifier: markup the Telegram server refuses', () => {
  it('when Telegram rejects the markup (400) the event is re-sent at once, once, as plain text', async () => {
    const rejection = botError(400, "Bad Request: can't parse entities");
    const sendMessage = vi.fn().mockRejectedValueOnce(rejection).mockResolvedValue({});
    const { notifier, sleeps } = make(sendMessage);
    await notifier.emit({ kind: 'failed', job, reason: 'a < b & c' });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([]);
    const [, plain, options, signal] = sendMessage.mock.calls[1] ?? [];
    expect(options).toBeUndefined();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(plain).toContain('Причина: a < b & c');
    expect(plain).not.toContain('<b>');
    expect(plain).not.toContain('&lt;');
  });

  it('a plain-text send that is refused again is logged and dropped, not repeated', async () => {
    const logs = createLogRecorder();
    const sendMessage = vi.fn().mockRejectedValue(botError(400, 'Bad Request'));
    const { notifier, sleeps } = make(sendMessage, [OWNER_ID], logs.logger);
    await expect(notifier.emit(booked)).resolves.toBeUndefined();
    await notifier.idle();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([]);
    expect(logs.entries.filter((entry) => entry.level === 'error')).toHaveLength(1);
  });

  it('a plain-text send that fails on the network is retried as plain text', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(botError(400))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue({});
    const { notifier } = make(sendMessage);
    await notifier.emit(booked);
    await notifier.idle();
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[2]?.[2]).toBeUndefined();
    expect(String(sendMessage.mock.calls[2]?.[1])).not.toContain('<b>');
  });

  it('the markup fallback does not use up a retry', async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(botError(400)).mockRejectedValue(new Error('ECONNRESET'));
    const { notifier, sleeps } = make(sendMessage);
    await notifier.emit(booked);
    await notifier.idle();
    expect(sendMessage).toHaveBeenCalledTimes(1 + sleeps.length + 1);
    expect(sleeps.slice(0, 4)).toEqual([2_000, 5_000, 15_000, 30_000]);
  });
});

describe('createNotifier: delivery is reported once, however late it happens', () => {
  const withHook = (sendMessage: ReturnType<typeof vi.fn>, chats: readonly number[] = [OWNER_ID]) => {
    const delivered: JobEvent[] = [];
    const notifier = createNotifier({ sendMessage } as never, chats, undefined, [], {
      sleep: async () => undefined,
      onDelivered: (event) => void delivered.push(event),
    });
    return { notifier, delivered };
  };

  it('is reported after the first successful send', async () => {
    const { notifier, delivered } = withHook(vi.fn().mockResolvedValue({}));
    await notifier.emit(booked);
    expect(delivered).toEqual([booked]);
  });

  it('is reported once for several chats', async () => {
    const { notifier, delivered } = withHook(vi.fn().mockResolvedValue({}), [OWNER_ID, 43, 44]);
    await notifier.emit(booked);
    await notifier.idle();
    expect(delivered).toHaveLength(1);
  });

  it('is reported when a retry in the background finally gets through, long after the first attempt', async () => {
    const sendMessage = vi.fn();
    for (let i = 0; i < 100; i++) sendMessage.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
    sendMessage.mockResolvedValue({});
    const { notifier, delivered } = withHook(sendMessage);
    await notifier.emit(booked);
    expect(delivered).toEqual([]);
    await notifier.idle();
    expect(sendMessage).toHaveBeenCalledTimes(101);
    expect(delivered).toEqual([booked]);
  });

  it('is never reported for an event that was given up', async () => {
    const { notifier, delivered } = withHook(vi.fn().mockRejectedValue(botError(403, 'Forbidden: bot was blocked by the user')));
    await notifier.emit(booked);
    await notifier.idle();
    expect(delivered).toEqual([]);
  });

  it('is reported when the plain-text fallback gets through', async () => {
    const { notifier, delivered } = withHook(vi.fn().mockRejectedValueOnce(botError(400)).mockResolvedValue({}));
    await notifier.emit(booked);
    expect(delivered).toEqual([booked]);
  });

  it('a hook that throws cannot break delivery and is logged', async () => {
    const logs = createLogRecorder();
    const sendMessage = vi.fn().mockResolvedValue({});
    const notifier = createNotifier({ sendMessage } as never, [OWNER_ID], logs.logger, [], {
      sleep: async () => undefined,
      onDelivered: () => {
        throw new Error('disk full');
      },
    });
    await expect(notifier.emit(booked)).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(logs.entries.some((entry) => entry.level === 'error')).toBe(true);
  });
});

describe('createNotifier: robustness', () => {
  it('a malformed event cannot make emit throw', async () => {
    const logs = createLogRecorder();
    const sendMessage = vi.fn().mockResolvedValue({});
    const { notifier } = make(sendMessage, [OWNER_ID], logs.logger);
    await expect(notifier.emit({ kind: 'armed', job: null } as unknown as JobEvent)).resolves.toBeUndefined();
    expect(logs.entries.some((entry) => entry.level === 'error')).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not put the bot token into the log when an error message contains it', async () => {
    const logs = createLogRecorder();
    const token = '123456:TEST-TOKEN-NOT-REAL';
    const sendMessage = vi.fn().mockRejectedValue(new Error(`request to https://api.telegram.org/bot${token}/sendMessage failed`));
    const notifier = createNotifier({ sendMessage } as never, [OWNER_ID], logs.logger, [token], { sleep: async () => undefined });
    await notifier.emit(booked);
    await notifier.idle();
    expect(logs.dump()).not.toContain(token);
    expect(logs.dump()).toContain('[скрыто]');
  });

  it('works with the default timer too: the retry comes after the planned pause, not before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const sendMessage = vi.fn().mockRejectedValueOnce(botError(502)).mockResolvedValue({});
      const notifier = createNotifier({ sendMessage } as never, [OWNER_ID]);
      await notifier.emit(booked);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await notifier.idle();
      expect(sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the notifier of a real bot', () => {
  it('sends through the bot API to every allowed user (private chat id = user id)', async () => {
    const h = await createHarness({ allowedUserIds: [OWNER_ID, 43] });
    await h.handle.notifier.emit({ kind: 'window_open', job });
    const sent = h.transport.of('sendMessage');
    expect(sent.map((call) => call.payload['chat_id'])).toEqual([OWNER_ID, 43]);
    expect(sent[0]?.payload['parse_mode']).toBe('HTML');
    expect(String(sent[0]?.payload['text'])).toContain('Окно бронирования открылось');
  });

  it('survives a Bot API failure', async () => {
    const h = await createHarness();
    h.transport.failNext('sendMessage', { code: 403, description: 'Forbidden: bot was blocked by the user' });
    await expect(h.handle.notifier.emit({ kind: 'expired', job })).resolves.toBeUndefined();
    expect(h.logs.entries.some((entry) => entry.level === 'error')).toBe(true);
    expect(h.transport.of('sendMessage')).toHaveLength(1);
  });

  it('a result is not lost over a hiccup: a 502 is retried after a pause taken from the injected clock', async () => {
    const h = await createHarness();
    h.clock.sleepMode = 'immediate';
    h.transport.failNext('sendMessage', { code: 502, description: 'Bad Gateway' });
    await h.handle.notifier.emit(booked);
    await vi.waitFor(() => expect(h.transport.of('sendMessage')).toHaveLength(2));
    expect(h.transport.of('sendMessage')[1]?.payload['text']).toBe(formatJobEvent(booked));
    expect(h.clock.sleeps).toEqual([2_000]);
  });

  it('while the network is down the retries wait on the clock and never block emit()', async () => {
    const h = await createHarness();
    h.transport.setOffline(true);
    await expect(h.handle.notifier.emit(booked)).resolves.toBeUndefined();
    expect(h.transport.of('sendMessage')).toHaveLength(1);
    expect(h.clock.sleeps).toEqual([2_000]);
  });

  it('the bot masks its own token in the notifier log', async () => {
    const h = await createHarness();
    h.transport.failNext('sendMessage', { code: 403, description: `Forbidden for ${FAKE_TOKEN}` });
    await h.handle.notifier.emit(booked);
    expect(h.logs.dump()).not.toContain(FAKE_TOKEN);
    expect(h.logs.dump()).toContain('[скрыто]');
  });
});
