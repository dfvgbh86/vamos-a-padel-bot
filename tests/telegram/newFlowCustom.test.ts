import { beforeEach, describe, expect, it } from 'vitest';
import { parseTypedTime } from '../../src/telegram/newJobFlow.js';
import { UNKNOWN_INPUT_TEXT } from '../../src/telegram/reports.js';
import { FakeJobService, daySchedule, date } from './_fakes.js';
import { createHarness, type Harness } from './_harness.js';

const D20 = date('2026-10-20');

let service: FakeJobService;
let h: Harness;

beforeEach(async () => {
  service = new FakeJobService();
  service.schedules.set(
    D20,
    daySchedule(D20, {
      4: [1080, 1170],
      10: [1080, 1170],
    }),
  );
  h = await createHarness({ service });
});

const labels = (): string[] => h.buttons().map((button) => button.text);

describe('parseTypedTime', () => {
  it('accepts H:MM, HH:MM and HH.MM', () => {
    expect(parseTypedTime('18:30')).toBe(1110);
    expect(parseTypedTime(' 8:05 ')).toBe(485);
    expect(parseTypedTime('18.30')).toBe(1110);
  });

  it('refuses anything else', () => {
    for (const raw of ['24:00', '18:60', '1830', '18', 'вечером', '18:3', '18:30 завтра', '']) expect(parseTypedTime(raw)).toBeNull();
  });
});

describe('/new: duration 60 or 90 minutes', () => {
  it('offers both lengths on the courts screen, 90 marked by default', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    expect(labels()).toContain('⏱ 60 мин');
    expect(labels()).toContain('✓ ⏱ 90 мин');
    expect(h.screen().text).toContain('90 мин');
  });

  it('switching to 60 minutes drops earlier picks with a notice, and the job is created for 60 minutes', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Pista 8');
    await h.press('18:00');
    expect(h.screen().text).toContain('1. Pista 8 exterior, 18:00');

    await h.press('⏱ 60 мин');
    expect(h.screen().text).toContain('прежние варианты сброшены');
    expect(h.screen().text).toContain('Пока ничего не выбрано.');
    expect(labels()).toContain('✓ ⏱ 60 мин');

    await h.press('Pista 8');
    await h.press('18:00');
    await h.press('Готово');
    expect(h.screen().text).toContain('Длительность: 60 мин');
    expect(h.screen().text).toContain('18:00–19:00');
    await h.press('Подтвердить');
    expect(service.createJobCalls).toEqual([
      { gameDate: D20, choices: [{ courtId: 10, startMinutes: 1080 }], durationMinutes: 60, payment: 'wallet' },
    ]);
  });

  it('pressing the length that is already chosen changes nothing', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Pista 8');
    await h.press('18:00');
    await h.press('✓ ⏱ 90 мин');
    expect(h.screen().text).toContain('1. Pista 8 exterior, 18:00');
  });
});

describe('/new: a typed start time', () => {
  const toTimes = async (): Promise<void> => {
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Pista 8');
  };

  it('the times screen says that a time can be typed, and the buttons keep working', async () => {
    await toTimes();
    expect(h.screen().text).toContain('напишите своё сообщением, например 18:30');
    expect(labels()).toContain('18:00');
    await h.press('18:00');
    expect(h.screen().text).toContain('1. Pista 8 exterior, 18:00');
  });

  it('a typed time that is a free start is picked like a button', async () => {
    await toTimes();
    await h.say('19:30');
    expect(h.screen().text).toContain('1. Pista 8 exterior, 19:30');
    expect(labels()).toContain('Готово ▶');
  });

  it('a typed time that is not free on the site is refused with the site-based reason, nothing is picked', async () => {
    await toTimes();
    await h.say('18:30');
    expect(h.screen().text).toContain('Этот слот уже занят или недоступен.');
    expect(h.screen().text).toContain('Пока ничего не выбрано.');
  });

  it('asks for the HH:MM format when the text is not a time', async () => {
    await toTimes();
    await h.say('вечером');
    expect(h.screen().text).toContain('Не понял время');
  });

  it('refuses a time outside the club hours', async () => {
    await toTimes();
    await h.say('22:30');
    expect(h.screen().text).toContain('вне часов клуба');
    await h.say('06:00');
    expect(h.screen().text).toContain('вне часов клуба');
  });

  it('outside the times screen the text is just unknown input', async () => {
    await h.say('18:30');
    expect(h.screen().text).toBe(UNKNOWN_INPUT_TEXT);
    await h.say('/new');
    await h.press('вт 20.10');
    await h.say('18:30');
    expect(h.screen().text).toBe(UNKNOWN_INPUT_TEXT);
  });
});
