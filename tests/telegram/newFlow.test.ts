import { beforeEach, describe, expect, it } from 'vitest';
import { FakeJobService, daySchedule, date } from './_fakes.js';
import { createHarness, type Harness } from './_harness.js';

const D20 = date('2026-10-20'); // Tuesday, window already open at the fake "now"

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

describe('/new: date step', () => {
  it('offers today up to the furthest open date plus one, marking open and not-yet-open days', async () => {
    await h.say('/new');
    const dates = labels().filter((text) => /\d\d\.\d\d ·/.test(text));
    expect(dates).toEqual([
      'вт 13.10 · открыто',
      'ср 14.10 · открыто',
      'чт 15.10 · открыто',
      'пт 16.10 · открыто',
      'сб 17.10 · открыто',
      'вс 18.10 · открыто',
      'пн 19.10 · открыто',
      'вт 20.10 · открыто',
      'ср 21.10 · откроется 14.10 07:00',
    ]);
    expect(labels().at(-1)).toContain('Выйти');
  });

  it('sends HTML with link previews disabled', async () => {
    await h.say('/new');
    const call = h.transport.of('sendMessage')[0];
    expect(call?.payload['parse_mode']).toBe('HTML');
    expect(call?.payload['link_preview_options']).toEqual({ is_disabled: true });
  });

  it('keeps every callback_data within the 64 byte Telegram limit', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Pista 8');
    for (const button of h.buttons()) expect(new TextEncoder().encode(button.data).length).toBeLessThanOrEqual(64);
  });
});

