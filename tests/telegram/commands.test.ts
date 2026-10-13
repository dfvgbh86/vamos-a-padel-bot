import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/contracts.js';
import { FakeJobService, NOW_MS, OPENS_21_MS, createdResult, date, makeJob } from './_fakes.js';
import { createHarness, type Harness } from './_harness.js';

let service: FakeJobService;
let h: Harness;

beforeEach(async () => {
  service = new FakeJobService();
  h = await createHarness({ service });
});

const balanced = (html: string): boolean => (html.match(/<b>/g)?.length ?? 0) === (html.match(/<\/b>/g)?.length ?? 0);

describe('/start and /help', () => {
  it.each(['/start', '/help', '/help@padel_test_bot'])('%s shows a short help in Russian with every command', async (command) => {
    await h.say(command);
    const text = h.screen().text;
    for (const part of ['/new', '/jobs', '/cancel', '/status', '/wallet', '/stop', '/resume']) expect(text).toContain(part);
    expect(text).toMatch(/[а-я]/);
    expect(text.length).toBeLessThan(900);
    expect(h.screen().parseMode).toBe('HTML');
  });

  it('answers free text and unknown commands with a hint', async () => {
    await h.say('привет');
    expect(h.screen().text).toBe('Не понимаю. Команды: /help');
    await h.say('/frobnicate');
    expect(h.screen().text).toBe('Не понимаю. Команды: /help');
  });

  it('publishes the command menu only when the bot starts', async () => {
    expect(h.transport.of('setMyCommands')).toHaveLength(0);
    await h.handle.start();
    const commands = h.transport.of('setMyCommands')[0]?.payload['commands'] as { command: string }[];
    expect(commands.map((entry) => entry.command)).toEqual(['new', 'jobs', 'cancel', 'status', 'wallet', 'stop', 'resume', 'help']);
    await h.handle.stop();
  });
});

