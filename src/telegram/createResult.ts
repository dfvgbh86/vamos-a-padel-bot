import type { CreateJobRejection, CreateJobResult } from '../contracts.js';
import { formatMadrid, formatMoney } from './format.js';
import { jobBlock } from './jobText.js';
import { safeText } from './text.js';

type Created = Extract<CreateJobResult, { kind: 'created' }>;
type Rejected = Extract<CreateJobResult, { kind: 'rejected' }>;

const REJECTION_TEXT: Readonly<Record<CreateJobRejection, string>> = {
  invalid_input: 'Задание не принято: некорректные данные.',
  date_in_past: 'Эта дата уже прошла.',
  date_too_far: 'Эта дата слишком далеко: бот берёт только ближайшие даты.',
  court_not_allowed: 'Один из выбранных кортов нельзя бронировать на эту дату.',
  duplicate_active_job: 'На эту дату уже есть активное задание. Смотрите /jobs, при необходимости /cancel.',
  own_booking_exists: 'На эту дату у вас уже есть бронь: на сайте действует лимит одна бронь в день.',
};

const approx = (isEstimate: boolean): string => (isEstimate ? 'примерно ' : '');

const NO_FUNDS_CHECK = 'Монедеро: баланс прочитать не удалось, проверка денег не выполнена';

const windowLine = (job: Created['job'], nowMs: number): string =>
  job.opensAtMs <= nowMs
    ? 'Окно уже открыто: бот бронирует сразу и пришлёт результат.'
    : `Бот сам забронирует в момент открытия окна (${formatMadrid(job.opensAtMs)} Madrid) и пришлёт результат.`;

export const createdText = (result: Created, nowMs: number): string => {
  const { job } = result;
  const lines = ['✅ <b>Задание создано</b>', jobBlock(job, nowMs)];
  if (job.state === 'scheduled') lines.push('', windowLine(job, nowMs));
  if (result.requiredCents !== null) {
    lines.push(`Стоимость: ${approx(result.requiredIsEstimate)}${formatMoney(result.requiredCents)}`);
  }
  lines.push(result.walletCents === null ? NO_FUNDS_CHECK : `Монедеро: ${formatMoney(result.walletCents)}`);
  lines.push('', `Список: /jobs · отменить: /cancel ${job.id}`);
  return lines.join('\n');
};

export const rejectedText = (result: Rejected): string => {
  const detail = result.detail.trim().length === 0 ? [] : [`Подробности: ${safeText(result.detail, 200)}`];
  return ['❌ <b>Задание не создано</b>', REJECTION_TEXT[result.reason], ...detail, '', 'Начать заново: /new'].join('\n');
};

/** The prominent "not enough money" message (sent as its own message), or null when funds are fine. */
export const fundsWarningText = (result: Created): string | null => {
  if (result.fundsOk) return null;
  const { walletCents, requiredCents } = result;
  const need = requiredCents === null ? null : `${approx(result.requiredIsEstimate)}${formatMoney(requiredCents)}`;
  const topUp = 'Задание остаётся заряженным: пополните монедеро до открытия окна.';

  if (walletCents === null) {
    return [
      '⚠️ <b>Внимание!</b> Баланс монедеро прочитать не удалось, поэтому проверить, хватит ли денег, нельзя.',
      need === null ? 'Стоимость брони определить тоже не удалось.' : `Нужно ${need}.`,
      'Проверьте баланс на сайте клуба (или командой /wallet) и при необходимости пополните.',
      topUp,
    ].join('\n');
  }
  if (need === null) {
    return [
      `⚠️ <b>Внимание!</b> Возможно, на бронь не хватает денег: на счёте ${formatMoney(walletCents)}, а стоимость определить не удалось.`,
      topUp,
    ].join('\n');
  }
  return [`⚠️ <b>Внимание!</b> На бронь не хватает денег: нужно ${need}, на счёте ${formatMoney(walletCents)}.`, topUp].join('\n');
};
