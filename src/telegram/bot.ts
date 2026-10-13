import { Bot } from 'grammy';
import { parseTelegramApiRoot } from '../config/env.js';
import { createCancelFlow } from './cancelFlow.js';
import { registerCallbacks } from './callbacks.js';
import { registerCommands } from './commands.js';
import { registerGuard, validateAllowedUserIds } from './guard.js';
import { createNewJobFlow } from './newJobFlow.js';
import { createNotifier } from './notifier.js';
import { createPoller } from './poller.js';
import { createExpiringStore, type Draft, type PendingCancel } from './sessions.js';
import { describeError } from './text.js';
import type { TelegramBotDeps, TelegramBotHandle } from './types.js';

/** Above the 30 s long-poll, far below grammY's 500 s default: a hung reply must not stall update handling for minutes. */
const HTTP_TIMEOUT_SECONDS = 60;

/** Throws without echoing the value: the root receives the bot token, so only this machine may be named. */
const checkedApiRoot = (apiRoot: string | undefined): { readonly apiRoot?: string } => {
  if (apiRoot === undefined) return {};
  const root = parseTelegramApiRoot(apiRoot);
  if (root === null) throw new Error('Telegram apiRoot must be an http URL on 127.0.0.1, localhost or [::1]');
  return { apiRoot: root };
};

/**
 * Builds the bot. Throws at construction for an empty or malformed allowlist (an empty list never means
 * "everyone") and for a missing token. Nothing is sent to Telegram until `start()`.
 */
export const createTelegramBot = (deps: TelegramBotDeps): TelegramBotHandle => {
  const allowed = validateAllowedUserIds(deps.allowedUserIds);
  if (typeof deps.token !== 'string' || deps.token.trim().length === 0) throw new Error('Telegram bot token is required');

  const { service, clock, logger } = deps;
  const secrets = [deps.token];
  const bot = new Bot(deps.token, { client: { timeoutSeconds: HTTP_TIMEOUT_SECONDS, ...checkedApiRoot(deps.apiRoot) } });
  if (deps.apiTransformer !== undefined) bot.api.config.use(deps.apiTransformer);

  registerGuard(bot, { allowed, logger, secrets });

  const pickerDeps = { service, clock, logger, ...(deps.openRule === undefined ? {} : { openRule: deps.openRule }) };
  const newJob = createNewJobFlow({ ...pickerDeps, drafts: createExpiringStore<Draft>(clock) });
  const cancel = createCancelFlow({ ...pickerDeps, pending: createExpiringStore<PendingCancel>(clock) });
  registerCallbacks(bot, { newJob, cancel, logger });
  registerCommands(bot, { ...pickerDeps, newJob, cancel });

  bot.catch((error) => {
    logger.error(describeError(error.error, secrets), 'telegram: unhandled error in update processing');
  });

  const notifier = createNotifier(bot.api, [...allowed], logger, secrets, {
    sleep: (ms) => clock.sleep(ms),
    ...(deps.onDelivered === undefined ? {} : { onDelivered: deps.onDelivered }),
  });
  const { start, stop } = createPoller({ bot, clock, logger, secrets, onFatalError: deps.onFatalError });

  return { bot, notifier, start, stop };
};
