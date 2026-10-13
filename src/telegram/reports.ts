import type { Job, StatusReport } from '../contracts.js';
import { formatDayMonth, formatMadrid, formatMoney } from './format.js';
import { isActiveState, jobBlock, jobLine } from './jobText.js';

/** Telegram allows 4096 characters; the list stops earlier and says how much is left out. */
const MAX_LIST_CHARS = 3600;
const MAX_RECENT_JOBS = 5;

export const HELP_TEXT = [
  '<b>Бот бронирования падела</b>',
  'Бронирует корт в момент открытия окна (по времени Madrid) и оплачивает из монедеро.',
  '',
  '/new — создать задание: дата, корты и время, подтверждение',
  '/jobs — активные и недавние задания',
  '/cancel 5 — отменить задание №5 (с подтверждением)',
  '/status — состояние бота, сессии и ближайшего окна',
  '/wallet — баланс монедеро',
  '/stop — аварийная остановка: бот перестаёт слать запросы на бронь',
  '/resume — снять аварийную остановку',
].join('\n');

export const UNKNOWN_INPUT_TEXT = 'Не понимаю. Команды: /help';

export const STOP_TEXT = [
  '⛔ <b>Аварийная остановка включена.</b>',
  'Бот больше не отправляет запросы на бронь. Уже созданные брони не затронуты.',
  'Снять остановку: /resume',
].join('\n');

export const RESUME_TEXT = '▶️ Аварийная остановка снята: заряженные задания снова будут бронировать. Проверьте /status.';

const byGameDateThenId = (a: Job, b: Job): number => {
  if (a.gameDate !== b.gameDate) return a.gameDate < b.gameDate ? -1 : 1;
  return a.id - b.id;
};

interface Entry {
  readonly text: string;
  readonly heading: boolean;
}

const heading = (text: string): Entry => ({ text, heading: true });
const jobEntry = (job: Job, nowMs: number | undefined): Entry => ({ text: jobBlock(job, nowMs), heading: false });

/** Active jobs by date, then the most recently changed finished ones; long lists are cut at a job boundary. */
export const jobsText = (jobs: readonly Job[], nowMs?: number): string => {
  const active = jobs.filter((job) => isActiveState(job.state)).sort(byGameDateThenId);
  const recent = jobs
    .filter((job) => !isActiveState(job.state))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, MAX_RECENT_JOBS);
  if (active.length + recent.length === 0) return 'Заданий пока нет. Создать: /new';

  const entries: Entry[] = [
    ...(active.length > 0 ? [heading('<b>Активные задания</b>')] : []),
    ...active.map((job) => jobEntry(job, nowMs)),
    ...(recent.length > 0 ? [heading('<b>Недавние</b>')] : []),
    ...recent.map((job) => jobEntry(job, nowMs)),
  ];
  const shown: Entry[] = [];
  let length = 0;
  for (const entry of entries) {
    if (length + entry.text.length > MAX_LIST_CHARS) break;
    shown.push(entry);
    length += entry.text.length + 2;
  }
  while (shown.at(-1)?.heading === true) shown.pop();
  const texts = shown.map((entry) => entry.text);
  const hiddenJobs = entries.filter((entry) => !entry.heading).length - shown.filter((entry) => !entry.heading).length;
  if (hiddenJobs > 0) texts.push(`… показано не всё (ещё заданий: ${hiddenJobs}). Отменить: /cancel номер`);
  return texts.join('\n\n');
};

export const walletText = (balanceCents: number): string => `Монедеро: ${formatMoney(balanceCents)}`;

const sessionLine = (alive: boolean | null): string => {
  if (alive === null) return 'не проверялась';
  return alive ? 'активна' : 'не активна';
};

export const statusText = (report: StatusReport): string => {
  const lines = [
    '<b>Состояние</b>',
    report.stopped
      ? '⛔ Аварийная остановка ВКЛЮЧЕНА: бот не отправляет запросы на бронь. Снять: /resume'
      : '🟢 Работает',
    `Сессия на сайте: ${sessionLine(report.sessionAlive)}`,
    `Монедеро: ${report.walletCents === null ? 'не удалось прочитать' : formatMoney(report.walletCents)}`,
    `Ближайшее открытие окна: ${report.nextWindowOpensAtMs === null ? 'нет заряженных заданий' : `${formatMadrid(report.nextWindowOpensAtMs)} Madrid`}`,
  ];
  lines.push(
    report.upcomingHolidays.length === 0
      ? 'Праздники в ближайшие 30 дней: нет'
      : `Праздники в ближайшие 30 дней: ${report.upcomingHolidays.map(formatDayMonth).join(', ')} (в эти дни доступны все корты)`,
  );
  if (report.activeJobs.length === 0) {
    lines.push('Активных заданий нет.');
  } else {
    lines.push('', `Активные задания (${report.activeJobs.length}):`, ...report.activeJobs.slice(0, 10).map(jobLine));
  }
  return lines.join('\n');
};
