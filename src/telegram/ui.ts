import { GrammyError, type Context } from 'grammy';
import { describeError } from './text.js';
import type { TelegramLogger } from './types.js';
import type { View } from './views.js';

const HTML_OPTIONS = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;

export const STALE_BUTTON_TEXT = 'Кнопка устарела, начните /new';

export const reply = async (ctx: Context, view: View | string): Promise<void> => {
  const { text, keyboard } = typeof view === 'string' ? { text: view, keyboard: undefined } : view;
  await ctx.reply(text, keyboard === undefined ? HTML_OPTIONS : { ...HTML_OPTIONS, reply_markup: keyboard });
};

const isNotModified = (error: unknown): boolean =>
  error instanceof GrammyError && error.error_code === 400 && error.description.includes('message is not modified');

/** Edits the message the pressed button belongs to; falls back to a new message when that message cannot be edited. */
export const showView = async (ctx: Context, view: View | string, logger: TelegramLogger): Promise<void> => {
  const { text, keyboard } = typeof view === 'string' ? { text: view, keyboard: undefined } : view;
  try {
    await ctx.editMessageText(text, keyboard === undefined ? HTML_OPTIONS : { ...HTML_OPTIONS, reply_markup: keyboard });
  } catch (error) {
    if (isNotModified(error)) return;
    logger.debug(describeError(error), 'telegram: edit failed, sending a new message');
    await reply(ctx, view);
  }
};

/** Takes the buttons away from the message a stale button belongs to; failures are irrelevant. */
export const removeKeyboard = async (ctx: Context, logger: TelegramLogger): Promise<void> => {
  try {
    await ctx.editMessageReplyMarkup();
  } catch (error) {
    logger.debug(describeError(error), 'telegram: could not remove stale keyboard');
  }
};

export interface Answerer {
  /** Answers the callback query once (the first call wins); later calls are ignored. */
  (text?: string, alert?: boolean): Promise<void>;
  finish(): Promise<void>;
}

/** Every callback query must be answered exactly once, or the client keeps its loading spinner. */
export const createAnswerer = (ctx: Context, logger: TelegramLogger): Answerer => {
  let answered = false;
  const answer = async (text?: string, alert = false): Promise<void> => {
    if (answered) return;
    answered = true;
    try {
      await ctx.answerCallbackQuery(text === undefined ? undefined : { text, show_alert: alert });
    } catch (error) {
      logger.debug(describeError(error), 'telegram: answerCallbackQuery failed');
    }
  };
  return Object.assign(answer, { finish: () => answer() });
};

/** A button that belongs to a conversation that no longer exists (expiry, restart, a newer /new). */
export const answerStale = async (
  ctx: Context,
  answer: Answerer,
  logger: TelegramLogger,
  hint = STALE_BUTTON_TEXT,
): Promise<void> => {
  await answer(hint, true);
  await removeKeyboard(ctx, logger);
};

/** The conversation exists but this button does not fit its current screen: refuse it, keep the buttons. */
export const answerNotNow = async (answer: Answerer): Promise<void> => {
  await answer(STALE_BUTTON_TEXT, true);
};
