import type { Bot, Transformer } from 'grammy';
import type { Clock, JobEvent, JobEventSink, JobService } from '../contracts.js';
import type { OpenRule } from '../sniper/openTime.js';

/** Structural subset of pino's logger: the bot never passes message text, tokens or request bodies in `obj`. */
export interface TelegramLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const noop = (): void => undefined;

export const SILENT_LOGGER: TelegramLogger = { debug: noop, info: noop, warn: noop, error: noop };

export interface TelegramBotDeps {
  readonly token: string;
  /** Telegram user ids of the owner(s). Must be non-empty: an empty list never means "everyone". */
  readonly allowedUserIds: readonly number[];
  readonly service: JobService;
  readonly clock: Clock;
  readonly logger: TelegramLogger;
  /**
   * When windows open. Must be the rule the JobService is built with, otherwise the date list and the "opens at"
   * labels show a different instant than the one the job is armed for. Defaults to the service's default rule.
   */
  readonly openRule?: OpenRule;
  /**
   * Tests only: Bot API root on this machine (http, host exactly 127.0.0.1, localhost or [::1]); anything else is refused
   * at construction, because the token travels to this address. Absent: api.telegram.org.
   */
  readonly apiRoot?: string;
  /** Installed on `bot.api`; tests use it as a fake transport. */
  readonly apiTransformer?: Transformer;
  /** Called when connecting or long polling fails after start() has already returned (conflict, revoked token). */
  readonly onFatalError?: (error: unknown) => void;
  /** Called once per event after Telegram accepted it (see NotifierOptions.onDelivered). */
  readonly onDelivered?: (event: JobEvent) => void;
}

export interface NotifierOptions {
  /** Waits between delivery attempts; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called once per event after Telegram accepted it (for the first chat that did), however late that was. */
  readonly onDelivered?: (event: JobEvent) => void;
}

export interface JobNotifier extends JobEventSink {
  /** Resolves once no event is waiting for a retry any more (orderly shutdown, tests). */
  idle(): Promise<void>;
}

export interface TelegramBotHandle {
  readonly bot: Bot;
  /** Works without start(): sending needs no polling, so booking results reach the owner even while polling is down. */
  readonly notifier: JobNotifier;
  /**
   * Connects and starts long polling, but never waits for Telegram for more than STARTUP_DEADLINE_MS: when the
   * network is down at boot, grammY would retry for ever, so start() returns at the deadline and the bot keeps
   * connecting in the background. Rejects only when Telegram refuses the token within that time. Failures after
   * start() has returned go to the log and to `onFatalError`. Start the sniper first: nothing that books may ever
   * wait for, or depend on, this call.
   *
   * Updates are handled one at a time: while a slow service call of the owner's /new, /cancel or /jobs runs (up to
   * 30 s) a /stop typed meanwhile is read only afterwards.
   */
  start(): Promise<void>;
  /** Stops polling and any background connecting. Never rejects over a failing network. */
  stop(): Promise<void>;
}
