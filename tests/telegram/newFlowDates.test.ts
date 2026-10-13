import { beforeEach, describe, expect, it } from 'vitest';
import { FakeJobService, createdResult, daySchedule, date } from './_fakes.js';
import { createHarness, type Harness } from './_harness.js';

const D20 = date('2026-10-20'); // Tuesday, window already open at the fake "now"
const D21 = date('2026-10-21'); // Wednesday, opens tomorrow 07:00 Madrid
const D17 = date('2026-10-17'); // Saturday

const weekdaySchedule = () =>
  daySchedule(D20, {
    1: [1080, 1170], // academy court: present on the site, never offered on a weekday
    4: [1080, 1170],
    9: [1080, { start: 1170, free: false }],
    10: [1080, 1170],
    11: [{ start: 1080, free: false }, { start: 1170, free: false }],
    12: [1170],
  });

let service: FakeJobService;
let h: Harness;

beforeEach(async () => {
  service = new FakeJobService();
  service.schedules.set(D20, weekdaySchedule());
  h = await createHarness({ service });
});

const labels = (): string[] => h.buttons().map((button) => button.text);

describe('/new: a date that is not open yet', () => {
  beforeEach(() => {
    service.getDayCalls.length = 0;
  });

  it('offers the typical grid of the latest open day when the schedule of the chosen date is unavailable', async () => {
    await h.say('/new');
    await h.press('ср 21.10');
    expect(service.getDayCalls).toEqual([D21, D20]);
    expect(h.screen().text).toContain('Окно откроется: 14.10 07:00 Madrid.');
    expect(h.screen().text).toContain('Расписания на эту дату ещё нет');
    // all weekday courts, no academy courts
    expect(labels().filter((text) => text.startsWith('Pista'))).toEqual([
      'Pista 4 semicubierta',
      'Pista 7 semicubierta',
      'Pista 8 exterior',
      'Pista 9 exterior',
      'Pista 10 exterior',
    ]);
    await h.press('Pista 9');
    // union of the start times of the open day, booked or not
    expect(labels().filter((text) => /^\d\d:\d\d$/.test(text))).toEqual(['18:00', '19:30']);
  });

  it('runs to a created job on such a date and tells the owner when the window opens', async () => {
    service.createResult = (input) => createdResult({}, { gameDate: input.gameDate, opensAtMs: 1 });
    await h.say('/new');
    await h.press('ср 21.10');
    await h.press('Pista 9');
    await h.press('19:30');
    await h.press('Готово');
    expect(h.screen().text).toContain('Окно откроется: 14.10 07:00 Madrid.');
    await h.press('Подтвердить');
    expect(service.createJobCalls[0]?.gameDate).toBe(D21);
    expect(h.screen().text).toContain('Задание создано');
  });

  it('uses the schedule of the chosen date itself when the service has one', async () => {
    service.schedules.set(D21, daySchedule(D21, { 4: [600, 690] }));
    await h.say('/new');
    await h.press('ср 21.10');
    expect(service.getDayCalls).toEqual([D21]);
    expect(labels().filter((text) => text.startsWith('Pista'))).toEqual(['Pista 4 semicubierta · 2']);
  });

  it('falls back to the common half-hour keyboard 09:00-21:00 when no schedule at all is available', async () => {
    service.schedules.clear();
    await h.say('/new');
    await h.press('ср 21.10');
    expect(h.screen().text).toContain('Расписание недоступно');
    await h.press('Pista 4');
    const times = labels().filter((text) => /^\d\d:\d\d$/.test(text));
    expect(times).toHaveLength(25);
    expect(times[0]).toBe('09:00');
    expect(times[1]).toBe('09:30');
    expect(times.at(-1)).toBe('21:00');
  });

  it('treats a hanging schedule request as unavailable instead of blocking the bot', async () => {
    service.hangGetDay = true;
    h.clock.sleepMode = 'immediate';
    await h.say('/new');
    await h.press('ср 21.10');
    expect(h.screen().text).toContain('Расписание недоступно');
    expect(h.logs.entries.some((entry) => entry.msg?.includes('timed out'))).toBe(true);
  });

  it('an open day without a usable schedule also falls back to the common keyboard', async () => {
    service.schedules.clear();
    await h.say('/new');
    await h.press('вт 20.10');
    expect(h.screen().text).toContain('Расписание недоступно');
    await h.press('Pista 4');
    expect(labels().filter((text) => /^\d\d:\d\d$/.test(text))).toHaveLength(25);
  });
});

