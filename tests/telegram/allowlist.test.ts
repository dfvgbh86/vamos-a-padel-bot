import type { Update } from 'grammy/types';
import { describe, expect, it } from 'vitest';
import { createTelegramBot } from '../../src/telegram/bot.js';
import { FakeClock, FakeJobService } from './_fakes.js';
import {
  callbackUpdate,
  createFakeTransport,
  createHarness,
  createLogRecorder,
  chatOf,
  FAKE_TOKEN,
  messageUpdate,
  OWNER_ID,
  STRANGER_ID,
} from './_harness.js';

let counter = 9_000;
const raw = (value: object): Update => ({ update_id: (counter += 1), ...value }) as unknown as Update;

const user = (id: number) => ({ id, is_bot: false, first_name: 'Test Player' });
const stamp = { message_id: 3, date: 0 };

/** Every kind of update Telegram can deliver, sent by `id`, in a chat of the given kind where one applies. */
const everyUpdateKind = (id: number): [string, Update][] => [
  ['edited_message', raw({ edited_message: { ...stamp, chat: chatOf(id), from: user(id), text: '/new', edit_date: 1 } })],
  ['channel_post', raw({ channel_post: { ...stamp, chat: chatOf(id, 'channel'), text: '/new' } })],
  ['edited_channel_post', raw({ edited_channel_post: { ...stamp, chat: chatOf(id, 'channel'), text: '/new', edit_date: 1 } })],
  ['inline_query', raw({ inline_query: { id: 'q1', from: user(id), query: 'hello', offset: '' } })],
  ['chosen_inline_result', raw({ chosen_inline_result: { result_id: 'r1', from: user(id), query: 'hello' } })],
  [
    'callback_query from an inline message',
    raw({ callback_query: { id: 'c1', from: user(id), chat_instance: 'x', inline_message_id: 'abc', data: 'n:x:aaaaaa' } }),
  ],
  ['shipping_query', raw({ shipping_query: { id: 's1', from: user(id), invoice_payload: 'p', shipping_address: {} } })],
  ['pre_checkout_query', raw({ pre_checkout_query: { id: 'p1', from: user(id), currency: 'EUR', total_amount: 100, invoice_payload: 'p' } })],
  ['poll_answer', raw({ poll_answer: { poll_id: 'p', user: user(id), option_ids: [0] } })],
  ['my_chat_member', raw({ my_chat_member: { chat: chatOf(id), from: user(id), date: 0, old_chat_member: {}, new_chat_member: {} } })],
  ['chat_member', raw({ chat_member: { chat: chatOf(id), from: user(id), date: 0, old_chat_member: {}, new_chat_member: {} } })],
  ['chat_join_request', raw({ chat_join_request: { chat: chatOf(id), from: user(id), user_chat_id: id, date: 0 } })],
  ['business_message', raw({ business_message: { ...stamp, chat: chatOf(id), from: user(id), text: '/stop', business_connection_id: 'b' } })],
  ['message_reaction', raw({ message_reaction: { chat: chatOf(id), message_id: 1, user: user(id), date: 0, old_reaction: [], new_reaction: [] } })],
];

describe('construction: an empty allowlist never means "everyone"', () => {
  const build = (allowedUserIds: readonly number[]) =>
    createTelegramBot({
      token: FAKE_TOKEN,
      allowedUserIds,
      service: new FakeJobService(),
      clock: new FakeClock(),
      logger: createLogRecorder().logger,
    });

  it('throws for an empty list', () => {
    expect(() => build([])).toThrow(/at least one/);
  });

  it.each([[0], [-5], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [2 ** 60]])('throws for the invalid id %s', (bad) => {
    expect(() => build([OWNER_ID, bad])).toThrow(/positive integer/);
  });

  it('throws for ids that are not numbers at all', () => {
    expect(() => build(['42' as unknown as number])).toThrow(/positive integer/);
  });

  it('throws for a missing token', () => {
    expect(() => createTelegramBot({ token: '  ', allowedUserIds: [OWNER_ID], service: new FakeJobService(), clock: new FakeClock(), logger: createLogRecorder().logger })).toThrow(/token/);
  });

  it('accepts a valid list and constructs without any network call', () => {
    const transport = createFakeTransport();
    const handle = createTelegramBot({
      token: FAKE_TOKEN,
      allowedUserIds: [OWNER_ID, 43],
      service: new FakeJobService(),
      clock: new FakeClock(),
      logger: createLogRecorder().logger,
      apiTransformer: transport.transformer,
    });
    expect(handle.bot).toBeDefined();
    expect(transport.calls).toHaveLength(0);
  });
});

