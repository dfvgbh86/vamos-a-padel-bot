import { beforeEach, describe, expect, it } from 'vitest';
import { FakeJobService, OPENS_21_MS, date, makeJob } from './_fakes.js';
import { createHarness, type Harness } from './_harness.js';

let service: FakeJobService;
let h: Harness;

beforeEach(async () => {
  service = new FakeJobService();
  h = await createHarness({ service });
});

describe('/cancel', () => {
  beforeEach(() => {
    service.jobs = [
      makeJob({ id: 5, state: 'scheduled', gameDate: date('2026-10-21'), opensAtMs: OPENS_21_MS }),
      makeJob({ id: 6, state: 'booked', reservationId: 100003, bookedChoice: { courtId: 9, startMinutes: 1080 } }),
      makeJob({ id: 8, state: 'failed' }),
    ];
  });

  it.each(['', 'abc', '5; reboot', '-5', '5 6', '99999999999', '١٢'])('rejects the argument %j and shows the usage', async (argument) => {
    await h.say(`/cancel ${argument}`.trimEnd());
    expect(h.screen().text).toContain('Укажите номер задания, например /cancel 5');
    expect(h.screen().text).toContain('#5');
    expect(h.screen().buttons).toEqual([]);
    expect(service.cancelCalls).toEqual([]);
  });

  it('says so for an unknown job', async () => {
    await h.say('/cancel 77');
    expect(h.screen().text).toContain('Задание #77 не найдено');
    expect(h.screen().buttons).toEqual([]);
  });

  it('asks for confirmation with a button before anything is cancelled', async () => {
    await h.say('/cancel 5');
    expect(h.screen().text).toContain('Отменить задание?');
    expect(h.screen().text).toContain('<b>#5</b>');
    expect(h.screen().buttons.map((button) => button.text)).toEqual(['Да, отменить', 'Нет']);
    expect(service.cancelCalls).toEqual([]);
  });

  it('a job whose window has already opened is not described as still waiting for it', async () => {
    service.jobs = [makeJob({ id: 9, state: 'scheduled', opensAtMs: OPENS_21_MS - 3_600_000 * 24 * 7 })];
    await h.say('/cancel 9');
    expect(h.screen().text).toContain('Окно открылось: 07.10 07:00 Madrid');
    expect(h.screen().text).not.toContain('Окно откроется');
  });

  it('accepts #5 as well', async () => {
    await h.say('/cancel #5');
    expect(h.screen().text).toContain('Отменить задание?');
  });

  it('cancels once after "Да, отменить" and shows the result', async () => {
    await h.say('/cancel 5');
    await h.press('Да, отменить');
    expect(service.cancelCalls).toEqual([5]);
    expect(h.screen().text).toContain('Задание #5 отменено');
    expect(h.screen().buttons).toEqual([]);
  });

  it('a second tap on the same button does nothing', async () => {
    await h.say('/cancel 5');
    const yes = h.buttons()[0]?.data ?? '';
    await h.pressData(yes);
    await h.pressData(yes);
    expect(service.cancelCalls).toEqual([5]);
    expect(h.answers().at(-1)?.payload).toMatchObject({ text: 'Кнопка устарела, повторите /cancel' });
  });

  it('"Нет" cancels nothing', async () => {
    await h.say('/cancel 5');
    await h.press('Нет');
    expect(service.cancelCalls).toEqual([]);
    expect(h.screen().text).toContain('не отменено');
  });

  it('the confirmation expires after five minutes', async () => {
    await h.say('/cancel 5');
    h.clock.now += 6 * 60_000;
    await h.press('Да, отменить');
    expect(service.cancelCalls).toEqual([]);
    expect(h.answers().at(-1)?.payload).toMatchObject({ text: 'Кнопка устарела, повторите /cancel' });
  });

  it('a newer /cancel replaces the earlier confirmation', async () => {
    await h.say('/cancel 5');
    const first = h.buttons()[0]?.data ?? '';
    await h.say('/cancel 5');
    await h.pressData(first);
    expect(service.cancelCalls).toEqual([]);
  });

  it('survives a restart: the old confirmation is stale', async () => {
    await h.say('/cancel 5');
    const yes = h.buttons()[0]?.data ?? '';
    const restarted = await createHarness({ service });
    await restarted.pressData(yes);
    expect(service.cancelCalls).toEqual([]);
    expect(restarted.answers()[0]?.payload).toMatchObject({ text: 'Кнопка устарела, повторите /cancel' });
  });

  it('a booked job is never offered for cancelling: the reservation is cancelled on the club site', async () => {
    await h.say('/cancel 6');
    expect(h.screen().text).toContain('нельзя отменить');
    expect(h.screen().text).toContain('Бот не отменяет брони');
    expect(h.screen().buttons).toEqual([]);
    expect(service.cancelCalls).toEqual([]);
  });

  it('a finished job has nothing to cancel', async () => {
    await h.say('/cancel 8');
    expect(h.screen().text).toContain('нельзя отменить');
    expect(h.screen().buttons).toEqual([]);
  });

  it('relays "not cancellable" from the service (the state changed meanwhile)', async () => {
    service.cancelResult = () => ({ kind: 'not_cancellable', state: 'booked' });
    await h.say('/cancel 5');
    await h.press('Да, отменить');
    expect(h.screen().text).toContain('нельзя отменить');
    expect(h.screen().text).toContain('забронировано');
    expect(h.screen().text).toContain('Бот не отменяет брони');
  });

  it('relays "not found" from the service', async () => {
    service.cancelResult = () => ({ kind: 'not_found' });
    await h.say('/cancel 5');
    await h.press('Да, отменить');
    expect(h.screen().text).toContain('Задание #5 не найдено');
  });

  it('survives an exception of the service', async () => {
    service.cancelResult = () => {
      throw new Error('db down');
    };
    await h.say('/cancel 5');
    await h.press('Да, отменить');
    expect(h.screen().text).toContain('Не удалось отменить задание #5');
  });

  it('survives a hanging service', async () => {
    service.cancelResult = () => new Promise(() => undefined);
    h.clock.sleepMode = 'immediate';
    await h.say('/cancel 5');
    await h.press('Да, отменить');
    expect(h.screen().text).toContain('могло быть отменено');
  });
});
