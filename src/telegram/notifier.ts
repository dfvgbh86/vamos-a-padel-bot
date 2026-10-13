import { GrammyError, type Api } from 'grammy';
import type { JobEvent } from '../contracts.js';
import { formatJobEvent } from './eventText.js';
import { describeError, htmlToPlain } from './text.js';
import { SILENT_LOGGER, type JobNotifier, type NotifierOptions, type TelegramLogger } from './types.js';

export { formatJobEvent } from './eventText.js';

/** Per attempt. The first attempt of every chat is awaited by emit(), which the sniper's serial event queue awaits. */
const SEND_TIMEOUT_MS = 10_000;
/**
 * Pauses before the 2nd, 3rd, ... attempt for events the owner must see: a quick start, then once a minute for six
 * hours (a provider or DNS problem can last that long; a result must not be lost over it). Past that, or after a
 * restart, the persistent ledger of delivered results (see sniper/announce.ts) takes over.
 */
const RESULT_RETRY_PAUSES_MS: readonly number[] = [
  2_000,
  5_000,
  15_000,
  30_000,
  ...Array.from({ length: 360 }, () => 60_000),
];
/** Progress messages matter less: a short effort, then they are dropped. */
const ROUTINE_RETRY_PAUSES_MS: readonly number[] = [2_000, 5_000];
const ROUTINE_KINDS: ReadonlySet<JobEvent['kind']> = new Set(['armed', 'preflight_ok', 'window_open']);
/** A flood-control wait longer than this is not worth waiting for: the event is dropped and logged. */
const MAX_RETRY_AFTER_MS = 60_000;

const HTML_OPTIONS = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;

/** grammY ships its own AbortSignal typing, which differs from the global one only in type declarations. */
const sendDeadline = (): Parameters<Api['sendMessage']>[3] => AbortSignal.timeout(SEND_TIMEOUT_MS) as never;

const isParseError = (error: unknown): boolean => error instanceof GrammyError && error.error_code === 400;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const once = (action: () => void): (() => void) => {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    action();
  };
};

interface Delivery {
  readonly chatId: number;
  /** Called once per event, when the first chat accepted the message. */
  readonly onSent: () => void;
  readonly html: string;
  readonly kind: JobEvent['kind'];
  readonly pauses: readonly number[];
  /** Telegram refused the markup: from now on the event goes out as plain text. */
  plain: boolean;
  /** Telegram accepted the message. */
  sent: boolean;
  /** Failed attempts that count against the retry budget (the markup fallback does not). */
  failures: number;
}

/**
 * The pause before trying again, or null when trying again is pointless: a refusal by Telegram (bot blocked, wrong
 * chat, bad request) never turns into success. Network errors, deadlines and 5xx are transient; 429 says how long to wait.
 */
const pauseBeforeRetry = (error: unknown, scheduledMs: number): number | null => {
  if (!(error instanceof GrammyError)) return scheduledMs;
  if (error.error_code >= 500) return scheduledMs;
  if (error.error_code !== 429) return null;
  const askedMs = (error.parameters.retry_after ?? 0) * 1000;
  return askedMs > MAX_RETRY_AFTER_MS ? null : Math.max(scheduledMs, askedMs);
};

/**
 * Sends job events to the owner chats and never throws. A result must not vanish over a hiccup, so a transient
 * failure is retried a bounded number of times: the first attempt is awaited, the retries run in the background
 * (they never hold up the next event; a retried event may therefore arrive after a later one). A send that timed out
 * but did reach Telegram can show up twice: better than never. If Telegram rejected the HTML the event is sent as
 * plain text, so a result is never lost over markup either.
 */
export const createNotifier = (
  api: Pick<Api, 'sendMessage'>,
  ownerChatIds: readonly number[],
  logger: TelegramLogger = SILENT_LOGGER,
  secrets: readonly string[] = [],
  options: NotifierOptions = {},
): JobNotifier => {
  const sleep = options.sleep ?? realSleep;
  const pending = new Set<Promise<void>>();

  const logFailure = (level: 'warn' | 'error', delivery: Delivery, error: unknown, msg: string, extra: object = {}): void => {
    logger[level]({ eventKind: delivery.kind, ...extra, ...describeError(error, secrets) }, msg);
  };

  /** One attempt: null when it is over (sent, or given up), else the pause before the next attempt. */
  const attempt = async (delivery: Delivery): Promise<number | null> => {
    try {
      const text = delivery.plain ? htmlToPlain(delivery.html) : delivery.html;
      await api.sendMessage(delivery.chatId, text, delivery.plain ? undefined : HTML_OPTIONS, sendDeadline());
      delivery.sent = true;
      delivery.onSent();
      return null;
    } catch (error) {
      if (!delivery.plain && isParseError(error)) {
        delivery.plain = true;
        logFailure('warn', delivery, error, 'telegram: markup rejected, sending the event as plain text');
        return attempt(delivery);
      }
      delivery.failures += 1;
      const scheduled = delivery.pauses[delivery.failures - 1];
      const pause = scheduled === undefined ? null : pauseBeforeRetry(error, scheduled);
      if (pause === null) {
        logFailure('error', delivery, error, 'telegram: notification dropped', { attempts: delivery.failures });
        return null;
      }
      logFailure('warn', delivery, error, 'telegram: notification failed, will retry', { attempts: delivery.failures, retryInMs: pause });
      return pause;
    }
  };

  const retryInBackground = async (delivery: Delivery, firstPause: number): Promise<void> => {
    try {
      let pause: number | null = firstPause;
      while (pause !== null) {
        await sleep(pause);
        pause = await attempt(delivery);
      }
    } catch (error) {
      logFailure('error', delivery, error, 'telegram: notification retry aborted');
    }
  };

  const reportDelivered = (event: JobEvent): void => {
    try {
      options.onDelivered?.(event);
    } catch (error) {
      logger.error({ eventKind: event.kind, ...describeError(error, secrets) }, 'telegram: recording a delivery failed');
    }
  };

  const track = (work: Promise<void>): void => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };

  return {
    emit: async (event) => {
      try {
        const html = formatJobEvent(event);
        const pauses = ROUTINE_KINDS.has(event.kind) ? ROUTINE_RETRY_PAUSES_MS : RESULT_RETRY_PAUSES_MS;
        const onSent = once(() => reportDelivered(event));
        for (const chatId of ownerChatIds) {
          const delivery: Delivery = { chatId, onSent, html, kind: event.kind, pauses, plain: false, sent: false, failures: 0 };
          const pause = await attempt(delivery);
          if (pause !== null) track(retryInBackground(delivery, pause));
        }
      } catch (error) {
        logger.error({ eventKind: event.kind, ...describeError(error, secrets) }, 'telegram: could not format or send an event');
      }
    },
    idle: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
};
