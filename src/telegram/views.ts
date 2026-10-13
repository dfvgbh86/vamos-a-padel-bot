import { InlineKeyboard } from 'grammy';
import type { GameDate } from '../config/gameDate.js';
import type { SlotChoice } from '../contracts.js';
import { encodeCallbackData } from './callbackData.js';
import { courtName, formatClock, formatDayLong, formatDayShort, formatMadrid, formatTimeRange } from './format.js';
import { choiceLines } from './jobText.js';
import type { CourtOption, OfferedDate } from './schedule.js';
import type { PickerMode } from './sessions.js';

export interface View {
  /** HTML (parse_mode HTML); every dynamic part is already escaped. */
  readonly text: string;
  readonly keyboard?: InlineKeyboard;
}

const COURTS_PER_ROW = 2;
const TIMES_PER_ROW = 4;

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
};

const withNotice = (lines: readonly string[], notice: string | undefined): string =>
  (notice === undefined ? lines : [`⚠️ ${notice}`, '', ...lines]).join('\n');

const chosenBlock = (choices: readonly SlotChoice[]): string[] =>
  choices.length === 0
    ? ['Пока ничего не выбрано.']
    : ['Выбрано (порядок = приоритет):', ...choiceLines(choices)];

const windowLine = (open: boolean, opensAtMs: number): string =>
  open ? 'Окно бронирования уже открыто.' : `Окно откроется: ${formatMadrid(opensAtMs)} Madrid.`;

const modeHint = (mode: PickerMode): string[] => {
  if (mode.kind === 'schedule') return [];
  return mode.source === 'open-day'
    ? ['Расписания на эту дату ещё нет: показана обычная сетка времени, занятость проверится при открытии окна.']
    : ['Расписание недоступно: время выбирается из стандартных стартов, занятость проверится при открытии окна.'];
};

export const datesView = (offered: readonly OfferedDate[], sid: string, notice?: string): View => {
  const keyboard = new InlineKeyboard();
  for (const entry of offered) {
    const label = entry.open
      ? `${formatDayShort(entry.date)} · открыто`
      : `${formatDayShort(entry.date)} · откроется ${formatMadrid(entry.opensAtMs)}`;
    keyboard.text(label, encodeCallbackData({ type: 'pickDate', sid, date: entry.date })).row();
  }
  keyboard.text('✖ Выйти', encodeCallbackData({ type: 'abort', sid }));
  return {
    text: withNotice(
      [
        '<b>Новое задание</b>',
        'Выберите дату игры. На ещё закрытые даты бот зарядится и забронирует в момент открытия окна.',
        'Время открытия указано по Madrid.',
      ],
      notice,
    ),
    keyboard,
  };
};

const courtPrompt = (options: readonly CourtOption[]): string => {
  if (options.length === 0) return 'Нет свободных слотов на 90 минут. Выберите другую дату.';
  return options.some((option) => option.startCount !== null) ? 'Выберите корт (число — свободные старты):' : 'Выберите корт:';
};

export interface CourtsViewInput {
  readonly sid: string;
  readonly gameDate: GameDate;
  readonly open: boolean;
  readonly opensAtMs: number;
  readonly mode: PickerMode;
  readonly options: readonly CourtOption[];
  readonly choices: readonly SlotChoice[];
  readonly hasOwnBooking: boolean;
  readonly notice?: string;
}

export const courtsView = (input: CourtsViewInput): View => {
  const { sid, choices } = input;
  const keyboard = new InlineKeyboard();
  for (const row of chunk(input.options, COURTS_PER_ROW)) {
    for (const option of row) {
      const suffix = option.startCount === null ? '' : ` · ${option.startCount}`;
      keyboard.text(`${courtName(option.courtId)}${suffix}`, encodeCallbackData({ type: 'pickCourt', sid, courtId: option.courtId }));
    }
    keyboard.row();
  }
  keyboard.text('↩ Убрать последний', encodeCallbackData({ type: 'undo', sid }));
  if (choices.length > 0) keyboard.text('Готово ▶', encodeCallbackData({ type: 'review', sid }));
  keyboard.row().text('📅 Другая дата', encodeCallbackData({ type: 'toDates', sid })).text('✖ Выйти', encodeCallbackData({ type: 'abort', sid }));

  const lines = [
    `<b>${formatDayLong(input.gameDate)}</b> · 90 мин`,
    windowLine(input.open, input.opensAtMs),
    ...(input.hasOwnBooking ? ['⚠️ На эту дату у вас уже есть бронь: задание будет отклонено (одна бронь в день).'] : []),
    ...modeHint(input.mode),
    '',
    ...chosenBlock(choices),
    '',
    courtPrompt(input.options),
  ];
  return { text: withNotice(lines, input.notice), keyboard };
};

export interface TimesViewInput {
  readonly sid: string;
  readonly gameDate: GameDate;
  readonly courtId: number;
  readonly starts: readonly number[];
  readonly choices: readonly SlotChoice[];
  readonly notice?: string;
}

export const timesView = (input: TimesViewInput): View => {
  const { sid, courtId, choices } = input;
  const picked = new Set(choices.filter((choice) => choice.courtId === courtId).map((choice) => choice.startMinutes));
  const keyboard = new InlineKeyboard();
  for (const row of chunk(input.starts, TIMES_PER_ROW)) {
    for (const start of row) {
      const label = `${picked.has(start) ? '✓ ' : ''}${formatClock(start)}`;
      keyboard.text(label, encodeCallbackData({ type: 'pickTime', sid, courtId, startMinutes: start }));
    }
    keyboard.row();
  }
  keyboard.text('◀ К кортам', encodeCallbackData({ type: 'toCourts', sid })).text('↩ Убрать последний', encodeCallbackData({ type: 'undo', sid }));

  const lines = [
    `<b>${courtName(courtId)}</b> · ${formatDayShort(input.gameDate)}`,
    input.starts.length === 0 ? 'На этом корте нет свободных слотов на 90 минут.' : 'Выберите время начала (игра 90 минут):',
    '',
    ...chosenBlock(choices),
  ];
  return { text: withNotice(lines, input.notice), keyboard };
};

export interface ConfirmViewInput {
  readonly sid: string;
  readonly gameDate: GameDate;
  readonly open: boolean;
  readonly opensAtMs: number;
  readonly choices: readonly SlotChoice[];
  readonly durationMinutes: number;
  readonly notice?: string;
}

export const confirmView = (input: ConfirmViewInput): View => {
  const { sid } = input;
  const keyboard = new InlineKeyboard()
    .text('✅ Подтвердить', encodeCallbackData({ type: 'confirm', sid }))
    .row()
    .text('◀ Назад', encodeCallbackData({ type: 'toCourts', sid }))
    .text('✖ Отмена', encodeCallbackData({ type: 'abort', sid }));
  const lines = [
    '<b>Проверьте задание</b>',
    `Дата: <b>${formatDayLong(input.gameDate)}</b>`,
    `Длительность: ${input.durationMinutes} мин`,
    'Оплата: из монедеро (виртуальный кошелёк клуба)',
    windowLine(input.open, input.opensAtMs),
    '',
    'Варианты по приоритету:',
    ...input.choices.map(
      (choice, index) => `${index + 1}. ${courtName(choice.courtId)}, ${formatTimeRange(choice.startMinutes, input.durationMinutes)}`,
    ),
  ];
  return { text: withNotice(lines, input.notice), keyboard };
};
