/**
 * End-to-end scenarios around the happy path (see e2e.booking.test.ts): money, strangers, unclear answers,
 * the emergency stop, restarts. The whole app is real; the site, the clock and Telegram are fakes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { callbackUpdate, messageUpdate, OWNER_ID, STRANGER_ID, FAKE_TOKEN } from '../telegram/_harness.js';
import { GAME_DAY, MINUTE, OPENS_MS, PASSWORD, createRig, messagesWith, type Rig } from './_rig.js';
import { FIRST_RESERVATION_ID, SITE_HASH } from './_site.js';

let rig: Rig | undefined;
const stores: SqliteJobStore[] = [];

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
  for (const store of stores.splice(0)) store.close();
});

const WISH = [{ court: 'Pista 7', time: '18:00' }] as const;
const DAY = 'вт 20.10';
const HOUR_BEFORE = OPENS_MS - 60 * MINUTE;

describe('money', () => {
  it('warns at creation when the wallet cannot cover the booking, and keeps the job armed', async () => {
    rig = createRig({ walletCents: 500 });
    await rig.start();
    await rig.owner.createJob(DAY, WISH);

    const [warning] = messagesWith(rig, 'Внимание');
    expect(warning?.text).toContain('не хватает денег');
    expect(warning?.text).toContain('19,02');
    expect(warning?.text).toContain('5,00');
    expect(warning?.text).toContain('Задание остаётся заряженным');
    expect(rig.app.service.listJobs()[0]?.state).toBe('scheduled');
    expect(rig.site.addEvents).toHaveLength(0);
  });

  it('books after all when the owner tops up the wallet before the window opens', async () => {
    rig = createRig({ walletCents: 500, latency: { probeForm: 300, book: 1900 } });
    await rig.start();
    await rig.owner.createJob(DAY, WISH);
    await rig.runTo(OPENS_MS - 25 * MINUTE);
    rig.site.walletCents = 5000;
    await rig.runPastOpening();

    expect(messagesWith(rig, 'Не хватает денег на монедеро')).toHaveLength(0);
    expect(rig.site.addEvents).toHaveLength(1);
    expect(rig.app.service.listJobs()[0]?.state).toBe('booked');
  });

  it('still short at the opening: warns again before it, sends no booking request, fails the job', async () => {
    rig = createRig({ walletCents: 500 });
    await rig.start();
    await rig.owner.createJob(DAY, WISH);
    await rig.runPastOpening(2 * MINUTE);

    expect(messagesWith(rig, 'Внимание')).toHaveLength(1);
    const [preflight] = messagesWith(rig, 'Не хватает денег на монедеро');
    expect(preflight?.text).toContain('Пожалуйста, пополните монедеро');
    expect(rig.site.addEvents).toEqual([]);
    expect(rig.app.service.listJobs()[0]).toMatchObject({ state: 'failed', failureReason: 'no_funds', attempts: 0 });
    expect(messagesWith(rig, 'Не удалось забронировать')[0]?.text).toContain('no_funds');
  });
});

describe('strangers', () => {
  it('ignores every update from anybody but the owner: no reply, no state change, no stop', async () => {
    rig = createRig({ latency: { probeForm: 300, book: 1900 } });
    await rig.start();
    rig.transport.clear();
    const { bot } = rig.app.telegram;

    await bot.handleUpdate(messageUpdate('/new', { fromId: STRANGER_ID }));
    await bot.handleUpdate(messageUpdate('/stop', { fromId: STRANGER_ID }));
    await bot.handleUpdate(messageUpdate('/status', { fromId: STRANGER_ID }));
    await bot.handleUpdate(callbackUpdate('x', { fromId: STRANGER_ID }));
    await bot.handleUpdate(messageUpdate('/stop', { chat: 'group' }));
    await bot.handleUpdate(messageUpdate('/stop', { chat: 'supergroup', fromId: STRANGER_ID }));

    const replies = rig.transport.calls.filter((call) => ['sendMessage', 'editMessageText', 'answerCallbackQuery'].includes(call.method));
    expect(replies).toEqual([]);
    expect(rig.app.store.isStopped()).toBe(false);
    expect(rig.app.service.listJobs()).toEqual([]);
    expect(rig.site.calls).toEqual([]);
    expect(rig.logText()).toContain('non-allowed sender');

    // and the owner's job is not affected by any of it
    await rig.owner.createJob(DAY, WISH);
    await rig.runPastOpening();
    expect(rig.site.addEvents).toHaveLength(1);
    expect(rig.app.service.listJobs()[0]?.state).toBe('booked');
    expect(new Set(rig.sent().map((message) => message.chatId))).toEqual(new Set([OWNER_ID]));
  });
});

describe('an unclear answer to the booking request', () => {
  it('answer lost but the booking exists: finds it in the calendar, never sends again, tells the owner', async () => {
    rig = createRig({ latency: { probeForm: 300, book: 1900 } });
    rig.site.bookScript = () => 'lost_answer';
    await rig.start();
    await rig.owner.createJob(DAY, WISH);
    await rig.runPastOpening(60_000);

    expect(rig.site.addEvents).toHaveLength(1);
    expect(rig.site.bookings).toHaveLength(1);
    expect(rig.site.doubleBookings).toBe(0);
    expect(rig.app.service.listJobs()[0]).toMatchObject({ state: 'booked', bookedChoice: { courtId: 9, startMinutes: 1080 } });

    const unclear = messagesWith(rig, 'Результат брони неясен');
    expect(unclear).toHaveLength(1);
    expect(unclear[0]?.text).toContain('Бот не повторяет запрос вслепую');
    const [booked] = messagesWith(rig, 'ЗАБРОНИРОВАНО');
    expect(booked?.text).toContain('Pista 7 semicubierta');
    expect(booked?.storeState).toBe('booked');
    // the id could not be read from the calendar: the message must say so instead of printing a fake number
    expect(booked?.text).not.toContain('Номер брони: 0');
    expect(booked?.text).toContain('Номер брони: не удалось прочитать');
  });

  it('answer lost and the calendar unreadable: nothing is sent again and the owner is told to check the site', async () => {
    rig = createRig({ latency: { probeForm: 300, book: 1900 } });
    rig.site.bookScript = () => 'lost_answer';
    rig.site.failCalendarReads = 5;
    await rig.start();
    await rig.owner.createJob(DAY, WISH);
    await rig.runPastOpening(90_000);

    expect(rig.site.failCalendarReads).toBe(0);
    expect(rig.site.addEvents).toHaveLength(1);
    expect(rig.site.doubleBookings).toBe(0);
    expect(rig.app.service.listJobs()[0]).toMatchObject({ state: 'failed', failureReason: 'ambiguous_unresolved' });
    expect(messagesWith(rig, 'Результат брони неясен')).toHaveLength(1);
    expect(messagesWith(rig, 'Не удалось забронировать')).toHaveLength(1);
  });

  it('request lost and nothing created: sends again only after the calendar was checked, and books once', async () => {
    rig = createRig({ latency: { probeForm: 300, book: 1900 } });
    rig.site.bookScript = (nth) => (nth === 0 ? 'lost_request' : 'ok');
    await rig.start();
    await rig.owner.createJob(DAY, WISH);
    await rig.runPastOpening(90_000);

    expect(rig.site.addEvents).toHaveLength(2);
    expect(rig.site.maxBooksInFlight).toBe(1);
    const sequence = rig.site.calls.filter((call) => call.name === 'book' || (call.name === 'getDay' && call.gameDate === GAME_DAY));
    const firstBook = sequence.findIndex((call) => call.name === 'book');
    const secondBook = sequence.findIndex((call, index) => index > firstBook && call.name === 'book');
    const checksBetween = sequence.slice(firstBook + 1, secondBook).filter((call) => call.name === 'getDay');
    expect(checksBetween.length).toBeGreaterThan(0);
    expect(rig.site.bookings).toHaveLength(1);
    expect(rig.site.doubleBookings).toBe(0);
    expect(rig.app.service.listJobs()[0]?.state).toBe('booked');
    expect(messagesWith(rig, 'Результат брони неясен')).toHaveLength(1);
  });
});

describe('the emergency stop', () => {
  it('/stop before the window: no booking request is ever sent and the owner is told the job failed', async () => {
    rig = createRig();
    await rig.start();
    await rig.owner.createJob(DAY, WISH);
    await rig.runTo(OPENS_MS - 20 * MINUTE);
    await rig.owner.say('/stop');
    expect(rig.owner.screen().text).toContain('Аварийная остановка включена');
    expect(rig.app.store.isStopped()).toBe(true);

    await rig.runPastOpening(5 * MINUTE);
    expect(rig.site.addEvents).toEqual([]);
    expect(rig.app.service.listJobs()[0]).toMatchObject({ state: 'failed', failureReason: 'stopped', attempts: 0 });
    expect(messagesWith(rig, 'Не удалось забронировать')[0]?.text).toContain('stopped');
  });

  it('/stop then /resume before the window: the job books normally', async () => {
    rig = createRig({ latency: { probeForm: 300, book: 1900 } });
    await rig.start();
    await rig.owner.createJob(DAY, WISH);
    await rig.runTo(OPENS_MS - 20 * MINUTE);
    await rig.owner.say('/stop');
    await rig.runTo(OPENS_MS - 5 * MINUTE);
    expect(rig.site.addEvents).toEqual([]);
    await rig.owner.say('/resume');
    expect(rig.app.store.isStopped()).toBe(false);

    await rig.runPastOpening();
    expect(rig.site.addEvents).toHaveLength(1);
    expect(rig.app.service.listJobs()[0]?.state).toBe('booked');
  });

  it('the flag is checked before every request: raised in the very moment the gate opens, nothing is sent', async () => {
    rig = createRig({ latency: { probeForm: 300, book: 1900 } });
    const current = rig;
    let raised = false;
    rig.site.onProbe = (gate) => {
      if (gate.kind !== 'open' || raised) return;
      raised = true;
      current.app.service.stopAll();
    };
    await rig.start();
    await rig.owner.createJob(DAY, WISH);
    await rig.runPastOpening(60_000);

    expect(raised).toBe(true);
    expect(rig.site.addEvents).toEqual([]);
    expect(rig.app.service.listJobs()[0]).toMatchObject({ state: 'failed', failureReason: 'stopped' });
  });
});

describe('a restart', () => {
  const seed = (startMs: number, advance: (store: SqliteJobStore, jobId: number, nowMs: number) => void): SqliteJobStore => {
    const store = new SqliteJobStore(':memory:');
    stores.push(store);
    const job = store.create({ gameDate: GAME_DAY, choices: [{ courtId: 9, startMinutes: 1080 }], durationMinutes: 90, payment: 'wallet' }, OPENS_MS, startMs);
    advance(store, job.id, startMs);
    return store;
  };

  it('after a crash during a booking request: reconciles with the calendar, books nothing, tells the owner', async () => {
    const startMs = OPENS_MS + 5_000;
    const store = seed(startMs, (s, id, now) => {
      s.transition(id, 'scheduled', 'warming', now);
      s.transition(id, 'warming', 'firing', now, { attemptsDelta: 1 });
    });
    rig = createRig({ startMs, store: Object.assign(store, { close: () => undefined }) });
    rig.site.bookings.push({ gameDate: GAME_DAY, courtId: 9, startMinutes: 1080, durationMinutes: 90, reservationId: FIRST_RESERVATION_ID });
    await rig.start(60_000);

    expect(rig.site.addEvents).toEqual([]);
    expect(rig.app.service.listJobs()[0]).toMatchObject({ state: 'booked', bookedChoice: { courtId: 9, startMinutes: 1080 } });
    expect(messagesWith(rig, 'ЗАБРОНИРОВАНО')).toHaveLength(1);
    expect(rig.logText()).toContain('recovery finished');
  });

  it('a job that was preparing when the bot stopped is re-armed and still books at the opening', async () => {
    const startMs = OPENS_MS - 4 * MINUTE;
    const store = seed(startMs, (s, id, now) => {
      s.transition(id, 'scheduled', 'warming', now);
    });
    rig = createRig({ startMs, store: Object.assign(store, { close: () => undefined }), latency: { probeForm: 300, book: 1900 } });
    await rig.start();
    expect(rig.logText()).toMatch(/"rescheduled":1/);

    await rig.runPastOpening();
    expect(rig.site.addEvents).toHaveLength(1);
    expect(rig.app.service.listJobs()[0]).toMatchObject({ state: 'booked', attempts: 1 });
  });
});

describe('secrets', () => {
  it('neither the log nor any Telegram message contains the password, the bot token, the hash or a cookie', async () => {
    rig = createRig({ latency: { probeForm: 300, book: 1900 } });
    rig.site.bookScript = (nth) => (nth === 0 ? 'taken_by_other' : 'lost_answer');
    await rig.start();
    await rig.owner.createJob(DAY, [...WISH, { court: 'Pista 8', time: '19:30' }]);
    await rig.runPastOpening(60_000);
    expect(rig.site.addEvents.length).toBeGreaterThan(0);

    const everything = [rig.logText(), ...rig.sent().map((message) => message.text), JSON.stringify(rig.transport.calls)].join('\n');
    for (const secret of [PASSWORD, SITE_HASH]) expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/laravel_session|XSRF-TOKEN/);
    // the token is part of the Telegram API URL only, which the fake transport never sees; the log must not carry it either
    expect(rig.logText()).not.toContain(FAKE_TOKEN);
    expect(rig.logText()).not.toMatch(/"(password|hash|token)":"(?!\[redacted\])/);
  });
});

describe('lifecycle', () => {
  it('stops in an orderly way even in the middle of the waiting period: the job stays armed in the store', async () => {
    rig = createRig();
    await rig.start();
    await rig.owner.createJob(DAY, WISH);
    await rig.runTo(HOUR_BEFORE);
    const [job] = rig.app.service.listJobs();
    expect(job?.state).toBe('scheduled');
    await rig.stop();
    expect(rig.logText()).toContain('stopped');
    expect(rig.site.addEvents).toEqual([]);
  });
});