describe('/new: the open rule the service is built with', () => {
  // 13.10 08:00 Madrid with "5 days ahead, 09:00": 17.10 has been open since 12.10 09:00, 18.10 opens today at 09:00.
  const openRule = { daysAhead: 5, hour: 9 };

  it('offers dates, "open" labels and opening times from that rule, not from the default one', async () => {
    const ruled = await createHarness({ service, openRule });
    await ruled.say('/new');
    const texts = ruled.buttons().map((button) => button.text);
    expect(texts).toContain('сб 17.10 · открыто');
    expect(texts).toContain('вс 18.10 · откроется 13.10 09:00');
    expect(texts.some((text) => text.includes('19.10'))).toBe(false);
    expect(texts.some((text) => text.includes('20.10'))).toBe(false);
  });

  it('refuses a date beyond that rule even when its button is forged', async () => {
    const ruled = await createHarness({ service, openRule });
    await ruled.say('/new');
    const forged = ruled.buttons().find((button) => button.text.includes('сб 17.10'))?.data ?? '';
    const sid = forged.split(':')[2] ?? '';
    await ruled.pressData(`n:d:${sid}:2026-10-20`);
    expect(ruled.answers().at(-1)?.payload['text']).toBe('Эта дата сейчас недоступна для выбора');
    expect(service.getDayCalls).toEqual([]);
  });

  it('takes the typical grid from the latest day that is open under that rule, and shows its opening time', async () => {
    service.schedules.set(D17, daySchedule(D17, { 4: [1080, 1170] }));
    service.getDayCalls.length = 0;
    const ruled = await createHarness({ service, openRule });
    await ruled.say('/new');
    await ruled.press('вс 18.10');
    expect(service.getDayCalls).toEqual([date('2026-10-18'), D17]);
    await ruled.press('Pista 4');
    await ruled.press('18:00');
    await ruled.press('Готово');
    expect(ruled.screen().text).toContain('Окно откроется: 13.10 09:00 Madrid.');
  });

  it('the default rule is used when none is given', async () => {
    await h.say('/new');
    expect(labels()).toContain('вт 20.10 · открыто');
    expect(labels()).toContain('ср 21.10 · откроется 14.10 07:00');
  });
});

describe('/new: weekend days offer every court', () => {
  it('offers the academy courts on a Saturday and books one of them by resource id', async () => {
    service.schedules.set(D17, daySchedule(D17, { 1: [1080], 7: [1080], 4: [1080] }));
    await h.say('/new');
    await h.press('сб 17.10');
    expect(labels().filter((text) => text.startsWith('Pista'))).toEqual([
      'Pista 1 semicubierta · 1',
      'Pista 4 semicubierta · 1',
      'Pista 5 semicubierta · 1',
    ]);
    await h.press('Pista 5');
    await h.press('18:00');
    await h.press('Готово');
    await h.press('Подтвердить');
    expect(service.createJobCalls[0]?.choices).toEqual([{ courtId: 7, startMinutes: 1080 }]);
  });
});

describe('/new: the slot is re-checked when it is picked', () => {
  it('refuses a slot that was taken after the list was shown and tells the owner', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Pista 4');
    service.schedules.set(D20, daySchedule(D20, { 4: [{ start: 1080, free: false }, 1170] }));
    await h.press('18:00');
    expect(h.screen().text).toContain('Этот слот уже занят или недоступен.');
    expect(h.screen().text).toContain('Пока ничего не выбрано.');
    expect(labels()).not.toContain('18:00');
    expect(labels()).toContain('19:30');
  });

  it('accepts the pick from the earlier snapshot when the site cannot be asked again', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Pista 4');
    service.getDayFails.add(D20);
    await h.press('18:00');
    expect(h.screen().text).toContain('1. Pista 4 semicubierta, 18:00');
  });
});
