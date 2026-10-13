import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/contracts.js';
import { jobBlock } from '../../src/telegram/jobText.js';
import { jobsText } from '../../src/telegram/reports.js';
import { NOW_MS, date, makeJob } from './_fakes.js';

const MAX_LIST_CHARS = 3600;
const ACTIVE_HEADING = '<b>Активные задания</b>';
const RECENT_HEADING = '<b>Недавние</b>';

const active = (id: number): Job => makeJob({ id, state: 'scheduled', gameDate: date('2026-10-20'), opensAtMs: NOW_MS + 3_600_000 });
const finished = (id: number, updatedAtMs: number, patch: Partial<Job> = {}): Job =>
  makeJob({ id, state: 'failed', failureReason: 'slot taken', updatedAtMs, ...patch });

const blocksOf = (text: string): string[] => text.split('\n\n');

describe('jobsText: the list budget and its headings', () => {
  it('shows at most the five most recently changed finished jobs, newest first', () => {
    const jobs = Array.from({ length: 8 }, (_, index) => finished(index + 1, 1_000 * (index + 1)));
    const text = jobsText(jobs);
    const shown = [...text.matchAll(/<b>#(\d+)<\/b>/g)].map((match) => Number(match[1]));
    expect(shown).toEqual([8, 7, 6, 5, 4]);
    expect(text).not.toContain('<b>#3</b>');
    expect(text).not.toContain('показано не всё');
  });

  it('five recent jobs is exactly the limit: a sixth is not shown, and a list of five shows all of them', () => {
    expect([...jobsText(Array.from({ length: 5 }, (_, i) => finished(i + 1, i))).matchAll(/<b>#/g)]).toHaveLength(5);
    expect([...jobsText(Array.from({ length: 6 }, (_, i) => finished(i + 1, i))).matchAll(/<b>#/g)]).toHaveLength(5);
  });

  it('active jobs are never limited to five (only the finished ones are)', () => {
    const jobs = Array.from({ length: 9 }, (_, index) => active(index + 1));
    expect([...jobsText(jobs).matchAll(/<b>#/g)]).toHaveLength(9);
  });

  it('a heading with no job under it is dropped: active jobs that fill the budget leave no room for the recent ones', () => {
    const recent = finished(900, 1, { failureReason: 'x'.repeat(150) });
    const block = jobBlock(active(10)).length;
    expect(jobBlock(recent).length).toBeGreaterThanOrEqual(block);

    // as many active jobs as fit while the "recent" heading still fits behind them, but no recent job does
    const used = (n: number): number => ACTIVE_HEADING.length + 2 + n * (block + 2);
    let count = 1;
    while (used(count + 1) + RECENT_HEADING.length <= MAX_LIST_CHARS) count += 1;
    expect(used(count) + RECENT_HEADING.length).toBeLessThanOrEqual(MAX_LIST_CHARS);
    expect(used(count) + RECENT_HEADING.length + 2 + jobBlock(recent).length).toBeGreaterThan(MAX_LIST_CHARS);

    const jobs = [...Array.from({ length: count }, (_, index) => active(10 + index)), recent];
    const text = jobsText(jobs);
    expect(text).not.toContain(RECENT_HEADING);
    expect(text).not.toContain('<b>#900</b>');
    expect(text).toContain('ещё заданий: 1');
    expect(text.length).toBeLessThanOrEqual(4096);
  });

  it('never ends with a heading, whatever the number of active jobs (every boundary of the budget)', () => {
    for (let count = 1; count <= 40; count += 1) {
      const jobs = [...Array.from({ length: count }, (_, index) => active(10 + index)), finished(900, 1), finished(901, 2)];
      const text = jobsText(jobs);
      const parts = blocksOf(text.replace(/\n\n… показано не всё.*$/s, ''));
      expect(parts.at(-1), `count ${count}`).not.toBe(ACTIVE_HEADING);
      expect(parts.at(-1), `count ${count}`).not.toBe(RECENT_HEADING);
      expect(text.length, `count ${count}`).toBeLessThanOrEqual(4096);
    }
  });

  it('counts the jobs it left out, not the headings', () => {
    const jobs = Array.from({ length: 60 }, (_, index) => active(index + 1));
    const text = jobsText(jobs);
    const shown = [...text.matchAll(/<b>#\d+<\/b>/g)].length;
    expect(text).toContain(`ещё заданий: ${60 - shown}`);
  });

  it('with nothing active the list starts with the recent heading only', () => {
    const text = jobsText([finished(1, 5)]);
    expect(text.startsWith(RECENT_HEADING)).toBe(true);
    expect(text).not.toContain(ACTIVE_HEADING);
  });

  it('says there are no jobs when there are none', () => {
    expect(jobsText([])).toContain('Заданий пока нет');
  });

  it('a window that has opened is shown as opened when the time is known', () => {
    const job = active(1);
    expect(jobsText([job], NOW_MS)).toContain('Окно откроется');
    expect(jobsText([job], NOW_MS + 4_000_000)).toContain('Окно открылось');
    expect(jobsText([job])).toContain('Окно откроется');
  });
});
