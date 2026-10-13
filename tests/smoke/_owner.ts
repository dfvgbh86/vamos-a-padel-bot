/**
 * The people at the phones: scripted Telegram updates (the owner, a stranger) pushed into the fake Bot API, and a
 * reader of the screens the bot shows back (text and inline buttons). The owner only ever presses buttons the bot
 * actually offered, by the callback_data the bot put on them.
 */
import type { FakeTelegram, TelegramCall } from './_fakeTelegram.js';
import { waitFor } from './_wait.js';

export interface Button {
  readonly text: string;
  readonly data: string;
}

export interface Screen {
  readonly call: TelegramCall;
  readonly text: string;
  readonly messageId: number;
  readonly buttons: readonly Button[];
}

type ChatKind = 'private' | 'group';

const userOf = (id: number) => ({ id, is_bot: false, first_name: 'Smoke Player', language_code: 'ru' });

const chatOf = (id: number, kind: ChatKind) =>
  kind === 'private' ? { id, type: 'private', first_name: 'Smoke Player' } : { id: -1_000_000_000 - id, type: 'group', title: 'Smoke group' };

const messageUpdate = (fromId: number, text: string, kind: ChatKind = 'private'): Record<string, unknown> => {
  const command = /^\/\w+/.exec(text);
  return {
    message: {
      message_id: 5,
      date: Math.floor(Date.now() / 1000),
      chat: chatOf(fromId, kind),
      from: userOf(fromId),
      text,
      ...(command === null ? {} : { entities: [{ type: 'bot_command', offset: 0, length: command[0].length }] }),
    },
  };
};

const callbackUpdate = (fromId: number, data: string, messageId: number, queryId: string): Record<string, unknown> => ({
  callback_query: {
    id: queryId,
    from: userOf(fromId),
    chat_instance: 'smoke-instance',
    data,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: chatOf(fromId, 'private'),
      from: { id: 7_000_001, is_bot: true, first_name: 'Padel Smoke Bot', username: 'padel_smoke_bot' },
      text: 'previous screen',
    },
  },
});

const buttonsOf = (payload: Record<string, unknown>): Button[] => {
  const markup = payload['reply_markup'] as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((button) => ({ text: button.text, data: button.callback_data ?? '' }));
};

export interface Owner {
  /** The newest screen (message or edit) the bot showed this chat, with the id of the message it lives in. */
  screen(): Screen | undefined;
  /** Types a text or command and waits for the bot's next screen for the owner. */
  say(text: string, timeoutMs?: number): Promise<Screen>;
  /** Presses the button of the current screen whose callback_data matches, and waits for the next screen. */
  press(data: RegExp, timeoutMs?: number): Promise<Screen>;
  /** Presses a button and waits until a screen shows `text`. */
  pressUntil(data: RegExp, text: string, timeoutMs?: number): Promise<Screen>;
}

export const createOwner = (telegram: FakeTelegram, ownerId: number): Owner => {
  let queryCount = 0;

  const screens = (): Screen[] =>
    telegram
      .screens()
      .filter((call) => Number(call.payload['chat_id']) === ownerId)
      .map((call) => ({ call, text: String(call.payload['text'] ?? ''), messageId: call.messageId ?? 0, buttons: buttonsOf(call.payload) }));

  const latest = (): Screen | undefined => screens().at(-1);

  const nextScreen = async (after: number, timeoutMs: number, accept: (screen: Screen) => boolean = () => true): Promise<Screen> =>
    waitFor('the next screen of the bot', () => screens().find((screen) => screen.call.seq > after && accept(screen)), timeoutMs);

  const lastSeq = (): number => telegram.calls.at(-1)?.seq ?? 0;

  const act = async (update: Record<string, unknown>, timeoutMs: number, accept?: (screen: Screen) => boolean): Promise<Screen> => {
    const after = lastSeq();
    telegram.pushUpdate(update);
    return nextScreen(after, timeoutMs, accept);
  };

  const pressed = (data: RegExp): { readonly update: Record<string, unknown> } => {
    const current = latest();
    if (current === undefined) throw new Error('the bot has not shown anything yet');
    const match = current.buttons.find((button) => data.test(button.data));
    if (match === undefined) {
      throw new Error(`no button matches ${String(data)} on "${current.text.slice(0, 60)}"; buttons: ${current.buttons.map((b) => b.data).join(' | ')}`);
    }
    queryCount += 1;
    return { update: callbackUpdate(ownerId, match.data, current.messageId, `smoke-query-${queryCount}`) };
  };

  return {
    screen: latest,
    say: (text, timeoutMs = 30_000) => act(messageUpdate(ownerId, text), timeoutMs),
    press: (data, timeoutMs = 30_000) => act(pressed(data).update, timeoutMs),
    pressUntil: (data, text, timeoutMs = 30_000) => act(pressed(data).update, timeoutMs, (screen) => screen.text.includes(text)),
  };
};

/** Updates a stranger, or the owner in the wrong place, may send. */
export const strangerUpdates = {
  privateMessage: (strangerId: number, text: string): Record<string, unknown> => messageUpdate(strangerId, text),
  buttonPress: (strangerId: number, data: string, queryId: string): Record<string, unknown> => callbackUpdate(strangerId, data, 1001, queryId),
  /** The owner's own id, but in a group chat: not a private conversation. */
  ownerInGroup: (ownerId: number, text: string): Record<string, unknown> => messageUpdate(ownerId, text, 'group'),
};
