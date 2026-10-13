import { InlineKeyboard, type Context } from 'grammy';
import type { CancelJobResult, Clock, Job, JobService, JobState } from '../contracts.js';
import { encodeCallbackData, type CallbackAction } from './callbackData.js';
import { isActiveState, jobBlock, jobLine, STATE_LABELS } from './jobText.js';
import { newSessionId, PENDING_TTL_MS, type ExpiringStore, type PendingCancel } from './sessions.js';
import { SERVICE_TIMEOUT_MS, TIMED_OUT, withTimeout } from './timeout.js';
import { describeError } from './text.js';
import { answerStale, reply, showView, type Answerer } from './ui.js';
import type { TelegramLogger } from './types.js';

export interface CancelFlowDeps {
  readonly service: JobService;
  readonly clock: Clock;
  readonly logger: TelegramLogger;
  readonly pending: ExpiringStore<PendingCancel>;
}

export interface CancelFlow {
  /** `/cancel <id>`: shows the job and asks for confirmation. */
  start(ctx: Context, argument: string): Promise<void>;
  handle(ctx: Context, action: CallbackAction, answer: Answerer): Promise<void>;
}

const STALE_HINT = 'Кнопка устарела, повторите /cancel';
const JOB_ID = /^#?(\d{1,9})$/;
/** A reservation that exists is never cancelled from here: that is done on the club site. */
const BOOKED_STATES: readonly JobState[] = ['booked', 'needs_payment'];

const bookedHint = (state: JobState): string =>
  BOOKED_STATES.includes(state) ? '\nБот не отменяет брони: если она не нужна, отмените её на сайте клуба.' : '';

export const cancelResultText = (result: CancelJobResult, jobId: number): string => {
  switch (result.kind) {
    case 'cancelled':
      return `✅ Задание #${jobId} отменено.\n${jobLine(result.job)}`;
    case 'not_cancellable':
      return `Задание #${jobId} нельзя отменить: сейчас оно в статусе «${STATE_LABELS[result.state]}».${bookedHint(result.state)}`;
    case 'not_found':
      return `Задание #${jobId} не найдено. Список: /jobs`;
  }
};

const cancellableList = (jobs: readonly Job[]): string => {
  const active = jobs.filter((job) => isActiveState(job.state)).slice(0, 10);
  return active.length === 0 ? 'Активных заданий нет.' : active.map(jobLine).join('\n');
};

export const createCancelFlow = (deps: CancelFlowDeps): CancelFlow => {
  const { service, clock, logger, pending } = deps;

  const start = async (ctx: Context, argument: string): Promise<void> => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const match = JOB_ID.exec(argument.trim());
    if (match === null) {
      await reply(ctx, `Укажите номер задания, например /cancel 5\n\n${cancellableList(service.listJobs())}`);
      return;
    }
    const jobId = Number(match[1]);
    const job = service.listJobs().find((candidate) => candidate.id === jobId);
    if (job === undefined) {
      await reply(ctx, cancelResultText({ kind: 'not_found' }, jobId));
      return;
    }
    if (BOOKED_STATES.includes(job.state) || !isActiveState(job.state)) {
      await reply(ctx, cancelResultText({ kind: 'not_cancellable', state: job.state }, jobId));
      return;
    }

    const sid = newSessionId();
    pending.set(userId, { sid, jobId, expiresAtMs: clock.nowMs() + PENDING_TTL_MS });
    const keyboard = new InlineKeyboard()
      .text('Да, отменить', encodeCallbackData({ type: 'cancelYes', sid }))
      .text('Нет', encodeCallbackData({ type: 'cancelNo', sid }));
    await reply(ctx, { text: `<b>Отменить задание?</b>\n${jobBlock(job, clock.nowMs())}`, keyboard });
  };

  const confirm = async (ctx: Context, jobId: number, answer: Answerer): Promise<void> => {
    await answer();
    try {
      const result = await withTimeout(service.cancelJob(jobId), SERVICE_TIMEOUT_MS, clock);
      const text =
        result === TIMED_OUT
          ? `Сервис не ответил вовремя. Проверьте /jobs: задание #${jobId} могло быть отменено.`
          : cancelResultText(result, jobId);
      await showView(ctx, text, logger);
    } catch (error) {
      logger.error(describeError(error), 'telegram: cancelJob failed');
      await showView(ctx, `Не удалось отменить задание #${jobId}: ошибка сервиса. Проверьте /jobs.`, logger);
    }
  };

  const handle = async (ctx: Context, action: CallbackAction, answer: Answerer): Promise<void> => {
    const userId = ctx.from?.id;
    const entry = userId === undefined ? undefined : pending.get(userId);
    if (userId === undefined || entry === undefined || entry.sid !== action.sid) {
      return answerStale(ctx, answer, logger, STALE_HINT);
    }
    pending.delete(userId);
    if (action.type === 'cancelYes') return confirm(ctx, entry.jobId, answer);
    await answer();
    await showView(ctx, 'Хорошо, задание не отменено.', logger);
  };

  return { start, handle };
};
