/** whoami-telegram: finds out the owner's Telegram id without ever answering anybody. */
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { callbackUpdate, createFakeTransport, FAKE_TOKEN, messageUpdate, OWNER_ID, STRANGER_ID } from '../telegram/_harness.js';
import { START_MS } from './_rig.js';
import { createVirtualClock } from './_virtualClock.js';

const REPLYING_METHODS = ['sendMessage', 'editMessageText', 'answerCallbackQuery', 'sendChatAction', 'forwardMessage', 'copyMessage'];

const whoami = async (
  transport: ReturnType<typeof createFakeTransport>,
  options: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(['whoami-telegram'], {
    env: options.env ?? { TELEGRAM_BOT_TOKEN: FAKE_TOKEN },
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
    clock: createVirtualClock(START_MS),
    telegramTransformer: transport.transformer,
    whoamiTimeoutMs: options.timeoutMs ?? 5000,
  });
  return { code, out: out.join(''), err: err.join('') };
};

const repliesOf = (transport: ReturnType<typeof createFakeTransport>) => transport.calls.filter((call) => REPLYING_METHODS.includes(call.method));

describe('whoami-telegram', () => {
  it('prints the numeric id of the first private message and exits with 0', async () => {
    const transport = createFakeTransport();
    transport.queueUpdates([messageUpdate('hello', { fromId: OWNER_ID })]);
    const result = await whoami(transport);
    expect(result.code).toBe(0);
    expect(result.out).toBe(`${OWNER_ID}\n`);
    expect(result.err).toContain('TELEGRAM_ALLOWED_USER_IDS');
  });

  it('never replies, acknowledges or reacts to anybody', async () => {
    const transport = createFakeTransport();
    transport.queueUpdates([messageUpdate('/start', { fromId: OWNER_ID }), messageUpdate('hi', { fromId: STRANGER_ID })]);
    await whoami(transport);
    expect(repliesOf(transport)).toEqual([]);
  });

  it('only fetches messages and stops polling afterwards (the last update is confirmed so it is not delivered again)', async () => {
    const transport = createFakeTransport();
    transport.queueUpdates([messageUpdate('hello')]);
    await whoami(transport);
    const polls = transport.of('getUpdates');
    expect(polls[0]?.payload['allowed_updates']).toEqual(['message']);
    const confirm = polls.at(-1);
    expect(confirm?.payload['limit']).toBe(1);
    expect(typeof confirm?.payload['offset']).toBe('number');
  });

  it('skips messages from groups and takes the first private one', async () => {
    const transport = createFakeTransport();
    transport.queueUpdates([messageUpdate('in a group', { fromId: OWNER_ID, chat: 'group' }), messageUpdate('in a supergroup', { fromId: OWNER_ID, chat: 'supergroup' }), messageUpdate('private', { fromId: STRANGER_ID })]);
    const result = await whoami(transport);
    expect(result.out).toBe(`${STRANGER_ID}\n`);
  });

  it('ignores button presses (it asks Telegram for messages only)', async () => {
    const transport = createFakeTransport();
    transport.queueUpdates([callbackUpdate('x', { fromId: STRANGER_ID }), messageUpdate('hi', { fromId: OWNER_ID })]);
    const result = await whoami(transport);
    expect(result.out).toBe(`${OWNER_ID}\n`);
    expect(repliesOf(transport)).toEqual([]);
  });

  it('prints only the number on stdout, never the text of the message', async () => {
    const transport = createFakeTransport();
    transport.queueUpdates([messageUpdate('my secret thought 0451', { fromId: OWNER_ID })]);
    const result = await whoami(transport);
    expect(result.out).toMatch(/^\d+\n$/);
    expect(result.out + result.err).not.toContain('secret thought');
  });

  it('needs only the bot token: no allowlist, no club account', async () => {
    const transport = createFakeTransport();
    transport.queueUpdates([messageUpdate('hello')]);
    const result = await whoami(transport, { env: { TELEGRAM_BOT_TOKEN: FAKE_TOKEN } });
    expect(result.code).toBe(0);
  });

  it('fails without the token, naming the key', async () => {
    const transport = createFakeTransport();
    const result = await whoami(transport, { env: { TELEGRAM_ALLOWED_USER_IDS: '42' } });
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toContain('missing: TELEGRAM_BOT_TOKEN');
    expect(transport.calls).toEqual([]);
  });

  it('gives up with 1 when nobody writes in time', async () => {
    const transport = createFakeTransport();
    const result = await whoami(transport, { timeoutMs: 50 });
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toContain('No private message arrived');
    expect(repliesOf(transport)).toEqual([]);
  });

  it('says so when Telegram refuses the token, without printing it', async () => {
    const transport = createFakeTransport();
    transport.failNext('getMe', { code: 401, description: 'Unauthorized' });
    const result = await whoami(transport);
    expect(result).toMatchObject({ code: 1, out: '' });
    expect(result.err).toContain('rejected the bot token');
    expect(result.err).not.toContain(FAKE_TOKEN);
  });

  it('says so when the bot is already polling elsewhere', async () => {
    const transport = createFakeTransport();
    transport.failNext('getUpdates', { code: 409, description: 'Conflict: terminated by other getUpdates request' });
    const result = await whoami(transport);
    expect(result).toMatchObject({ code: 1, out: '' });
    expect(result.err).toContain('Another program is already polling');
  });

  it('says so when Telegram cannot be reached', async () => {
    const transport = createFakeTransport();
    transport.setOffline(true);
    const result = await whoami(transport, { timeoutMs: 300 });
    expect(result).toMatchObject({ code: 1, out: '' });
    expect(result.err).toContain('could not be reached');
  });

  it('tells the owner what to do while it waits', async () => {
    const transport = createFakeTransport();
    transport.queueUpdates([messageUpdate('hello')]);
    const result = await whoami(transport);
    expect(result.err).toContain('Send any message to your bot');
    expect(result.err).toContain('will not reply');
  });
});
