import { beforeEach, describe, expect, it } from 'vitest';
import { FakeJobService, daySchedule, date } from './_fakes.js';
import { createHarness, callbackUpdate, OWNER_ID, type Harness } from './_harness.js';

const D20 = date('2026-10-20'); // Tuesday: academy courts 1, 2, 3, 7, 8 are NOT allowed

const STALE = 'Кнопка устарела, начните /new';

let service: FakeJobService;
let h: Harness;

beforeEach(async () => {
  service = new FakeJobService();
  service.schedules.set(D20, daySchedule(D20, { 1: [1080], 4: [1080, 1170], 7: [1080], 9: [1080] }));
  h = await createHarness({ service });
});

const sidOf = (): string => {
  const data = h.buttons().find((button) => /^n:[a-z]:[0-9a-f]{6}/.test(button.data))?.data ?? '';
  return /^n:[a-z]:([0-9a-f]{6})/.exec(data)?.[1] ?? 'missing';
};

const lastAnswer = () => h.answers().at(-1)?.payload;

describe('stale buttons: a restarted bot has no memory of the conversation', () => {
  it('answers with an alert "кнопка устарела, начните /new" and removes the old keyboard', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    const oldCourt = h.buttons().find((button) => button.text.startsWith('Pista 4'))?.data ?? '';

    const restarted = await createHarness({ service });
    await restarted.pressData(oldCourt);

    expect(restarted.answers()).toHaveLength(1);
    expect(restarted.answers()[0]?.payload).toMatchObject({ text: STALE, show_alert: true });
    expect(restarted.transport.of('editMessageReplyMarkup')).toHaveLength(1);
    expect(restarted.transport.of('sendMessage')).toHaveLength(0);
    expect(service.createJobCalls).toEqual([]);
  });

  it('survives a failure to remove the keyboard', async () => {
    const restarted = await createHarness({ service });
    restarted.transport.failNext('editMessageReplyMarkup', { code: 400, description: 'Bad Request: message to edit not found' });
    await restarted.pressData('n:y:abcdef');
    expect(restarted.answers()[0]?.payload).toMatchObject({ text: STALE });
  });

  it('every kind of button of a vanished conversation is refused without effect', async () => {
    const restarted = await createHarness({ service });
    for (const data of [
      'n:d:abcdef:2026-10-20',
      'n:c:abcdef:4',
      'n:t:abcdef:4:1080',
      'n:u:abcdef',
      'n:k:abcdef',
      'n:r:abcdef',
      'n:g:abcdef',
      'n:y:abcdef',
      'n:x:abcdef',
    ]) {
      await restarted.pressData(data);
      expect(restarted.answers().at(-1)?.payload, data).toMatchObject({ text: STALE, show_alert: true });
    }
    expect(service.createJobCalls).toEqual([]);
    expect(service.getDayCalls).toEqual([]);
  });

  it('an expired conversation (no activity for 20 minutes) is stale', async () => {
    await h.say('/new');
    h.clock.now += 21 * 60_000;
    await h.press('вт 20.10');
    expect(lastAnswer()).toMatchObject({ text: STALE });
    expect(service.getDayCalls).toEqual([]);
  });

  it('every interaction extends the conversation', async () => {
    await h.say('/new');
    h.clock.now += 15 * 60_000;
    await h.press('вт 20.10');
    h.clock.now += 15 * 60_000;
    await h.press('Pista 4');
    expect(h.screen().text).toContain('Pista 4');
    expect(lastAnswer()?.['text']).toBeUndefined();
  });

  it('a button of a conversation of another allowed user is stale for this user', async () => {
    const two = await createHarness({ service, allowedUserIds: [OWNER_ID, 43] });
    await two.say('/new', { fromId: 43 });
    const theirs = two.buttons().find((button) => button.text.includes('вт 20.10'))?.data ?? '';
    await two.say('/new', { fromId: OWNER_ID });
    await two.pressData(theirs, { fromId: OWNER_ID });
    expect(two.answers().at(-1)?.payload).toMatchObject({ text: STALE });
  });
});

