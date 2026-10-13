/**
 * Telegram test harness: a fake Bot API transport (a grammY transformer that records every call and never
 * touches the network), synthetic updates, and a small "owner at the phone" driver.
 */
import { HttpError, type Transformer } from 'grammy';
import type { Update } from 'grammy/types';
import type { OpenRule } from '../../src/sniper/openTime.js';
import { createTelegramBot } from '../../src/telegram/bot.js';
import type { TelegramBotHandle, TelegramLogger } from '../../src/telegram/types.js';
import { FakeClock, FakeJobService } from './_fakes.js';

export const FAKE_TOKEN = '123456:TEST-TOKEN-NOT-REAL';
export const OWNER_ID = 42;
export const STRANGER_ID = 777;
export const BOT_ID = 999_001;

export interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

export interface Button {
  readonly text: string;
  readonly data: string;
}

export interface Screen {
  readonly method: 'sendMessage' | 'editMessageText';
  readonly text: string;
  readonly buttons: readonly Button[];
  readonly parseMode: unknown;
}

interface Failure {
  readonly code: number;
  readonly description: string;
}

export interface FakeTransport {
  readonly calls: ApiCall[];
  readonly transformer: Transformer;
  /** The next call of `method` fails with a Bot API error. */
  failNext(method: string, failure: Failure): void;
  /** While offline every call fails like a dead network connection (an HttpError); the call is still recorded. */
  setOffline(offline: boolean): void;
  /** Updates returned by successive getUpdates calls that carry an abort signal. */
  queueUpdates(...batches: Update[][]): void;
  of(method: string): ApiCall[];
  clear(): void;
}

const botUser = {
  id: BOT_ID,
  is_bot: true,
  first_name: 'Padel Test Bot',
  username: 'padel_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

export const createFakeTransport = (): FakeTransport => {
  const calls: ApiCall[] = [];
  const failures = new Map<string, Failure[]>();
  const batches: Update[][] = [];
  let messageId = 1000;
  let offline = false;

  const transformer: Transformer = async (_prev, method, payload, signal) => {
    const body = payload as unknown as Record<string, unknown>;
    calls.push({ method, payload: { ...body } });

    if (offline) throw new HttpError(`Network request for '${method}' failed!`, new Error('ECONNREFUSED'));

    const failure = failures.get(method)?.shift();
    if (failure !== undefined) {
      return { ok: false, error_code: failure.code, description: failure.description } as never;
    }

    if (method === 'getUpdates') {
      if (signal === undefined) return { ok: true, result: [] } as never;
      const next = batches.shift();
      if (next !== undefined) return { ok: true, result: next } as never;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }

    const result: unknown =
      method === 'getMe'
        ? botUser
        : method === 'sendMessage'
          ? {
              message_id: (messageId += 1),
              date: 0,
              chat: { id: Number(body['chat_id']), type: 'private', first_name: 'Test Player' },
              text: String(body['text'] ?? ''),
            }
          : true;
    return { ok: true, result } as never;
  };

  return {
    calls,
    transformer,
    failNext: (method, failure) => {
      failures.set(method, [...(failures.get(method) ?? []), failure]);
    },
    setOffline: (value) => {
      offline = value;
    },
    queueUpdates: (...more) => {
      batches.push(...more);
    },
    of: (method) => calls.filter((call) => call.method === method),
    clear: () => {
      calls.length = 0;
    },
  };
};

export interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly obj: object;
  readonly msg: string | undefined;
}

export const createLogRecorder = (): { logger: TelegramLogger; entries: LogEntry[]; dump: () => string } => {
  const entries: LogEntry[] = [];
  const at = (level: LogEntry['level']) => (obj: object, msg?: string) => {
    entries.push({ level, obj, msg });
  };
  return {
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    entries,
    dump: () => JSON.stringify(entries),
  };
};

// ---------------------------------------------------------------------------------------------
// Synthetic updates
// ---------------------------------------------------------------------------------------------

const from = (id: number) => ({ id, is_bot: false, first_name: 'Test Player', language_code: 'ru' });

export type ChatKind = 'private' | 'group' | 'supergroup' | 'channel';

export const chatOf = (id: number, kind: ChatKind = 'private') =>
  kind === 'private' ? { id, type: 'private' as const, first_name: 'Test Player' } : { id: -1_000_000 - id, type: kind, title: 'Test chat' };

let updateId = 1;
const nextUpdateId = (): number => (updateId += 1);

interface Origin {
  readonly fromId?: number;
  readonly chat?: ChatKind;
}

