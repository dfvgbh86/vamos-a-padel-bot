import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateJobRejection, CreateJobResult } from '../../src/contracts.js';
import { FakeClock, FakeJobService, NOW_MS, OPENS_21_MS, createdResult, daySchedule, date } from './_fakes.js';
import { createHarness, type Harness } from './_harness.js';

const D20 = date('2026-10-20');

let service: FakeJobService;
let h: Harness;

beforeEach(async () => {
  service = new FakeJobService();
  service.schedules.set(D20, daySchedule(D20, { 4: [1080, 1170], 9: [1080, 1170] }));
  h = await createHarness({ service });
});

const reachConfirm = async (target: Harness = h): Promise<void> => {
  await target.say('/new');
  await target.press('вт 20.10');
  await target.press('Pista 7');
  await target.press('18:00');
  await target.press('Готово');
};

const sentTexts = (): string[] => h.transport.of('sendMessage').map((call) => String(call.payload['text']));

describe('created jobs and the funds warning', () => {
  it('fundsOk: no warning message at all', async () => {
    service.createResult = () => createdResult({ fundsOk: true });
    await reachConfirm();
    await h.press('Подтвердить');
    expect(h.screen().text).toContain('Задание создано');
    expect(sentTexts().some((text) => text.includes('не хватает денег'))).toBe(false);
    expect(h.screen().text).toContain('Стоимость: 19,02 €');
    expect(h.screen().text).toContain('Монедеро: 50,00 €');
  });

  it('exact price: an immediate separate warning with both amounts', async () => {
    service.createResult = () => createdResult({ fundsOk: false, walletCents: 500, requiredCents: 1902, requiredIsEstimate: false });
    await reachConfirm();
    const sentBefore = sentTexts().length;
    await h.press('Подтвердить');
    const warning = sentTexts().slice(sentBefore).find((text) => text.includes('не хватает денег'));
    expect(warning).toBeDefined();
    expect(warning).toContain('не хватает денег: нужно 19,02 €, на счёте 5,00 €');
    expect(warning).not.toContain('примерно');
    expect(warning).toContain('<b>Внимание!</b>');
    // the warning is a NEW message (so the phone buzzes), not an edit of the confirmation
    expect(h.screens().at(-1)?.method).toBe('sendMessage');
  });

  it('says "примерно" when the price is only an estimate', async () => {
    service.createResult = () => createdResult({ fundsOk: false, walletCents: 500, requiredCents: 1902, requiredIsEstimate: true });
    await reachConfirm();
    await h.press('Подтвердить');
    expect(h.screen().text).toContain('не хватает денег: нужно примерно 19,02 €, на счёте 5,00 €');
  });

  it('says the wallet balance could not be read when it is unknown', async () => {
    service.createResult = () => createdResult({ fundsOk: false, walletCents: null, requiredCents: 1902, requiredIsEstimate: true });
    await reachConfirm();
    await h.press('Подтвердить');
    const text = h.screen().text;
    expect(text).toContain('Баланс монедеро прочитать не удалось');
    expect(text).toContain('Нужно примерно 19,02 €');
    expect(text).not.toContain('на счёте');
  });

  it('copes with an unknown price and an unknown balance', async () => {
    service.createResult = () => createdResult({ fundsOk: false, walletCents: null, requiredCents: null, requiredIsEstimate: true });
    await reachConfirm();
    await h.press('Подтвердить');
    expect(h.screen().text).toContain('Стоимость брони определить тоже не удалось');
  });

  it('copes with a known balance and an unknown price', async () => {
    service.createResult = () => createdResult({ fundsOk: false, walletCents: 500, requiredCents: null, requiredIsEstimate: true });
    await reachConfirm();
    await h.press('Подтвердить');
    expect(h.screen().text).toContain('на счёте 5,00 €, а стоимость определить не удалось');
  });

  it('keeps the job armed and says so in the warning', async () => {
    service.createResult = () => createdResult({ fundsOk: false, walletCents: 0, requiredCents: 1902, requiredIsEstimate: false });
    await reachConfirm();
    await h.press('Подтвердить');
    expect(h.screen().text).toContain('нужно 19,02 €, на счёте 0,00 €');
    expect(h.screen().text).toContain('пополните монедеро до открытия окна');
  });

  it('an unreadable balance with fundsOk is not passed off as a funds check: it says the check was not done', async () => {
    service.createResult = () => createdResult({ fundsOk: true, walletCents: null });
    await reachConfirm();
    const sentBefore = sentTexts().length;
    await h.press('Подтвердить');
    expect(h.screen().text).toContain('Задание создано');
    expect(h.screen().text).toContain('Монедеро: баланс прочитать не удалось, проверка денег не выполнена');
    expect(sentTexts().slice(sentBefore).some((text) => text.includes('Внимание'))).toBe(false);
  });

  it('an unreadable balance with fundsOk=false says it in the confirmation and in the separate warning', async () => {
    service.createResult = () => createdResult({ fundsOk: false, walletCents: null, requiredCents: 1902 });
    await reachConfirm();
    const sentBefore = sentTexts().length;
    await h.press('Подтвердить');
    expect(h.screens().find((screen) => screen.text.includes('Задание создано'))?.text).toContain('проверка денег не выполнена');
    expect(sentTexts().slice(sentBefore).some((text) => text.includes('Баланс монедеро прочитать не удалось'))).toBe(true);
  });

  it('a readable balance never carries the "not checked" line', async () => {
    service.createResult = () => createdResult({ fundsOk: true, walletCents: 5000 });
    await reachConfirm();
    await h.press('Подтвердить');
    expect(h.screen().text).toContain('Монедеро: 50,00 €');
    expect(h.screen().text).not.toContain('проверка денег не выполнена');
  });

  it('a window that is still to come: "the bot books at the moment the window opens" with that time', async () => {
    service.createResult = () => createdResult({}, { opensAtMs: OPENS_21_MS });
    await reachConfirm();
    await h.press('Подтвердить');
    const text = h.screen().text;
    expect(text).toContain('в момент открытия окна (14.10 07:00 Madrid)');
    expect(text).toContain('Окно откроется: 14.10 07:00 Madrid');
    expect(text).not.toContain('Окно уже открыто');
  });

  it('a window that is already open: no past time is announced as the future, the bot books at once', async () => {
    service.createResult = () => createdResult({}, { opensAtMs: OPENS_21_MS - 7 * 24 * 3_600_000 });
    await reachConfirm();
    await h.press('Подтвердить');
    const text = h.screen().text;
    expect(text).toContain('Окно уже открыто: бот бронирует сразу и пришлёт результат.');
    expect(text).toContain('Окно открылось: 07.10 07:00 Madrid');
    expect(text).not.toContain('в момент открытия окна');
    expect(text).not.toContain('Окно откроется');
  });

  it('a window that opens exactly now counts as open', async () => {
    service.createResult = () => createdResult({}, { opensAtMs: NOW_MS });
    await reachConfirm();
    await h.press('Подтвердить');
    expect(h.screen().text).toContain('Окно уже открыто');
  });

  it('never mentions the hash, the password or access codes', async () => {
    service.createResult = () => createdResult({ fundsOk: false, walletCents: 0 });
    await reachConfirm();
    await h.press('Подтвердить');
    for (const text of sentTexts()) expect(text).not.toMatch(/hash|парол|password|pin|код доступа/i);
  });
});

