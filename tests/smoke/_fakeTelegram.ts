/**
 * A fake Telegram Bot API on a real loopback socket (127.0.0.1, ephemeral port). The bot reaches it through
 * TELEGRAM_API_ROOT. getUpdates is a real long poll over a scripted queue (`pushUpdate`); every call is recorded.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TelegramCall {
  readonly seq: number;
  readonly method: string;
  readonly payload: Record<string, unknown>;
  /** The token in the URL path was the configured one. */
  readonly tokenOk: boolean;
  /** Id of the message a sendMessage created or an editMessageText changed. */
  messageId: number | null;
}

export interface FakeTelegram {
  readonly origin: string;
  readonly calls: readonly TelegramCall[];
  /** Appends an update to the queue (the fake sets `update_id`) and wakes a waiting getUpdates. */
  pushUpdate(update: Record<string, unknown>): void;
  of(method: string): TelegramCall[];
  /** Updates the bot has received but not confirmed (by asking getUpdates for a later offset). */
  unconfirmed(): number;
  /** Messages and edits the bot produced, in order. */
  screens(): TelegramCall[];
  close(): Promise<void>;
}

interface Waiter {
  readonly offset: number;
  readonly limit: number;
  readonly response: ServerResponse;
  readonly timer: NodeJS.Timeout;
}

const BOT_USER = {
  id: 7_000_001,
  is_bot: true,
  first_name: 'Padel Smoke Bot',
  username: 'padel_smoke_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

/** Longest a getUpdates is held open (the bot asks for 30 s). */
const MAX_HOLD_MS = 25_000;

const reply = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const chatOf = (payload: Record<string, unknown>): { id: number; type: 'private'; first_name: string } => ({
  id: Number(payload['chat_id']),
  type: 'private',
  first_name: 'Smoke Player',
});

export const createFakeTelegram = async (token: string): Promise<FakeTelegram> => {
  const calls: TelegramCall[] = [];
  const queue: Record<string, unknown>[] = [];
  const waiters: Waiter[] = [];
  let nextUpdateId = 1;
  let nextMessageId = 1000;
  let nextSeq = 1;

  const pending = (offset: number, limit: number): Record<string, unknown>[] =>
    queue.filter((update) => Number(update['update_id']) >= offset).slice(0, limit);

  const flush = (): void => {
    for (const waiter of [...waiters]) {
      const ready = pending(waiter.offset, waiter.limit);
      if (ready.length === 0) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      reply(waiter.response, 200, { ok: true, result: ready });
    }
  };

  const getUpdates = (payload: Record<string, unknown>, response: ServerResponse): void => {
    const offset = Number(payload['offset'] ?? 0);
    const limit = Number(payload['limit'] ?? 100);
    const holdMs = Math.min(Number(payload['timeout'] ?? 0) * 1000, MAX_HOLD_MS);
    // Telegram forgets every update below the offset: they are confirmed.
    for (let index = queue.length - 1; index >= 0; index--) {
      if (Number(queue[index]?.['update_id']) < offset) queue.splice(index, 1);
    }
    const ready = pending(offset, limit);
    if (ready.length > 0 || holdMs <= 0) {
      reply(response, 200, { ok: true, result: ready });
      return;
    }
    const forget = (waiter: Waiter): void => {
      clearTimeout(waiter.timer);
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
    };
    const timer = setTimeout(() => {
      forget(waiter);
      reply(response, 200, { ok: true, result: [] });
    }, holdMs);
    const waiter: Waiter = { offset, limit, response, timer };
    waiters.push(waiter);
    response.on('close', () => forget(waiter));
  };

  const message = (payload: Record<string, unknown>, messageId: number): Record<string, unknown> => ({
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
    chat: chatOf(payload),
    from: BOT_USER,
    text: String(payload['text'] ?? ''),
  });

  const answer = (method: string, payload: Record<string, unknown>): unknown => {
    switch (method) {
      case 'getMe':
        return BOT_USER;
      case 'sendMessage':
        return message(payload, (nextMessageId += 1));
      case 'editMessageText':
        return message(payload, Number(payload['message_id'] ?? (nextMessageId += 1)));
      case 'deleteWebhook':
      case 'setMyCommands':
      case 'answerCallbackQuery':
      case 'deleteMessage':
        return true;
      default:
        return undefined;
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const payload = await readJson(request);
    const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(new URL(request.url ?? '/', 'http://telegram.local').pathname);
    const method = match?.[2] ?? 'unknown';
    const tokenOk = match?.[1] === token;
    const call: TelegramCall = { seq: nextSeq++, method, payload, tokenOk, messageId: null };
    calls.push(call);
    if (!tokenOk) {
      reply(response, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
      return;
    }
    if (method === 'getUpdates') {
      getUpdates(payload, response);
      return;
    }
    const result = answer(method, payload);
    if (result === undefined) {
      reply(response, 404, { ok: false, error_code: 404, description: 'Not Found: the fake does not know this method' });
      return;
    }
    if (typeof result === 'object' && result !== null && 'message_id' in result) call.messageId = Number(result.message_id);
    reply(response, 200, { ok: true, result });
  };

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    calls,
    pushUpdate: (update) => {
      queue.push({ update_id: nextUpdateId++, ...update });
      flush();
    },
    of: (method) => calls.filter((call) => call.method === method),
    unconfirmed: () => queue.length,
    screens: () => calls.filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText'),
    close: async () => {
      for (const waiter of waiters.splice(0)) clearTimeout(waiter.timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