describe('/jobs', () => {
  it('says so when there are no jobs', async () => {
    await h.say('/jobs');
    expect(h.screen().text).toContain('Заданий пока нет');
  });

  it('lists active jobs by date first, then recent finished ones', async () => {
    service.jobs = [
      makeJob({ id: 1, gameDate: date('2026-10-18'), state: 'booked', reservationId: 100002, bookedChoice: { courtId: 9, startMinutes: 1080 }, updatedAtMs: NOW_MS - 5000 }),
      makeJob({ id: 2, gameDate: date('2026-10-21'), state: 'scheduled', opensAtMs: OPENS_21_MS, choices: [{ courtId: 4, startMinutes: 1080 }, { courtId: 10, startMinutes: 1170 }] }),
      makeJob({ id: 3, gameDate: date('2026-10-14'), state: 'failed', failureReason: 'слот занят', updatedAtMs: NOW_MS - 1000 }),
      makeJob({ id: 4, gameDate: date('2026-10-12'), state: 'cancelled', updatedAtMs: NOW_MS - 9000 }),
    ];
    await h.say('/jobs');
    const text = h.screen().text;
    expect(text.indexOf('Активные задания')).toBeLessThan(text.indexOf('Недавние'));
    // active: booked (18.10) before scheduled (21.10)
    expect(text.indexOf('<b>#1</b>')).toBeLessThan(text.indexOf('<b>#2</b>'));
    // recent: newest change first
    expect(text.indexOf('<b>#3</b>')).toBeLessThan(text.indexOf('<b>#4</b>'));
    expect(text).toContain('Бронь: Pista 7 semicubierta, 18:00–19:30');
    expect(text).toContain('Номер брони: 100002');
    expect(text).toContain('Окно откроется: 14.10 07:00 Madrid');
    expect(text).toContain('1. Pista 4 semicubierta, 18:00');
    expect(text).toContain('2. Pista 8 exterior, 19:30');
    expect(text).toContain('Причина: слот занят');
  });

  it('a scheduled job whose window has opened says "opened", not "will open"', async () => {
    service.jobs = [
      makeJob({ id: 1, state: 'scheduled', opensAtMs: NOW_MS - 3_600_000 }),
      makeJob({ id: 2, state: 'scheduled', gameDate: date('2026-10-21'), opensAtMs: OPENS_21_MS }),
    ];
    await h.say('/jobs');
    const text = h.screen().text;
    expect(text).toContain('Окно открылось: 13.10 07:00 Madrid');
    expect(text).toContain('Окно откроется: 14.10 07:00 Madrid');
  });

  it('escapes hostile failure reasons and keeps the markup balanced', async () => {
    service.jobs = [makeJob({ id: 9, state: 'failed', failureReason: '</b><i>boom</i> <a href="x">y</a> & more' })];
    await h.say('/jobs');
    const text = h.screen().text;
    expect(text).not.toContain('<a href');
    expect(text).not.toContain('<i>');
    expect(text).toContain('&lt;/b&gt;&lt;i&gt;boom&lt;/i&gt;');
    expect(balanced(text)).toBe(true);
  });

  it('cuts a very long list at a job boundary and says how many are left', async () => {
    service.jobs = Array.from({ length: 150 }, (_, index) =>
      makeJob({
        id: index + 1,
        gameDate: date('2026-10-20'),
        state: 'scheduled',
        choices: Array.from({ length: 8 }, (__, court) => ({ courtId: [4, 9, 10, 11, 12][court % 5] ?? 4, startMinutes: 540 + court * 30 })),
      }),
    );
    await h.say('/jobs');
    const text = h.screen().text;
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain('показано не всё');
    expect(balanced(text)).toBe(true);
    expect(text).not.toMatch(/<b>Недавние<\/b>\s*$/);
  });

  it('truncates a huge failure reason by code points without splitting an emoji', async () => {
    service.jobs = [makeJob({ id: 5, state: 'failed', failureReason: '🎾'.repeat(1000) })];
    await h.say('/jobs');
    const text = h.screen().text;
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(Array.from(text).filter((char) => char === '🎾').length).toBeLessThan(200);
  });

  it('survives a failing service', async () => {
    service.listJobs = () => {
      throw new Error('db down');
    };
    await h.say('/jobs');
    expect(h.screen().text).toContain('Список заданий: ошибка сервиса');
  });
});

describe('/status', () => {
  it('reports a running bot', async () => {
    service.statusReport = {
      stopped: false,
      sessionAlive: true,
      walletCents: 1902,
      activeJobs: [makeJob({ id: 2, gameDate: date('2026-10-21'), state: 'scheduled' })],
      upcomingHolidays: [date('2026-12-08'), date('2026-10-22')],
      nextWindowOpensAtMs: OPENS_21_MS,
    };
    await h.say('/status');
    const text = h.screen().text;
    expect(text).toContain('🟢 Работает');
    expect(text).toContain('Сессия на сайте: активна');
    expect(text).toContain('Монедеро: 19,02 €');
    expect(text).toContain('Ближайшее открытие окна: 14.10 07:00 Madrid');
    expect(text).toContain('Праздники в ближайшие 30 дней: 08.12, 22.10');
    expect(text).toContain('#2 · ср 21.10');
  });

  it('reports an emergency stop prominently', async () => {
    service.statusReport = { ...service.statusReport, stopped: true };
    await h.say('/status');
    expect(h.screen().text).toContain('Аварийная остановка ВКЛЮЧЕНА');
    expect(h.screen().text).toContain('/resume');
  });

  it('copes with unknown values', async () => {
    service.statusReport = { stopped: false, sessionAlive: null, walletCents: null, activeJobs: [], upcomingHolidays: [], nextWindowOpensAtMs: null };
    await h.say('/status');
    const text = h.screen().text;
    expect(text).toContain('Сессия на сайте: не проверялась');
    expect(text).toContain('Монедеро: не удалось прочитать');
    expect(text).toContain('нет заряженных заданий');
    expect(text).toContain('Праздники в ближайшие 30 дней: нет');
    expect(text).toContain('Активных заданий нет.');
  });

  it('reports a dead session', async () => {
    service.statusReport = { ...service.statusReport, sessionAlive: false };
    await h.say('/status');
    expect(h.screen().text).toContain('Сессия на сайте: не активна');
  });

  it('survives a failing service', async () => {
    service.status = () => Promise.reject(new Error('boom'));
    await h.say('/status');
    expect(h.screen().text).toContain('Состояние: ошибка сервиса');
  });
});