describe('rejections are explained in plain Russian', () => {
  const reasons: [CreateJobRejection, string][] = [
    ['invalid_input', 'некорректные данные'],
    ['date_in_past', 'уже прошла'],
    ['date_too_far', 'слишком далеко'],
    ['court_not_allowed', 'нельзя бронировать на эту дату'],
    ['duplicate_active_job', 'уже есть активное задание'],
    ['own_booking_exists', 'у вас уже есть бронь'],
  ];

  it.each(reasons)('%s', async (reason, phrase) => {
    service.createResult = () => ({ kind: 'rejected', reason, detail: '' });
    await reachConfirm();
    await h.press('Подтвердить');
    expect(h.screen().text).toContain('Задание не создано');
    expect(h.screen().text).toContain(phrase);
    expect(h.screen().text).not.toContain('Подробности');
    expect(h.screen().text).toContain('/new');
    expect(h.screen().buttons).toEqual([]);
  });

  it('adds the escaped detail of the service', async () => {
    service.createResult = () => ({ kind: 'rejected', reason: 'duplicate_active_job', detail: 'job #3 <b>exists</b> & "more"' });
    await reachConfirm();
    await h.press('Подтвердить');
    expect(h.screen().text).toContain('Подробности: job #3 &lt;b&gt;exists&lt;/b&gt; &amp; &quot;more&quot;');
  });

  it('ends the conversation after a rejection: the old buttons are stale', async () => {
    service.createResult = () => ({ kind: 'rejected', reason: 'date_in_past', detail: '' });
    await reachConfirm();
    const confirm = h.buttons().find((button) => button.text.includes('Подтвердить'))?.data ?? '';
    await h.press('Подтвердить');
    await h.pressData(confirm);
    expect(h.answers().at(-1)?.payload['text']).toContain('устарела');
    expect(service.createJobCalls).toHaveLength(1);
  });
});

