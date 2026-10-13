import { describe, expect, it } from 'vitest';
import type { DayCourt } from '../../src/contracts.js';
import {
  COMMON_START_MINUTES,
  courtOptions,
  freeStarts,
  gridStarts,
  hasOwnBooking,
  latestOpenDate,
  offeredDates,
  startsFor,
  startsForCourt,
} from '../../src/telegram/schedule.js';
import { loadPickerMode } from '../../src/telegram/picker.js';
import { createLogRecorder } from './_harness.js';
import { FakeClock, FakeJobService, NOW_MS, daySchedule, date } from './_fakes.js';

const court = (...slots: { start: number; end: number; free?: boolean }[]): DayCourt => ({
  courtId: 4,
  name: 'x',
  slots: slots.map((slot) => ({
    startMinutes: slot.start,
    endMinutes: slot.end,
    durationMinutes: slot.end - slot.start,
    free: slot.free ?? true,
    ownBooking: false,
  })),
});

const madrid = (iso: string): number => {
  const [day, time] = iso.split(' ') as [string, string];
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  // helper for summer time only (UTC+2) and winter time (UTC+1) is chosen by the caller through the date
  const offset = Date.UTC(y, m - 1, d) >= Date.UTC(y, 9, 25) || Date.UTC(y, m - 1, d) < Date.UTC(y, 2, 29) ? 1 : 2;
  return Date.UTC(y, m - 1, d, hh - offset, mm);
};

describe('startsFor: which start times fit a 90 minute game', () => {
  it('a free 90 minute slot fits by itself', () => {
    expect(freeStarts(court({ start: 1080, end: 1170 }, { start: 1170, end: 1260 }), 90)).toEqual([1080, 1170]);
  });

  it('a taken slot never starts a game', () => {
    expect(freeStarts(court({ start: 1080, end: 1170, free: false }, { start: 1170, end: 1260 }), 90)).toEqual([1170]);
  });

  it('a 60 minute slot needs the next slot to be free and adjacent', () => {
    const grid = court({ start: 1080, end: 1140 }, { start: 1140, end: 1200 }, { start: 1200, end: 1260, free: false });
    expect(freeStarts(grid, 90)).toEqual([1080]);
  });

  it('a gap between slots breaks the run', () => {
    expect(freeStarts(court({ start: 1080, end: 1140 }, { start: 1150, end: 1210 }), 90)).toEqual([]);
  });

  it('three back-to-back free 30 minute slots make a 90 minute game, two do not', () => {
    const half = (start: number, free = true) => ({ start, end: start + 30, free });
    expect(freeStarts(court(half(1080), half(1110), half(1140)), 90)).toEqual([1080]);
    expect(freeStarts(court(half(1080), half(1110), half(1140, false)), 90)).toEqual([]);
  });

  it('a slot longer than the game fits', () => {
    expect(freeStarts(court({ start: 600, end: 720 }), 90)).toEqual([600]);
  });

  it('sorts unsorted slots and ignores duplicates', () => {
    const slots = court({ start: 1170, end: 1260 }, { start: 1080, end: 1170 }, { start: 1080, end: 1170 });
    expect(freeStarts(slots, 90)).toEqual([1080, 1170]);
  });

  it('runs of 30/60/90 minute slots give the same starts in every input order (the order alone must not matter)', () => {
    const a = { start: 540, end: 600 };
    const b = { start: 600, end: 630 };
    const c = { start: 630, end: 720 };
    const orders = [
      [a, b, c],
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ];
    for (const order of orders) {
      expect(freeStarts(court(...order), 90)).toEqual([540, 600, 630]);
      expect(startsFor(court(...order), 90, false)).toEqual([540, 600, 630]);
    }
  });

  it('a back-to-back run is found even when its first slot comes last in the input', () => {
    expect(freeStarts(court({ start: 630, end: 720, free: false }, { start: 540, end: 600 }, { start: 600, end: 630 }), 90)).toEqual([540]);
    expect(freeStarts(court({ start: 600, end: 630 }, { start: 630, end: 720 }, { start: 540, end: 600 }), 90)).toEqual([540, 600, 630]);
  });

  it('with requireFree=false the free flag is ignored (the typical grid)', () => {
    const taken = court({ start: 1080, end: 1170, free: false }, { start: 1170, end: 1260, free: false });
    expect(startsFor(taken, 90, false)).toEqual([1080, 1170]);
    expect(startsFor(taken, 90, true)).toEqual([]);
  });

  it('an empty court has no start times', () => {
    expect(freeStarts(court(), 90)).toEqual([]);
  });

  it('respects other durations', () => {
    const grid = court({ start: 600, end: 660 }, { start: 660, end: 720 });
    expect(freeStarts(grid, 60)).toEqual([600, 660]);
    expect(freeStarts(grid, 120)).toEqual([600]);
  });
});