describe('forged callback_data: court, date and time are re-validated at the moment of use', () => {
  beforeEach(async () => {
    await h.say('/new');
    await h.press('вт 20.10');
  });

  it.each([1, 2, 3, 7, 8])('refuses the academy court id %i on a weekday', async (courtId) => {
    const before = h.screens().length;
    await h.pressData(`n:c:${sidOf()}:${courtId}`);
    expect(h.screens()).toHaveLength(before);
    expect(lastAnswer()).toMatchObject({ text: 'Этот корт нельзя выбрать на эту дату', show_alert: true });
  });

  it('refuses a time for an academy court even though the site schedule lists free slots for it', async () => {
    const before = h.screens().length;
    await h.pressData(`n:t:${sidOf()}:1:1080`);
    expect(h.screens()).toHaveLength(before);
    await h.press('Готово').catch(() => undefined);
    expect(service.createJobCalls).toEqual([]);
    expect(lastAnswer()).toMatchObject({ text: 'Этот корт нельзя выбрать на эту дату' });
  });

  it.each([0, 5, 6, 13, 99, 255])('refuses the court id %i that is not on the court table at all', async (courtId) => {
    await h.pressData(`n:c:${sidOf()}:${courtId}`);
    expect(lastAnswer()).toMatchObject({ text: 'Этот корт нельзя выбрать на эту дату' });
    await h.pressData(`n:t:${sidOf()}:${courtId}:1080`);
    expect(lastAnswer()).toMatchObject({ text: 'Этот корт нельзя выбрать на эту дату' });
  });

  it('never lets a forged court reach createJob', async () => {
    await h.pressData(`n:t:${sidOf()}:1:1080`);
    await h.pressData(`n:g:${sidOf()}`);
    await h.pressData(`n:y:${sidOf()}`);
    expect(service.createJobCalls).toEqual([]);
  });

  it('a time that is not in the court schedule is not added (it is reported as unavailable)', async () => {
    await h.pressData(`n:t:${sidOf()}:4:1085`);
    expect(h.screen().text).toContain('Этот слот уже занят или недоступен.');
    expect(h.screen().text).toContain('Пока ничего не выбрано.');
    await h.pressData(`n:t:${sidOf()}:4:600`);
    expect(h.screen().text).toContain('Пока ничего не выбрано.');
  });

  it('a picked court with no free slot cannot be opened', async () => {
    service.schedules.set(D20, daySchedule(D20, { 4: [{ start: 1080, free: false }], 9: [1080] }));
    await h.say('/new');
    await h.press('вт 20.10');
    await h.pressData(`n:c:${sidOf()}:4`);
    expect(lastAnswer()).toMatchObject({ text: 'На этом корте нет свободных слотов' });
  });

  it('a time outside the fixed grid is refused when the schedule is unavailable', async () => {
    service.schedules.clear();
    await h.say('/new');
    await h.press('ср 21.10');
    const sid = sidOf();
    await h.pressData(`n:t:${sid}:4:1085`);
    expect(lastAnswer()).toMatchObject({ text: 'Это время недоступно', show_alert: true });
    await h.pressData(`n:t:${sid}:4:30`);
    expect(lastAnswer()).toMatchObject({ text: 'Это время недоступно' });
    expect(h.screen().text).toContain('Пока ничего не выбрано.');
  });

  it('a date outside the offered range is refused without asking the site', async () => {
    await h.say('/new');
    const sid = sidOf();
    service.getDayCalls.length = 0;
    for (const forged of ['2030-01-01', '2026-10-12', '2026-10-22', '2026-10-24']) {
      await h.pressData(`n:d:${sid}:${forged}`);
      expect(lastAnswer(), forged).toMatchObject({ text: 'Эта дата сейчас недоступна для выбора' });
    }
    expect(service.getDayCalls).toEqual([]);
  });

  it('a date that is not a real calendar day never gets past the strict parser', async () => {
    await h.say('/new');
    const sid = sidOf();
    service.getDayCalls.length = 0;
    for (const forged of ['2026-02-30', '2026-13-01', '2026-00-10', '0000-00-00', '2026-10-32']) {
      await h.pressData(`n:d:${sid}:${forged}`);
      expect(lastAnswer(), forged).toMatchObject({ text: STALE });
    }
    expect(service.getDayCalls).toEqual([]);
  });

  it('picking a court before a date was chosen is refused', async () => {
    await h.say('/new');
    await h.pressData(`n:c:${sidOf()}:4`);
    expect(lastAnswer()).toMatchObject({ text: STALE });
    await h.pressData(`n:t:${sidOf()}:4:1080`);
    expect(lastAnswer()).toMatchObject({ text: STALE });
    await h.pressData(`n:g:${sidOf()}`);
    expect(lastAnswer()).toMatchObject({ text: STALE });
  });

  it('"Готово" without a single choice is refused', async () => {
    await h.pressData(`n:g:${sidOf()}`);
    expect(lastAnswer()).toMatchObject({ text: 'Выберите хотя бы один вариант', show_alert: true });
  });
});