describe('failures of the service', () => {
  it('an exception keeps the conversation so the owner can retry', async () => {
    service.createResult = () => {
      throw new Error('database is locked');
    };
    await reachConfirm();
    await h.press('Подтвердить');
    expect(h.screen().text).toContain('Не удалось создать задание');
    expect(h.screen().text).toContain('Проверьте задание');
    expect(h.logs.entries.some((entry) => entry.level === 'error')).toBe(true);

    service.createResult = () => createdResult();
    await h.press('Подтвердить');
    expect(h.screen().text).toContain('Задание создано');
    expect(service.createJobCalls).toHaveLength(2);
  });

  it('a hanging createJob is reported as "check /jobs" and ends the conversation (no blind second attempt)', async () => {
    service.createResult = () => new Promise<CreateJobResult>(() => undefined);
    h.clock.sleepMode = 'immediate';
    await reachConfirm();
    const confirm = h.buttons().find((button) => button.text.includes('Подтвердить'))?.data ?? '';
    await h.press('Подтвердить');
    expect(h.screen().text).toContain('/jobs');
    expect(h.screen().text).toContain('могло быть создано');
    await h.pressData(confirm);
    expect(h.answers().at(-1)?.payload['text']).toContain('устарела');
    expect(service.createJobCalls).toHaveLength(1);
  });

  it('a second tap on "Подтвердить" while the first is in flight does not create a second job', async () => {
    let release: (value: CreateJobResult) => void = () => undefined;
    service.createResult = () =>
      new Promise<CreateJobResult>((resolve) => {
        release = resolve;
      });
    await reachConfirm();
    const confirm = h.buttons().find((button) => button.text.includes('Подтвердить'))?.data ?? '';

    const first = h.pressData(confirm);
    await vi.waitFor(() => expect(service.createJobCalls).toHaveLength(1));
    await h.pressData(confirm);
    expect(h.answers().at(-1)?.payload['text']).toBe('Задание уже отправляется');
    release(createdResult());
    await first;
    expect(service.createJobCalls).toHaveLength(1);
    expect(h.screen().text).toContain('Задание создано');
  });
});

describe('the confirmation re-checks date and courts', () => {
  it('refuses to send when a chosen court is no longer allowed for the date', async () => {
    await reachConfirm();
    service.allowedCourts = () => [4];
    await h.press('Подтвердить');
    expect(service.createJobCalls).toEqual([]);
    expect(h.screen().text).toContain('больше недоступны');
  });

  it('refuses to send when the date has dropped out of the offered range in the meantime', async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 13, 21, 50, 0)); // 23:50 Madrid on 13 Oct
    const late = await createHarness({ service, clock });
    await late.say('/new');
    await late.press('вт 13.10');
    await late.press('Pista 4');
    await late.press('18:00');
    await late.press('Готово');
    clock.now += 15 * 60_000; // 00:05 on 14 Oct: 13 Oct is in the past
    await late.press('Подтвердить');
    expect(service.createJobCalls).toEqual([]);
    expect(late.screen().text).toContain('больше недоступны');
  });

  it('a forged confirm before the summary was shown creates nothing', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Pista 7');
    await h.press('18:00');
    const sid = /^n:c:([0-9a-f]{6}):/.exec(h.buttons().find((button) => button.text.startsWith('Pista 4'))?.data ?? '')?.[1];
    await h.pressData(`n:y:${sid}`);
    expect(service.createJobCalls).toEqual([]);
    expect(h.answers().at(-1)?.payload['text']).toContain('устарела');
    expect(h.transport.of('editMessageReplyMarkup')).toHaveLength(0);
  });
});

describe('HTML safety of dynamic text', () => {
  it('escapes and bounds a hostile rejection detail', async () => {
    service.createResult = () => ({
      kind: 'rejected',
      reason: 'invalid_input',
      detail: `<script>alert(1)</script><a href="x">y</a>${'я'.repeat(5000)}`,
    });
    await reachConfirm();
    await h.press('Подтвердить');
    const text = h.screen().text;
    expect(text).not.toContain('<script');
    expect(text).not.toContain('<a href');
    expect(text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(text.length).toBeLessThan(1000);
    expect(h.screen().parseMode).toBe('HTML');
  });
});