describe('gridStarts, hasOwnBooking, startsForCourt, courtOptions', () => {
  const d = date('2026-10-20');
  const schedule = daySchedule(d, { 4: [1080, { start: 1170, free: false }], 9: [1170, 1260] });

  it('gridStarts is the sorted union over all courts, free or not', () => {
    expect(gridStarts(schedule, 90)).toEqual([1080, 1170, 1260]);
  });

  it('detects an own booking', () => {
    expect(hasOwnBooking(schedule)).toBe(false);
    expect(hasOwnBooking(daySchedule(d, { 4: [{ start: 1080, ownBooking: true, free: false }] }))).toBe(true);
  });

  it('startsForCourt: free starts of the court in schedule mode, the fixed list in grid mode, nothing for an unknown court', () => {
    expect(startsForCourt({ kind: 'schedule', schedule }, 4, 90)).toEqual([1080]);
    expect(startsForCourt({ kind: 'schedule', schedule }, 9, 90)).toEqual([1170, 1260]);
    expect(startsForCourt({ kind: 'schedule', schedule }, 10, 90)).toEqual([]);
    expect(startsForCourt({ kind: 'grid', source: 'common', starts: [600, 630] }, 10, 90)).toEqual([600, 630]);
  });

  it('courtOptions drops courts without a free slot in schedule mode, keeps all in grid mode', () => {
    expect(courtOptions([4, 9, 10], { kind: 'schedule', schedule }, 90)).toEqual([
      { courtId: 4, startCount: 1 },
      { courtId: 9, startCount: 2 },
    ]);
    expect(courtOptions([4, 9, 10], { kind: 'grid', source: 'common', starts: [600] }, 90)).toEqual([
      { courtId: 4, startCount: null },
      { courtId: 9, startCount: null },
      { courtId: 10, startCount: null },
    ]);
  });

  it('the common keyboard is 09:00 to 21:00 every 30 minutes', () => {
    expect(COMMON_START_MINUTES).toHaveLength(25);
    expect(COMMON_START_MINUTES[0]).toBe(540);
    expect(COMMON_START_MINUTES.at(-1)).toBe(1260);
    COMMON_START_MINUTES.forEach((minutes, index) => {
      if (index > 0) expect(minutes - (COMMON_START_MINUTES[index - 1] ?? 0)).toBe(30);
    });
  });
});

