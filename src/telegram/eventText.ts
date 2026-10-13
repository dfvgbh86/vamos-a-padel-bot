import type { Job, JobEvent, PreflightFailure } from '../contracts.js';
import { courtName, formatDayLong, formatDayShort, formatMadrid, formatMoney, formatTimeRange } from './format.js';
import { choiceLines } from './jobText.js';
import { safeText } from './text.js';

const DETAIL_LIMIT = 300;
const MAX_LISTED_CHOICES = 10;

const title = (job: Job): string => `задание #${job.id}, ${formatDayShort(job.gameDate)}`;

/** The sniper reports a booking it found in the calendar without a readable id as 0: say so instead of printing a fake number. */
const reservationLine = (reservationId: number): string =>
  Number.isSafeInteger(reservationId) && reservationId > 0
    ? `Номер брони: ${reservationId}`
    : 'Номер брони: не удалось прочитать, проверьте бронь на сайте клуба';

const detailLines = (detail: string): string[] => {
  const text = safeText(detail, DETAIL_LIMIT);
  return text.length === 0 ? [] : [`Детали: ${text}`];
};

const preflightFailed = (job: Job, reason: PreflightFailure, detail: string): string => {
  const opens = formatMadrid(job.opensAtMs);
  switch (reason) {
    case 'no_funds':
      return [
        `💸 <b>Не хватает денег на монедеро</b> (${title(job)})`,
        `Пожалуйста, пополните монедеро до открытия окна (${opens} Madrid), иначе бронь не получится.`,
        ...detailLines(detail),
      ].join('\n');
    case 'auth':
      return [
        `🔑 <b>Не удалось войти на сайт клуба</b> (${title(job)})`,
        'Проверьте логин и пароль в настройках бота: без входа бронь невозможна.',
        ...detailLines(detail),
      ].join('\n');
    case 'daily_limit':
      return [
        `⚠️ <b>На эту дату уже есть бронь</b> (${title(job)})`,
        'На сайте действует лимит одна бронь в день, поэтому новая бронь не будет создана.',
        ...detailLines(detail),
      ].join('\n');
    case 'window_unknown':
      return [
        `⚠️ <b>Не удалось определить, когда откроется окно</b> (${title(job)})`,
        'Проверьте задание вручную: /status',
        ...detailLines(detail),
      ].join('\n');
    case 'other':
      return [`⚠️ <b>Предстартовая проверка не пройдена</b> (${title(job)})`, ...detailLines(detail)].join('\n');
  }
};

/** Russian text (parse_mode HTML) for one event. Never contains access codes: they are not part of any event. */
export const formatJobEvent = (event: JobEvent): string => {
  switch (event.kind) {
    case 'armed':
      return [
        `🎯 <b>Задание #${event.job.id} заряжено на ${formatMadrid(event.job.opensAtMs)} Madrid</b>`,
        `${formatDayLong(event.job.gameDate)} · ${event.job.durationMinutes} мин`,
        'Варианты по приоритету:',
        ...choiceLines(event.job.choices, MAX_LISTED_CHOICES),
      ].join('\n');
    case 'preflight_ok':
      return [
        `✅ <b>Предстартовая проверка пройдена</b> (${title(event.job)})`,
        `Монедеро: ${formatMoney(event.walletCents)}, стоимость брони: ${event.quoteCents === null ? 'пока неизвестна' : formatMoney(event.quoteCents)}`,
      ].join('\n');
    case 'preflight_failed':
      return preflightFailed(event.job, event.reason, event.detail);
    case 'window_open':
      return `🔔 <b>Окно бронирования открылось</b>: отправляю запрос (${title(event.job)}).`;
    case 'booked':
      return [
        '✅ <b>ЗАБРОНИРОВАНО</b>',
        courtName(event.choice.courtId),
        `${formatDayLong(event.job.gameDate)} · ${formatTimeRange(event.choice.startMinutes, event.job.durationMinutes)}`,
        reservationLine(event.reservationId),
        `(задание #${event.job.id})`,
      ].join('\n');
    case 'needs_payment':
      return [
        `💳 <b>Бронь создана, но нужна оплата</b> (${title(event.job)})`,
        reservationLine(event.reservationId),
        'Бот сам её не оплатил: оплатите бронь на сайте клуба, пока она не снялась.',
      ].join('\n');
    case 'failed':
      return [`❌ <b>Не удалось забронировать</b> (${title(event.job)})`, `Причина: ${safeText(event.reason, DETAIL_LIMIT)}`].join('\n');
    case 'ambiguous':
      return [
        `⚠️ <b>Результат брони неясен</b> (${title(event.job)})`,
        'Запрос мог дойти до сайта, поэтому проверьте бронь вручную (сайт клуба, раздел броней, и баланс монедеро).',
        'Бот не повторяет запрос вслепую.',
        ...detailLines(event.detail),
      ].join('\n');
    case 'expired':
      return `⌛ <b>Задание #${event.job.id} истекло</b> (${formatDayShort(event.job.gameDate)}): окно давно прошло, ничего не забронировано.`;
  }
};