describe('garbage and hostile callback_data', () => {
  const sid = 'abcdef';
  const garbage: [string, string][] = [
    ['empty', ''],
    ['plain word', 'hello'],
    ['unknown flow', 'z:y:abcdef'],
    ['unknown action', 'n:q:abcdef'],
    ['upper-case sid', 'n:y:ABCDEF'],
    ['non-hex sid', 'n:y:ghijkl'],
    ['short sid', 'n:y:abcde'],
    ['long sid', 'n:y:abcdef0'],
    ['trailing newline', `n:y:${sid}\n`],
    ['trailing space', `n:y:${sid} `],
    ['extra argument', `n:y:${sid}:1`],
    ['negative court', `n:c:${sid}:-1`],
    ['court with a letter', `n:c:${sid}:1a`],
    ['four digit court', `n:c:${sid}:1234`],
    ['minutes out of range', `n:t:${sid}:4:1440`],
    ['negative minutes', `n:t:${sid}:4:-60`],
    ['float minutes', `n:t:${sid}:4:10.5`],
    ['date with time', `n:d:${sid}:2026-10-20T10:00`],
    ['sql-ish', `n:c:${sid}:4;DROP TABLE jobs`],
    ['shell-ish', `n:c:${sid}:$(reboot)`],
    ['html-ish', `n:d:${sid}:<b>2026-10-20</b>`],
    ['over 64 bytes', `n:d:${sid}:${'1'.repeat(80)}`],
    ['unicode digits', `n:c:${sid}:٤`],
    ['null byte', `n:y:${sid}\u0000`],
  ];

  it.each(garbage)('%s is treated as a stale button and changes nothing', async (_label, data) => {
    await h.say('/new');
    await h.press('вт 20.10');
    const before = h.screens().length;
    await h.pressData(data);
    expect(lastAnswer()).toMatchObject({ text: STALE, show_alert: true });
    expect(h.screens()).toHaveLength(before);
    expect(service.createJobCalls).toEqual([]);
  });

  it('a callback query without data is only acknowledged', async () => {
    const update = callbackUpdate('x');
    delete (update.callback_query as { data?: string }).data;
    (update.callback_query as { game_short_name?: string }).game_short_name = 'some_game';
    await h.send(update);
    expect(h.answers()).toHaveLength(1);
    expect(h.transport.of('sendMessage')).toHaveLength(0);
  });

  it('x: confirmation buttons with no pending /cancel point the owner to /cancel', async () => {
    await h.pressData(`x:y:${sid}`);
    expect(lastAnswer()).toMatchObject({ text: 'Кнопка устарела, повторите /cancel', show_alert: true });
    expect(service.cancelCalls).toEqual([]);
  });
});