const messageBody = (text: string, origin: Origin) => {
  const fromId = origin.fromId ?? OWNER_ID;
  const command = /^\/\w+(@\w+)?/.exec(text);
  return {
    message_id: 5,
    date: 0,
    chat: chatOf(fromId, origin.chat),
    from: from(fromId),
    text,
    ...(command === null ? {} : { entities: [{ type: 'bot_command', offset: 0, length: command[0].length }] }),
  };
};

const asUpdate = (value: object): Update => ({ update_id: nextUpdateId(), ...value }) as unknown as Update;

export const messageUpdate = (text: string, origin: Origin = {}): Update => asUpdate({ message: messageBody(text, origin) });

export const callbackUpdate = (data: string, origin: Origin & { messageId?: number } = {}): Update => {
  const fromId = origin.fromId ?? OWNER_ID;
  return asUpdate({
    callback_query: {
      id: `cb-${updateId}`,
      from: from(fromId),
      chat_instance: 'test-instance',
      data,
      message: {
        message_id: origin.messageId ?? 1001,
        date: 0,
        chat: chatOf(fromId, origin.chat),
        from: { ...botUser },
        text: 'previous screen',
      },
    },
  });
};

// ---------------------------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------------------------

export interface HarnessOptions {
  readonly allowedUserIds?: readonly number[];
  readonly service?: FakeJobService;
  readonly clock?: FakeClock;
  readonly openRule?: OpenRule;
}

export interface Harness {
  readonly handle: TelegramBotHandle;
  readonly transport: FakeTransport;
  readonly service: FakeJobService;
  readonly clock: FakeClock;
  readonly logs: ReturnType<typeof createLogRecorder>;
  /** Feeds a raw update to the bot. */
  send(update: Update): Promise<void>;
  /** The owner types a message or command. */
  say(text: string, origin?: Origin): Promise<void>;
  /** The owner taps the first button of the current screen whose label contains `label`. */
  press(label: string | RegExp): Promise<void>;
  /** The owner taps a button with this exact callback_data (possibly forged). */
  pressData(data: string, origin?: Origin & { messageId?: number }): Promise<void>;
  /** Latest message the bot sent or edited. */
  screen(): Screen;
  /** Every message the bot sent or edited, oldest first. */
  screens(): Screen[];
  buttons(): readonly Button[];
  answers(): ApiCall[];
}

const keyboardOf = (payload: Record<string, unknown>): Button[] => {
  const markup = payload['reply_markup'] as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((button) => ({ text: button.text, data: button.callback_data ?? '' }));
};

const toScreen = (call: ApiCall): Screen => ({
  method: call.method as Screen['method'],
  text: String(call.payload['text'] ?? ''),
  buttons: keyboardOf(call.payload),
  parseMode: call.payload['parse_mode'],
});

export const createHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const transport = createFakeTransport();
  const logs = createLogRecorder();
  const service = options.service ?? new FakeJobService();
  const clock = options.clock ?? new FakeClock();
  const handle = createTelegramBot({
    token: FAKE_TOKEN,
    allowedUserIds: options.allowedUserIds ?? [OWNER_ID],
    service,
    clock,
    logger: logs.logger,
    apiTransformer: transport.transformer,
    ...(options.openRule === undefined ? {} : { openRule: options.openRule }),
  });
  await handle.bot.init();
  transport.clear();

  const screens = (): Screen[] =>
    transport.calls.filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText').map(toScreen);

  const screen = (): Screen => {
    const all = screens();
    const last = all[all.length - 1];
    if (last === undefined) throw new Error('the bot has not sent or edited any message');
    return last;
  };

  const send = (update: Update): Promise<void> => handle.bot.handleUpdate(update);

  const pressData: Harness['pressData'] = (data, origin) => send(callbackUpdate(data, origin));

  return {
    handle,
    transport,
    service,
    clock,
    logs,
    send,
    say: (text, origin) => send(messageUpdate(text, origin)),
    pressData,
    press: async (label) => {
      const current = screen();
      const match = current.buttons.find((button) => (typeof label === 'string' ? button.text.includes(label) : label.test(button.text)));
      if (match === undefined) {
        throw new Error(`no button ${String(label)} on the screen; buttons: ${current.buttons.map((button) => button.text).join(' | ')}`);
      }
      await pressData(match.data);
    },
    screen,
    screens,
    buttons: () => screen().buttons,
    answers: () => transport.of('answerCallbackQuery'),
  };
};
