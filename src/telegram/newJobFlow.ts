import type { Context } from 'grammy';
import type { GameDate } from '../config/gameDate.js';
import type { CreateJobResult, SlotChoice } from '../contracts.js';
import type { CallbackAction } from './callbackData.js';
import { createdText, fundsWarningText, rejectedText } from './createResult.js';
import { draftView, DURATION_MINUTES } from './draftView.js';
import { loadPickerMode, tryGetDay, type PickerDeps } from './picker.js';
import { MAX_CHOICES, offeredDates, startsForCourt } from './schedule.js';
import { DRAFT_TTL_MS, newSessionId, type Draft, type ExpiringStore } from './sessions.js';
import { SERVICE_TIMEOUT_MS, TIMED_OUT, withTimeout } from './timeout.js';
import { describeError } from './text.js';
import { answerNotNow, answerStale, reply, showView, type Answerer } from './ui.js';
import { datesView } from './views.js';

export interface NewJobFlowDeps extends PickerDeps {
  readonly drafts: ExpiringStore<Draft>;
}

export interface NewJobFlow {
  /** `/new`: replaces any earlier conversation of this user. */
  start(ctx: Context): Promise<void>;
  handle(ctx: Context, action: CallbackAction, answer: Answerer): Promise<void>;
}

const sameChoice = (a: SlotChoice, b: SlotChoice): boolean => a.courtId === b.courtId && a.startMinutes === b.startMinutes;