describe('/wallet', () => {
  it.each([
    [1902, 'Монедеро: 19,02 €'],
    [0, 'Монедеро: 0,00 €'],
    [5, 'Монедеро: 0,05 €'],
    [100_000, 'Монедеро: 1000,00 €'],
    [-250, 'Монедеро: -2,50 €'],
  ])('shows %i cents as "%s"', async (cents, expected) => {
    service.walletCents = cents;
    await h.say('/wallet');
    expect(h.screen().text).toBe(expected);
  });

  it('says so when the balance cannot be read', async () => {
    service.walletFails = true;
    await h.say('/wallet');
    expect(h.screen().text).toContain('Баланс монедеро: ошибка сервиса');
  });

  it('survives a hanging service', async () => {
    service.wallet = () => new Promise(() => undefined);
    h.clock.sleepMode = 'immediate';
    await h.say('/wallet');
    expect(h.screen().text).toContain('сервис не ответил вовремя');
  });
});

describe('/stop and /resume', () => {
  it('/stop stops everything at once, without a second confirmation, and says how to resume', async () => {
    await h.say('/stop');
    expect(service.calls).toEqual(['stopAll']);
    expect(h.screen().text).toContain('Аварийная остановка включена');
    expect(h.screen().text).toContain('/resume');
    expect(h.screen().buttons).toEqual([]);
  });

  it('/stop is logged as a warning', async () => {
    await h.say('/stop');
    expect(h.logs.entries.some((entry) => entry.level === 'warn' && entry.msg?.includes('emergency stop'))).toBe(true);
  });

  it('/stop that fails says so loudly', async () => {
    service.stopAllThrows = true;
    await h.say('/stop');
    expect(h.screen().text).toContain('Не удалось включить аварийную остановку');
    expect(h.screen().text).not.toContain('включена');
  });

  it('/resume releases the stop', async () => {
    await h.say('/resume');
    expect(service.calls).toEqual(['resumeAll']);
    expect(h.screen().text).toContain('остановка снята');
  });

  it('/resume that fails says so', async () => {
    service.resumeAll = () => {
      throw new Error('db down');
    };
    await h.say('/resume');
    expect(h.screen().text).toContain('Не удалось снять');
  });
});

describe('every user-visible text', () => {
  it('is sent with parse_mode HTML and previews disabled', async () => {
    service.createResult = () => createdResult();
    for (const command of ['/help', '/jobs', '/status', '/wallet', '/stop', '/resume', '/cancel 1', '/new', 'blah']) {
      h.transport.clear();
      await h.say(command);
      const sent = h.transport.of('sendMessage');
      expect(sent.length, command).toBeGreaterThan(0);
      for (const call of sent) {
        expect(call.payload['parse_mode'], command).toBe('HTML');
        expect(call.payload['link_preview_options'], command).toEqual({ is_disabled: true });
        expect(String(call.payload['text']).length, command).toBeLessThanOrEqual(4096);
      }
    }
  });

  it('never contains an unescaped angle bracket outside the few tags we use', async () => {
    service.jobs = [makeJob({ state: 'failed', failureReason: '<>&"' })] as Job[];
    for (const command of ['/help', '/jobs', '/status', '/stop', '/new', '/cancel 7']) {
      h.transport.clear();
      await h.say(command);
      for (const call of h.transport.of('sendMessage')) {
        const stripped = String(call.payload['text']).replace(/<\/?b>/g, '');
        expect(stripped, command).not.toMatch(/[<>]/);
      }
    }
  });
});