describe('/new: a complete conversation on an open day with a real schedule', () => {
  it('walks dates -> courts -> times -> summary -> confirm and calls createJob with the ordered choices', async () => {
    await h.say('/new');
    await h.press('вт 20.10');

    // only courts of the weekday allow-list; the academy court 1 is NOT offered although the site lists it
    expect(labels().filter((text) => text.startsWith('Pista'))).toEqual([
      'Pista 4 semicubierta · 2',
      'Pista 7 semicubierta · 1',
      'Pista 8 exterior · 2',
      'Pista 10 exterior · 1',
    ]);
    expect(h.screen().text).toContain('Окно бронирования уже открыто.');
    expect(h.screen().text).toContain('Пока ничего не выбрано.');
    expect(h.screen().text).toContain('Выберите корт (число — свободные старты):');

    await h.press('Pista 7');
    expect(labels().filter((text) => /^\d\d:\d\d$/.test(text))).toEqual(['18:00']);
    await h.press('18:00');
    expect(h.screen().text).toContain('1. Pista 7 semicubierta, 18:00');

    await h.press('Pista 8');
    expect(labels().filter((text) => /^\d\d:\d\d$/.test(text))).toEqual(['18:00', '19:30']);
    await h.press('19:30');
    expect(h.screen().text).toContain('1. Pista 7 semicubierta, 18:00');
    expect(h.screen().text).toContain('2. Pista 8 exterior, 19:30');

    await h.press('Готово');
    const summary = h.screen().text;
    expect(summary).toContain('вт 20.10.2026');
    expect(summary).toContain('90 мин');
    expect(summary).toContain('из монедеро');
    expect(summary).toContain('1. Pista 7 semicubierta, 18:00–19:30');
    expect(summary).toContain('2. Pista 8 exterior, 19:30–21:00');
    expect(service.createJobCalls).toEqual([]);

    await h.press('Подтвердить');
    expect(service.createJobCalls).toEqual([
      {
        gameDate: D20,
        choices: [
          { courtId: 9, startMinutes: 1080 },
          { courtId: 10, startMinutes: 1170 },
        ],
        durationMinutes: 90,
        payment: 'wallet',
      },
    ]);
    expect(h.screen().text).toContain('Задание создано');
    expect(h.screen().text).toContain('#7');
    expect(h.screen().buttons).toEqual([]);
  });

  it('answers every callback query exactly once', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Pista 7');
    await h.press('18:00');
    await h.press('Готово');
    await h.press('Подтвердить');
    expect(h.answers()).toHaveLength(5);
  });

  it('shows only free slots that fit 90 minutes (Pista 7 has one taken slot)', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Pista 7');
    expect(labels()).toContain('18:00');
    expect(labels()).not.toContain('19:30');
  });

  it('hides courts without any free slot (Pista 9 is fully booked)', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    expect(labels().some((text) => text.startsWith('Pista 9'))).toBe(false);
  });

  it('offers no "Готово" before something is picked, and marks picked times with a check', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    expect(labels().some((text) => text.includes('Готово'))).toBe(false);
    await h.press('Pista 4');
    await h.press('18:00');
    expect(labels().some((text) => text.includes('Готово'))).toBe(true);
    await h.press('Pista 4');
    expect(labels()).toContain('✓ 18:00');
    expect(labels()).toContain('19:30');
  });

  it('undo removes the last choice; with nothing to undo it only shows a notice', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Убрать последний');
    expect(h.transport.of('answerCallbackQuery').at(-1)?.payload['text']).toBe('Пока нечего убирать');

    await h.press('Pista 4');
    await h.press('18:00');
    await h.press('Pista 8');
    await h.press('19:30');
    expect(h.screen().text).toContain('2. Pista 8 exterior, 19:30');
    await h.press('Убрать последний');
    expect(h.screen().text).toContain('1. Pista 4 semicubierta, 18:00');
    expect(h.screen().text).not.toContain('Pista 8 exterior, 19:30');
    await h.press('Убрать последний');
    expect(h.screen().text).toContain('Пока ничего не выбрано.');
  });

  it('refuses to pick the same court and time twice', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Pista 4');
    await h.press('18:00');
    await h.press('Pista 4');
    const before = h.screens().length;
    await h.press('✓ 18:00');
    expect(h.screens()).toHaveLength(before);
    expect(h.transport.of('answerCallbackQuery').at(-1)?.payload['text']).toBe('Этот вариант уже выбран');
  });

  it('stops at the maximum number of choices', async () => {
    const wide = daySchedule(D20, { 4: [540, 630, 720, 810, 900, 990, 1080, 1170, 1260], 9: [540, 630] });
    service.schedules.set(D20, wide);
    await h.say('/new');
    await h.press('вт 20.10');
    for (const time of ['09:00', '10:30', '12:00', '13:30', '15:00', '16:30', '18:00', '19:30']) {
      await h.press('Pista 4');
      await h.press(time);
    }
    await h.press('Pista 4');
    const before = h.screens().length;
    await h.press('21:00');
    expect(h.screens()).toHaveLength(before);
    expect(String(h.transport.of('answerCallbackQuery').at(-1)?.payload['text'])).toContain('не больше 8');
    expect(h.screen().text).toContain('8. Pista 4 semicubierta, 19:30');
  });

  it('warns when the schedule shows an own booking on that date', async () => {
    service.schedules.set(D20, daySchedule(D20, { 4: [1080, { start: 1170, free: false, ownBooking: true }] }));
    await h.say('/new');
    await h.press('вт 20.10');
    expect(h.screen().text).toContain('у вас уже есть бронь');
  });

  it('"Другая дата" goes back to the dates and drops the choices', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Pista 4');
    await h.press('18:00');
    await h.press('Другая дата');
    expect(h.screen().text).toContain('Выбор сброшен');
    expect(labels().some((text) => text.includes('вт 20.10'))).toBe(true);
    await h.press('вт 20.10');
    expect(h.screen().text).toContain('Пока ничего не выбрано.');
  });

  it('"К кортам" returns from the times to the courts', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Pista 4');
    await h.press('К кортам');
    expect(labels().some((text) => text.startsWith('Pista 4'))).toBe(true);
  });

  it('"Назад" on the summary returns to the pick screen with the choices intact', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Pista 4');
    await h.press('18:00');
    await h.press('Готово');
    await h.press('Назад');
    expect(h.screen().text).toContain('1. Pista 4 semicubierta, 18:00');
    expect(labels().some((text) => text.includes('Готово'))).toBe(true);
  });

  it('"Выйти" ends the conversation; its buttons are stale afterwards', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    const staleData = h.buttons().find((button) => button.text.startsWith('Pista 4'))?.data ?? '';
    await h.press('Выйти');
    expect(h.screen().text).toContain('отменено');
    await h.pressData(staleData);
    expect(h.transport.of('answerCallbackQuery').at(-1)?.payload['text']).toContain('устарела');
    expect(service.createJobCalls).toEqual([]);
  });

  it('a newer /new makes the buttons of the previous one stale', async () => {
    await h.say('/new');
    const oldDate = h.buttons().find((button) => button.text.includes('вт 20.10'))?.data ?? '';
    await h.say('/new');
    await h.pressData(oldDate);
    expect(h.transport.of('answerCallbackQuery').at(-1)?.payload['text']).toBe('Кнопка устарела, начните /new');
    await h.press('вт 20.10');
    expect(h.screen().text).toContain('Выберите корт');
  });
});

describe('/new: editing the screen in place', () => {
  it('tells the owner the opening times are in Madrid time', async () => {
    await h.say('/new');
    expect(h.screen().text).toContain('по Madrid');
  });

  it('a screen that did not change ("message is not modified") is not an error and sends nothing new', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    h.transport.failNext('editMessageText', { code: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' });
    const sent = h.transport.of('sendMessage').length;
    await h.press('Pista 4');
    expect(h.transport.of('sendMessage')).toHaveLength(sent);
    expect(h.logs.entries.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it('when the old message cannot be edited any more the screen is sent as a new message', async () => {
    await h.say('/new');
    h.transport.failNext('editMessageText', { code: 400, description: 'Bad Request: message to edit not found' });
    await h.press('вт 20.10');
    expect(h.screen().method).toBe('sendMessage');
    expect(h.screen().text).toContain('Выберите корт');
    expect(h.buttons().some((button) => button.text.startsWith('Pista 4'))).toBe(true);
  });

  it('a failing answerCallbackQuery does not break the flow', async () => {
    await h.say('/new');
    h.transport.failNext('answerCallbackQuery', { code: 400, description: 'Bad Request: query is too old and response timeout expired' });
    await h.press('вт 20.10');
    expect(h.screen().text).toContain('Выберите корт');
  });
});
