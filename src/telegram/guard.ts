import type { Bot, Context } from 'grammy';
import type { Update } from 'grammy/types';
import { describeError } from './text.js';
import type { TelegramLogger } from './types.js';

/** Only these update types are ever processed; Telegram is also told to deliver nothing else. */
export const ACCEPTED_UPDATE_TYPES = ['message', 'callback_query'] as const;

export const validateAllowedUserIds = (ids: readonly number[]): ReadonlySet<number> => {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('allowedUserIds must contain at least one Telegram user id: an empty list never means "everyone"');
  }
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error('allowedUserIds must contain only positive integer Telegram user ids');
    }
  }
  return new Set(ids);
};

interface Origin {
  readonly updateType: string;
  readonly fromId: number | null;
  readonly chatId: number | null;
  readonly chatType: string | null;
}

/** Sender and chat taken straight from the raw update (not from helpers that look at many update kinds); tolerant of malformed input. */
const originOf = (update: Update): Origin => {
  const message = update.message;
  if (message !== undefined) {
    return { updateType: 'message', fromId: message.from?.id ?? null, chatId: message.chat?.id ?? null, chatType: message.chat?.type ?? null };
  }
  const query = update.callback_query;
  if (query !== undefined) {
    const chat = query.message?.chat;
    return { updateType: 'callback_query', fromId: query.from?.id ?? null, chatId: chat?.id ?? null, chatType: chat?.type ?? null };
  }
  const updateType = Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown';
  return { updateType, fromId: null, chatId: null, chatType: null };
};

/** Allowed sender, in a private chat with the bot (in which the chat id is the user id), accepted update kind. */
export const isAuthorized = (update: Update, allowed: ReadonlySet<number>): boolean => {
  const origin = originOf(update);
  return (
    (origin.updateType === 'message' || origin.updateType === 'callback_query') &&
    origin.fromId !== null &&
    allowed.has(origin.fromId) &&
    origin.chatType === 'private' &&
    origin.chatId === origin.fromId
  );
};

export interface GuardOptions {
  readonly allowed: ReadonlySet<number>;
  readonly logger: TelegramLogger;
  readonly secrets: readonly string[];
}

/**
 * Must be the FIRST middleware. Strangers get no reply and no API call at all. The log line carries ids and the
 * update kind only, never any text. Errors of everything behind it are contained here so that long polling continues.
 */
export const registerGuard = (bot: Bot, options: GuardOptions): void => {
  const { allowed, logger, secrets } = options;

  bot.use(async (ctx: Context, next) => {
    if (!isAuthorized(ctx.update, allowed)) {
      const { updateType, fromId, chatType } = originOf(ctx.update);
      logger.warn({ updateType, fromId, chatType }, 'telegram: update from a non-allowed sender or chat ignored');
      return;
    }
    try {
      await next();
    } catch (error) {
      logger.error(describeError(error, secrets), 'telegram: handler failed');
      await ctx.reply('Внутренняя ошибка бота, попробуйте ещё раз. Подробности в логе.').catch(() => undefined);
    }
  });
};
