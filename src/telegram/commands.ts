import type { Bot, Context } from 'grammy';
import type { Clock, JobService } from '../contracts.js';
import type { CancelFlow } from './cancelFlow.js';
import type { NewJobFlow } from './newJobFlow.js';
import { HELP_TEXT, jobsText, RESUME_TEXT, statusText, STOP_TEXT, UNKNOWN_INPUT_TEXT, walletText } from './reports.js';
import { describeError } from './text.js';
import { SERVICE_TIMEOUT_MS, TIMED_OUT, withTimeout } from './timeout.js';
import { reply } from './ui.js';
import type { TelegramLogger } from './types.js';

export interface CommandDeps {
  readonly service: JobService;
  readonly clock: Clock;
  readonly logger: TelegramLogger;
  readonly newJob: NewJobFlow;
  readonly cancel: CancelFlow;
}

export const COMMAND_MENU = [
  { command: 'new', description: 'Создать задание на бронь' },
  { command: 'jobs', description: 'Активные и недавние задания' },
  { command: 'cancel', description: 'Отменить задание: /cancel 5' },
  { command: 'status', description: 'Состояние бота и окна' },
  { command: 'wallet', description: 'Баланс монедеро' },
  { command: 'stop', description: 'Аварийная остановка' },
  { command: 'resume', description: 'Снять аварийную остановку' },
  { command: 'help', description: 'Справка' },
] as const;

export const registerCommands = (bot: Bot, deps: CommandDeps): void => {
  const { service, clock, logger, newJob, cancel } = deps;

  /** Runs a service call with a deadline; on failure tells the owner and returns undefined. */
  const callService = async <T>(ctx: Context, what: string, work: () => Promise<T> | T): Promise<T | undefined> => {
    try {
      const result = await withTimeout(Promise.resolve().then(work), SERVICE_TIMEOUT_MS, clock);
      if (result !== TIMED_OUT) return result;
      logger.warn({ what }, 'telegram: service call timed out');
      await reply(ctx, `${what}: сервис не ответил вовремя, попробуйте позже.`);
    } catch (error) {
      logger.error({ what, ...describeError(error) }, 'telegram: service call failed');
      await reply(ctx, `${what}: ошибка сервиса, попробуйте позже.`);
    }
    return undefined;
  };

  bot.command(['start', 'help'], (ctx) => reply(ctx, HELP_TEXT));
  bot.command('new', (ctx) => newJob.start(ctx));
  bot.command('cancel', (ctx) => cancel.start(ctx, ctx.match));

  bot.command('jobs', async (ctx) => {
    const jobs = await callService(ctx, 'Список заданий', () => service.listJobs());
    if (jobs !== undefined) await reply(ctx, jobsText(jobs, clock.nowMs()));
  });

  bot.command('status', async (ctx) => {
    const report = await callService(ctx, 'Состояние', () => service.status());
    if (report !== undefined) await reply(ctx, statusText(report));
  });

  bot.command('wallet', async (ctx) => {
    const wallet = await callService(ctx, 'Баланс монедеро', () => service.wallet());
    if (wallet !== undefined) await reply(ctx, walletText(wallet.balanceCents));
  });

  bot.command('stop', async (ctx) => {
    try {
      service.stopAll();
    } catch (error) {
      logger.error(describeError(error), 'telegram: stopAll failed');
      await reply(ctx, '🚨 <b>Не удалось включить аварийную остановку!</b> Остановите программу бота вручную.');
      return;
    }
    logger.warn({}, 'telegram: emergency stop requested by the owner');
    await reply(ctx, STOP_TEXT);
  });

  bot.command('resume', async (ctx) => {
    try {
      service.resumeAll();
    } catch (error) {
      logger.error(describeError(error), 'telegram: resumeAll failed');
      await reply(ctx, 'Не удалось снять аварийную остановку: ошибка сервиса. Проверьте /status.');
      return;
    }
    logger.warn({}, 'telegram: emergency stop released by the owner');
    await reply(ctx, RESUME_TEXT);
  });

  bot.on('message', (ctx) => reply(ctx, UNKNOWN_INPUT_TEXT));
};