describe('offeredDates: today up to the furthest open date plus one', () => {
  it('after 07:00: today + 8 days, the last one not open yet', () => {
    const offered = offeredDates(NOW_MS);
    expect(offered).toHaveLength(9);
    expect(offered[0]?.date).toBe('2026-10-13');
    expect(offered.at(-1)?.date).toBe('2026-10-21');
    expect(offered.filter((entry) => entry.open)).toHaveLength(8);
    expect(offered.at(-1)?.open).toBe(false);
    expect(offered.at(-1)?.opensAtMs).toBe(Date.UTC(2026, 9, 14, 5, 0, 0));
  });

  it('before 07:00 the furthest open date is one day shorter', () => {
    const offered = offeredDates(Date.UTC(2026, 9, 13, 4, 59, 59)); // 06:59:59 Madrid
    expect(offered.at(-1)?.date).toBe('2026-10-20');
    expect(offered.at(-1)?.open).toBe(false);
    expect(offered.at(-2)?.open).toBe(true);
    expect(latestOpenDate(Date.UTC(2026, 9, 13, 4, 59, 59))).toBe('2026-10-19');
  });

  it('exactly at 07:00 a new date opens', () => {
    const offered = offeredDates(Date.UTC(2026, 9, 13, 5, 0, 0));
    expect(offered.at(-1)?.date).toBe('2026-10-21');
    expect(offered.find((entry) => entry.date === '2026-10-20')?.open).toBe(true);
    expect(latestOpenDate(Date.UTC(2026, 9, 13, 5, 0, 0))).toBe('2026-10-20');
  });

  it('"today" is the club date: 00:30 in Madrid is already the next day', () => {
    expect(offeredDates(Date.UTC(2026, 9, 13, 22, 30, 0))[0]?.date).toBe('2026-10-14');
  });

  it('crosses the end of the daylight saving period without skipping or repeating a day', () => {
    const offered = offeredDates(madrid('2026-10-22 09:00'));
    expect(offered.map((entry) => entry.date)).toEqual([
      '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30',
    ]);
    // 1 Nov opens on 25 Oct at 07:00 CET (UTC+1), the day the clocks go back
    const later = offeredDates(madrid('2026-10-26 09:00'));
    expect(later.at(-1)?.date).toBe('2026-11-03');
    expect(later.find((entry) => entry.date === '2026-11-01')?.opensAtMs).toBe(Date.UTC(2026, 9, 25, 6, 0, 0));
  });

  it('crosses the end of the year and a leap day', () => {
    expect(offeredDates(madrid('2026-12-28 09:00')).map((entry) => entry.date)).toContain('2027-01-04');
    expect(offeredDates(madrid('2028-02-25 09:00')).map((entry) => entry.date)).toContain('2028-02-29');
  });

  it('every date is a strict, distinct, ascending YYYY-MM-DD', () => {
    const dates = offeredDates(NOW_MS).map((entry) => entry.date);
    expect(new Set(dates).size).toBe(dates.length);
    expect([...dates].sort()).toEqual(dates);
    for (const entry of dates) expect(entry).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('loadPickerMode', () => {
  const D20 = date('2026-10-20');
  const D21 = date('2026-10-21');
  const make = () => {
    const service = new FakeJobService();
    const clock = new FakeClock();
    const logs = createLogRecorder();
    return { service, clock, logs, deps: { service, clock, logger: logs.logger } };
  };

  it('uses the schedule of the date when it has slots on an allowed court', async () => {
    const { service, deps } = make();
    service.schedules.set(D20, daySchedule(D20, { 4: [1080] }));
    const mode = await loadPickerMode(deps, D20, NOW_MS);
    expect(mode.kind).toBe('schedule');
  });

  it('a schedule that only lists academy courts on a weekday is not usable', async () => {
    const { service, deps } = make();
    service.schedules.set(D20, daySchedule(D20, { 1: [1080], 7: [1080] }));
    const mode = await loadPickerMode(deps, D20, NOW_MS);
    expect(mode).toEqual({ kind: 'grid', source: 'common', starts: COMMON_START_MINUTES });
  });

  it('a schedule for another date than asked is not trusted', async () => {
    const { service, deps } = make();
    service.schedules.set(D20, daySchedule(D21, { 4: [1080] }));
    const mode = await loadPickerMode(deps, D20, NOW_MS);
    expect(mode.kind).toBe('grid');
  });

  it('a schedule whose courts have no slots at all is not usable', async () => {
    const { service, deps } = make();
    service.schedules.set(D20, daySchedule(D20, { 4: [], 9: [] }));
    expect((await loadPickerMode(deps, D20, NOW_MS)).kind).toBe('grid');
  });

  it('for a closed date builds the typical grid from the latest open day', async () => {
    const { service, deps } = make();
    service.schedules.set(D20, daySchedule(D20, { 4: [1080, { start: 1170, free: false }], 9: [600] }));
    const mode = await loadPickerMode(deps, D21, NOW_MS);
    expect(mode).toEqual({ kind: 'grid', source: 'open-day', starts: [600, 1080, 1170] });
  });

  it('for an open date without a schedule goes straight to the common keyboard', async () => {
    const { service, deps } = make();
    const mode = await loadPickerMode(deps, D20, NOW_MS);
    expect(mode.kind).toBe('grid');
    expect(service.getDayCalls).toEqual([D20]);
  });

  it('logs why a schedule is unavailable without leaking the error text of the site', async () => {
    const { service, deps, logs } = make();
    service.getDay = () => Promise.reject(new Error(`site said hash=${'0123456789abcdef'.repeat(3)}`));
    await loadPickerMode(deps, D21, NOW_MS);
    expect(logs.entries.some((entry) => entry.level === 'warn')).toBe(true);
    expect(logs.dump()).not.toContain('0123456789abcdef0123456789abcdef');
  });
});