describe('allowlist middleware: strangers get silence', () => {
  it('ignores a stranger command: no reply, no API call at all, no service call', async () => {
    const h = await createHarness();
    await h.say('/start', { fromId: STRANGER_ID });
    await h.say('/new', { fromId: STRANGER_ID });
    await h.say('/stop', { fromId: STRANGER_ID });
    expect(h.transport.calls).toEqual([]);
    expect(h.service.calls).toEqual([]);
  });

  it('ignores stranger plain text and unknown commands too', async () => {
    const h = await createHarness();
    await h.say('hello?', { fromId: STRANGER_ID });
    await h.say('/definitely_not_a_command', { fromId: STRANGER_ID });
    expect(h.transport.calls).toEqual([]);
  });

  it('ignores a stranger callback query: not even answerCallbackQuery', async () => {
    const h = await createHarness();
    await h.pressData('n:y:abcdef', { fromId: STRANGER_ID });
    await h.pressData('x:y:abcdef', { fromId: STRANGER_ID });
    expect(h.transport.calls).toEqual([]);
    expect(h.service.createJobCalls).toEqual([]);
    expect(h.service.cancelCalls).toEqual([]);
  });

  it('ignores every other update kind from a stranger', async () => {
    const h = await createHarness();
    for (const [, update] of everyUpdateKind(STRANGER_ID)) await h.send(update);
    expect(h.transport.calls).toEqual([]);
  });

  it('ignores every other update kind even from the owner: only messages and button presses are processed', async () => {
    const h = await createHarness();
    for (const [, update] of everyUpdateKind(OWNER_ID)) await h.send(update);
    expect(h.transport.calls).toEqual([]);
    expect(h.service.calls).toEqual([]);
  });

  it('ignores an update without a sender', async () => {
    const h = await createHarness();
    await h.send(raw({ message: { ...stamp, chat: chatOf(OWNER_ID), text: '/stop', entities: [{ type: 'bot_command', offset: 0, length: 5 }] } }));
    expect(h.transport.calls).toEqual([]);
    expect(h.service.calls).not.toContain('stopAll');
  });

  it.each([
    ['a message without chat and sender', { message: { message_id: 1, date: 0, text: '/stop' } }],
    ['a message without chat', { message: { message_id: 1, date: 0, from: { id: OWNER_ID, is_bot: false, first_name: 'x' }, text: '/stop' } }],
    ['a callback query without sender', { callback_query: { id: 'c', chat_instance: 'x', data: 'n:y:abcdef' } }],
    ['an empty update', {}],
  ])('ignores a malformed update: %s', async (_label, body) => {
    const h = await createHarness();
    await expect(h.send(raw(body))).resolves.toBeUndefined();
    expect(h.transport.calls).toEqual([]);
    expect(h.service.calls).toEqual([]);
  });

  it('works with several allowed ids, and still ignores everyone else', async () => {
    const h = await createHarness({ allowedUserIds: [OWNER_ID, 43] });
    await h.say('/help', { fromId: 43 });
    expect(h.transport.of('sendMessage')).toHaveLength(1);
    h.transport.clear();
    await h.say('/help', { fromId: 44 });
    expect(h.transport.calls).toEqual([]);
  });
});

