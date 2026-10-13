import type { Bot } from 'grammy';
import { parseCallbackData } from './callbackData.js';
import type { CancelFlow } from './cancelFlow.js';
import type { NewJobFlow } from './newJobFlow.js';
import { answerStale, createAnswerer } from './ui.js';
import type { TelegramLogger } from './types.js';

export interface CallbackDeps {
  readonly newJob: NewJobFlow;
  readonly cancel: CancelFlow;
  readonly logger: TelegramLogger;
}

/**
 * One entry point for every button. Whatever happens, the query is answered exactly once; data that does not
 * parse strictly is treated like a stale button and changes nothing.
 */
export const registerCallbacks = (bot: Bot, deps: CallbackDeps): void => {
  const { newJob, cancel, logger } = deps;

  bot.on('callback_query:data', async (ctx) => {
    const answer = createAnswerer(ctx, logger);
    try {
      const action = parseCallbackData(ctx.callbackQuery.data);
      if (action === null) {
        logger.debug({ length: ctx.callbackQuery.data.length }, 'telegram: callback_data rejected by the strict parser');
        await answerStale(ctx, answer, logger);
        return;
      }
      if (action.type === 'cancelYes' || action.type === 'cancelNo') await cancel.handle(ctx, action, answer);
      else await newJob.handle(ctx, action, answer);
    } finally {
      await answer.finish();
    }
  });

  bot.on('callback_query', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
  });
};
