import { COURTS } from '../config/courts.js';

/** Integer cents => "19.02". */
export const formatEuros = (cents: number): string => {
  if (!Number.isSafeInteger(cents)) return '?';
  const absolute = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
};

/** Minutes from midnight => "18:00". */
export const formatClock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export const courtLabel = (courtId: number): string => COURTS.find((court) => court.id === courtId)?.name ?? `court id ${courtId}`;

const MAX_CELL_LENGTH = 40;

/** Text that came from the site, made safe to print in a table cell: no control characters, bounded length. */
export const plainCell = (text: string): string =>
  text
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CELL_LENGTH);

/** Left-aligned columns separated by two spaces, with a header and an underline. */
export const renderTable = (headers: readonly string[], rows: readonly (readonly string[])[]): string => {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
};
