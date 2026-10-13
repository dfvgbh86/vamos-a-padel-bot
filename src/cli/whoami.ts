import { Bot } from 'grammy';
import { loadTelegramTokenEnv } from '../config/env.js';
import { telegramFailureHint } from './failure.js';
import { EXIT_FAILED, EXIT_OK, type CliDeps } from './types.js';

export const DEFAULT_WHOAMI_TIMEOUT_MS = 120_000;
/** grammY retries a dead connection for ever: after stop() the polling run is given this long to end, no longer. */
const POLLING_END_GRACE_MS = 1500;

type Outcome = { readonly kind: 'seen'; readonly id: number } | { readonly kind: 'timeout' } | { readonly kind: 'failed'; readonly error: unknown };

const endOf = async (polling: Promise<unknown>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, POLLING_END_GRACE_MS);
  });
  try {
    await Promise.race([polling, grace]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Prints the numeric Telegram user id of the first private message the bot receives, then exits. It never answers
 * anybody: no reply, no acknowledgement. Meant for filling TELEGRAM_ALLOWED_USER_IDS before the bot itself runs
 * (two programs cannot poll the same bot at once).
 */
export const whoamiTelegram = async (deps: CliDeps): Promise<number> => {
  let token: string;
  try {
    token = loadTelegramTokenEnv(deps.env).telegramBotToken;
  } catch (error) {
    deps.err(`${telegramFailureHint(error)}\n`);
    return EXIT_FAILED;
  }

  const bot = new Bot(token);
  if (deps.telegramTransformer !== undefined) bot.api.config.use(deps.telegramTransformer);

  let announce: (id: number) => void = () => undefined;
  const seen = new Promise<Outcome>((resolve) => {
    announce = (id) => resolve({ kind: 'seen', id });
  });
  bot.on('message', (ctx) => {
    const sender = ctx.from;
    if (ctx.chat.type === 'private' && sender !== undefined && !sender.is_bot) announce(sender.id);
  });

  const timeoutMs = deps.whoamiTimeoutMs ?? DEFAULT_WHOAMI_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  let connected = false;
  const polling = bot
    .start({
      allowed_updates: ['message'],
      onStart: () => {
        connected = true;
      },
    })
    .then(
      (): Outcome => ({ kind: 'failed', error: new Error('polling ended') }),
      (error: unknown): Outcome => ({ kind: 'failed', error }),
    );

  deps.err('Send any message to your bot in Telegram now (waiting up to two minutes; the bot will not reply).\n');
  const outcome = await Promise.race([seen, timedOut, polling]);
  clearTimeout(timer);
  await bot.stop().catch(() => undefined);
  await endOf(polling);

  if (outcome.kind === 'seen') {
    deps.out(`${outcome.id}\n`);
    deps.err('Put this number into TELEGRAM_ALLOWED_USER_IDS in .env (only if the message was yours).\n');
    return EXIT_OK;
  }
  const seconds = Math.round(timeoutMs / 1000);
  if (outcome.kind === 'timeout') {
    deps.err(
      connected
        ? `No private message arrived within ${seconds} seconds.\n`
        : `Telegram could not be reached within ${seconds} seconds (check the internet connection).\n`,
    );
  } else {
    deps.err(`${telegramFailureHint(outcome.error)}\n`);
  }
  return EXIT_FAILED;
};
