import { ACTIVE_JOB_STATES, type Job, type JobState, type SlotChoice } from '../contracts.js';
import { courtName, formatClock, formatDayLong, formatDayShort, formatMadrid, formatTimeRange } from './format.js';
import { safeText } from './text.js';

export const STATE_LABELS: Readonly<Record<JobState, string>> = {
  scheduled: 'заряжено, ждёт открытия окна',
  warming: 'идёт подготовка',
  firing: 'идёт бронирование',
  booked: 'забронировано',
  needs_payment: 'бронь создана, нужна оплата',
  failed: 'не удалось',
  cancelled: 'отменено',
  expired: 'истекло, ничего не забронировано',
};

export const isActiveState = (state: JobState): boolean => ACTIVE_JOB_STATES.includes(state);

/** "1. Pista 7 semicubierta, 18:00" lines in priority order. */
export const choiceLines = (choices: readonly SlotChoice[], limit = choices.length): string[] => {
  const lines = choices.slice(0, limit).map((choice, index) => `${index + 1}. ${courtName(choice.courtId)}, ${formatClock(choice.startMinutes)}`);
  if (choices.length > limit) lines.push(`… и ещё ${choices.length - limit}`);
  return lines;
};

/** The window of a scheduled job: still to come, or (when `nowMs` is known and past it) already open. */
const windowLine = (job: Job, nowMs: number | undefined): string =>
  nowMs !== undefined && job.opensAtMs <= nowMs
    ? `Окно открылось: ${formatMadrid(job.opensAtMs)} Madrid`
    : `Окно откроется: ${formatMadrid(job.opensAtMs)} Madrid`;

/**
 * Multi-line description of a job for the list and for confirmations. All dynamic parts are escaped.
 * Pass `nowMs` so that a window that has already opened is not announced as still to come.
 */
export const jobBlock = (job: Job, nowMs?: number): string => {
  const head = `<b>#${job.id}</b> · ${formatDayLong(job.gameDate)} · ${job.durationMinutes} мин`;
  const lines = [head, `Статус: ${STATE_LABELS[job.state]}`];

  if (job.state === 'scheduled') lines.push(windowLine(job, nowMs));
  if (job.bookedChoice !== null) {
    lines.push(`Бронь: ${courtName(job.bookedChoice.courtId)}, ${formatTimeRange(job.bookedChoice.startMinutes, job.durationMinutes)}`);
  } else {
    lines.push(...choiceLines(job.choices, 4));
  }
  if (job.reservationId !== null) lines.push(`Номер брони: ${job.reservationId}`);
  if (job.failureReason !== null) lines.push(`Причина: ${safeText(job.failureReason, 160)}`);
  return lines.join('\n');
};

/** One-line form for compact places. */
export const jobLine = (job: Job): string =>
  `#${job.id} · ${formatDayShort(job.gameDate)} · ${STATE_LABELS[job.state]}`;