export const createNewJobFlow = (deps: NewJobFlowDeps): NewJobFlow => {
  const { service, clock, logger, drafts } = deps;

  const save = (userId: number, draft: Draft, patch: Partial<Draft>): Draft => {
    const next: Draft = { ...draft, ...patch, expiresAtMs: clock.nowMs() + DRAFT_TTL_MS };
    drafts.set(userId, next);
    return next;
  };

  /** The conversation as it is now (an `await` may have replaced or ended it). */
  const live = (userId: number, sid: string): Draft | undefined => {
    const draft = drafts.get(userId);
    return draft !== undefined && draft.sid === sid ? draft : undefined;
  };

  const render = (draft: Draft, notice?: string) => draftView(deps, draft, notice);

  /** A date, a court list and the schedule are needed for every screen after the date step. */
  const inPicker = (draft: Draft): draft is Draft & { gameDate: GameDate; mode: NonNullable<Draft['mode']> } =>
    draft.gameDate !== null && draft.mode !== null && (draft.view.kind === 'courts' || draft.view.kind === 'times');

  const start = async (ctx: Context): Promise<void> => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const nowMs = clock.nowMs();
    const draft: Draft = {
      sid: newSessionId(),
      view: { kind: 'dates' },
      gameDate: null,
      mode: null,
      choices: [],
      submitting: false,
      expiresAtMs: nowMs + DRAFT_TTL_MS,
    };
    drafts.set(userId, draft);
    await reply(ctx, datesView(offeredDates(nowMs, deps.openRule), draft.sid));
  };

  const pickDate = async (ctx: Context, userId: number, draft: Draft, date: GameDate, answer: Answerer): Promise<void> => {
    const nowMs = clock.nowMs();
    if (!offeredDates(nowMs, deps.openRule).some((offered) => offered.date === date)) {
      await answer('Эта дата сейчас недоступна для выбора', true);
      return;
    }
    await answer();
    const mode = await loadPickerMode(deps, date, nowMs);
    const latest = live(userId, draft.sid);
    if (latest === undefined) return;
    const next = save(userId, latest, { gameDate: date, mode, choices: [], view: { kind: 'courts' }, submitting: false });
    await showView(ctx, render(next), logger);
  };

  const pickCourt = async (ctx: Context, userId: number, draft: Draft, courtId: number, answer: Answerer): Promise<void> => {
    if (!inPicker(draft)) return answerNotNow(answer);
    if (!service.allowedCourts(draft.gameDate).includes(courtId)) {
      await answer('Этот корт нельзя выбрать на эту дату', true);
      return;
    }
    if (startsForCourt(draft.mode, courtId, DURATION_MINUTES).length === 0) {
      await answer('На этом корте нет свободных слотов', true);
      return;
    }
    await answer();
    await showView(ctx, render(save(userId, draft, { view: { kind: 'times', courtId } })), logger);
  };

  const pickTime = async (
    ctx: Context,
    userId: number,
    draft: Draft,
    choice: SlotChoice,
    answer: Answerer,
  ): Promise<void> => {
    if (!inPicker(draft)) return answerNotNow(answer);
    const { gameDate } = draft;
    if (!service.allowedCourts(gameDate).includes(choice.courtId)) {
      await answer('Этот корт нельзя выбрать на эту дату', true);
      return;
    }
    if (draft.choices.some((existing) => sameChoice(existing, choice))) {
      await answer('Этот вариант уже выбран');
      return;
    }
    if (draft.choices.length >= MAX_CHOICES) {
      await answer(`Можно выбрать не больше ${MAX_CHOICES} вариантов`, true);
      return;
    }

    if (draft.mode.kind === 'grid' && !draft.mode.starts.includes(choice.startMinutes)) {
      await answer('Это время недоступно', true);
      return;
    }
    await answer();

    let mode = draft.mode;
    if (mode.kind === 'schedule') {
      const fresh = await tryGetDay(deps, gameDate);
      if (fresh !== null) mode = { kind: 'schedule', schedule: fresh };
      if (!startsForCourt(mode, choice.courtId, DURATION_MINUTES).includes(choice.startMinutes)) {
        const latest = live(userId, draft.sid);
        if (latest === undefined) return;
        const next = save(userId, latest, { mode });
        await showView(ctx, render(next, 'Этот слот уже занят или недоступен.'), logger);
        return;
      }
    }

    const latest = live(userId, draft.sid);
    if (latest === undefined || latest.choices.length >= MAX_CHOICES || latest.choices.some((c) => sameChoice(c, choice))) return;
    const next = save(userId, latest, { mode, choices: [...latest.choices, choice], view: { kind: 'courts' } });
    await showView(ctx, render(next), logger);
  };

  const undo = async (ctx: Context, userId: number, draft: Draft, answer: Answerer): Promise<void> => {
    if (draft.choices.length === 0) {
      await answer('Пока нечего убирать');
      return;
    }
    await answer();
    await showView(ctx, render(save(userId, draft, { choices: draft.choices.slice(0, -1) })), logger);
  };

  const toCourts = async (ctx: Context, userId: number, draft: Draft, answer: Answerer): Promise<void> => {
    if (draft.gameDate === null || draft.mode === null) return answerNotNow(answer);
    await answer();
    await showView(ctx, render(save(userId, draft, { view: { kind: 'courts' } })), logger);
  };

  const toDates = async (ctx: Context, userId: number, draft: Draft, answer: Answerer): Promise<void> => {
    await answer();
    const next = save(userId, draft, { view: { kind: 'dates' }, gameDate: null, mode: null, choices: [] });
    await showView(ctx, render(next, 'Выбор сброшен: выберите дату заново.'), logger);
  };

  const review = async (ctx: Context, userId: number, draft: Draft, answer: Answerer): Promise<void> => {
    if (!inPicker(draft)) return answerNotNow(answer);
    if (draft.choices.length === 0) {
      await answer('Выберите хотя бы один вариант', true);
      return;
    }
    await answer();
    await showView(ctx, render(save(userId, draft, { view: { kind: 'confirm' } })), logger);
  };

  const abort = async (ctx: Context, userId: number, answer: Answerer): Promise<void> => {
    drafts.delete(userId);
    await answer();
    await showView(ctx, 'Создание задания отменено. Новое: /new', logger);
  };

  /** Court and date are checked again right before they leave the bot. */
  const stillValid = (draft: Draft & { gameDate: GameDate }): boolean =>
    offeredDates(clock.nowMs(), deps.openRule).some((offered) => offered.date === draft.gameDate) &&
    draft.choices.every((choice) => service.allowedCourts(draft.gameDate).includes(choice.courtId));

  const submit = async (ctx: Context, userId: number, draft: Draft, answer: Answerer): Promise<void> => {
    const { gameDate } = draft;
    if (draft.view.kind !== 'confirm' || gameDate === null || draft.choices.length === 0) return answerNotNow(answer);
    if (draft.submitting) {
      await answer('Задание уже отправляется');
      return;
    }
    if (!stillValid({ ...draft, gameDate })) {
      await answer();
      const next = save(userId, draft, { view: { kind: 'courts' } });
      await showView(ctx, render(next, 'Выбранные дата или корт больше недоступны. Проверьте выбор.'), logger);
      return;
    }

    save(userId, draft, { submitting: true });
    await answer();
    const outcome = await createJob(gameDate, draft.choices);
    if (outcome === 'error') {
      const latest = live(userId, draft.sid);
      if (latest !== undefined) {
        const next = save(userId, latest, { submitting: false });
        await showView(ctx, render(next, 'Не удалось создать задание: ошибка сервиса. Попробуйте ещё раз.'), logger);
      }
      return;
    }
    drafts.delete(userId);
    if (outcome === 'timeout') {
      await showView(ctx, 'Сервис не ответил вовремя. Прежде чем повторять, проверьте /jobs: задание могло быть создано.', logger);
      return;
    }
    await showResult(ctx, outcome);
  };

  const createJob = async (gameDate: GameDate, choices: readonly SlotChoice[]): Promise<CreateJobResult | 'error' | 'timeout'> => {
    try {
      const result = await withTimeout(
        service.createJob({ gameDate, choices, durationMinutes: DURATION_MINUTES, payment: 'wallet' }),
        SERVICE_TIMEOUT_MS,
        clock,
      );
      return result === TIMED_OUT ? 'timeout' : result;
    } catch (error) {
      logger.error(describeError(error), 'telegram: createJob failed');
      return 'error';
    }
  };

  const showResult = async (ctx: Context, result: CreateJobResult): Promise<void> => {
    if (result.kind === 'rejected') {
      await showView(ctx, rejectedText(result), logger);
      return;
    }
    await showView(ctx, createdText(result, clock.nowMs()), logger);
    const warning = fundsWarningText(result);
    if (warning !== null) await reply(ctx, warning);
  };

  const handle = async (ctx: Context, action: CallbackAction, answer: Answerer): Promise<void> => {
    const userId = ctx.from?.id;
    const draft = userId === undefined ? undefined : live(userId, action.sid);
    if (userId === undefined || draft === undefined) return answerStale(ctx, answer, logger);

    switch (action.type) {
      case 'pickDate':
        return pickDate(ctx, userId, draft, action.date, answer);
      case 'pickCourt':
        return pickCourt(ctx, userId, draft, action.courtId, answer);
      case 'pickTime':
        return pickTime(ctx, userId, draft, { courtId: action.courtId, startMinutes: action.startMinutes }, answer);
      case 'undo':
        return undo(ctx, userId, draft, answer);
      case 'toCourts':
        return toCourts(ctx, userId, draft, answer);
      case 'toDates':
        return toDates(ctx, userId, draft, answer);
      case 'review':
        return review(ctx, userId, draft, answer);
      case 'confirm':
        return submit(ctx, userId, draft, answer);
      case 'abort':
        return abort(ctx, userId, answer);
      case 'cancelYes':
      case 'cancelNo':
        return answerStale(ctx, answer, logger);
    }
  };

  return { start, handle };
};