describe('allowlist middleware: only private chats', () => {
  it.each(['group', 'supergroup', 'channel'] as const)('ignores the owner writing in a %s', async (kind) => {
    const h = await createHarness();
    await h.say('/stop', { chat: kind });
    await h.say('/new', { chat: kind });
    expect(h.transport.calls).toEqual([]);
    expect(h.service.calls).toEqual([]);
  });

  it.each(['group', 'supergroup', 'channel'] as const)('ignores the owner pressing a button of a message in a %s', async (kind) => {
    const h = await createHarness();
    await h.pressData('n:y:abcdef', { chat: kind });
    expect(h.transport.calls).toEqual([]);
    expect(h.service.createJobCalls).toEqual([]);
  });

  it('ignores a private-looking chat whose id is not the sender id', async () => {
    const h = await createHarness();
    const update = messageUpdate('/stop');
    (update.message as unknown as { chat: { id: number } }).chat.id = 1234;
    await h.send(update);
    expect(h.transport.calls).toEqual([]);
    expect(h.service.calls).not.toContain('stopAll');
  });

  it.each(['group', 'supergroup', 'channel'] as const)('ignores a %s whose id equals the owner id (the chat type alone decides)', async (kind) => {
    const h = await createHarness();
    const update = messageUpdate('/stop');
    const chat = update.message?.chat as unknown as { id: number; type: string };
    chat.id = OWNER_ID;
    chat.type = kind;
    await h.send(update);
    const press = callbackUpdate('n:y:abcdef');
    const pressed = press.callback_query?.message?.chat as unknown as { id: number; type: string };
    pressed.id = OWNER_ID;
    pressed.type = kind;
    await h.send(press);
    expect(h.transport.calls).toEqual([]);
    expect(h.service.calls).toEqual([]);
  });

  it('serves the owner in a private chat', async () => {
    const h = await createHarness();
    await h.say('/help');
    expect(h.transport.of('sendMessage')).toHaveLength(1);
  });

  it('answers a button press of the owner in the private chat', async () => {
    const h = await createHarness();
    await h.pressData('n:y:abcdef');
    expect(h.answers()).toHaveLength(1);
  });
});

describe('allowlist middleware: logging of rejected updates', () => {
  it('logs the kind and ids but never the message text', async () => {
    const h = await createHarness();
    await h.say('SECRET-TEXT-12345 please book for me', { fromId: STRANGER_ID });
    await h.pressData('n:y:SECRETDATA', { fromId: STRANGER_ID });
    const log = h.logs.dump();
    expect(h.logs.entries.length).toBeGreaterThanOrEqual(2);
    expect(log).toContain('"updateType":"message"');
    expect(log).toContain(String(STRANGER_ID));
    expect(log).not.toContain('SECRET-TEXT');
    expect(log).not.toContain('SECRETDATA');
    expect(log).not.toContain('book for me');
  });

  it('logs rejected updates at warn level', async () => {
    const h = await createHarness();
    await h.say('/start', { fromId: STRANGER_ID });
    expect(h.logs.entries.every((entry) => entry.level === 'warn')).toBe(true);
  });
});

describe('error containment behind the guard', () => {
  it('a failing handler does not escape and the owner gets a short notice', async () => {
    const service = new FakeJobService();
    service.listJobs = () => {
      throw new Error('boom with SECRET-INTERNALS');
    };
    const h = await createHarness({ service });
    await expect(h.say('/jobs')).resolves.toBeUndefined();
    expect(h.screen().text).toContain('ошибка сервиса');
    expect(h.screen().text).not.toContain('SECRET-INTERNALS');
  });

  it('an unexpected exception in a handler is logged without the text of the update', async () => {
    const service = new FakeJobService();
    service.allowedCourts = () => {
      throw new Error('unexpected failure');
    };
    const h = await createHarness({ service });
    await h.say('/new');
    await h.press('вт 20.10');
    expect(h.logs.entries.some((entry) => entry.level === 'error')).toBe(true);
    expect(h.transport.of('sendMessage').some((call) => String(call.payload['text']).includes('Внутренняя ошибка'))).toBe(true);
  });
});
