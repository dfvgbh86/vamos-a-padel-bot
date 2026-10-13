/**
 * END-TO-END SIMULATION: the real app (createApp) against fakes. The owner creates a job through the Telegram flow,
 * virtual time runs to 07:00 Madrid, and the bot books the court. Synthetic data only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GAME_DAY, MINUTE, OPENS_MS, createRig, messagesWith, type Rig } from './_rig.js';
import { FIRST_RESERVATION_ID } from './_site.js';
import { OWNER_ID } from '../telegram/_harness.js';

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

const PISTA_7_AT_18 = { court: 'Pista 7', time: '18:00' } as const;
const PISTA_8_AT_1930 = { court: 'Pista 8', time: '19:30' } as const;
const FOR_20TH = 'вт 20.10';

describe('the owner arms a job and the bot books at 07:00', () => {
  it('books exactly once, stores the booking before telling the owner, and never books again', async () => {
    rig = createRig({ latency: { probeForm: 300, book: 1900 } });
    await rig.start();

    await rig.owner.createJob(FOR_20TH, [PISTA_7_AT_18]);
    expect(rig.owner.screen().text).toContain('Задание создано');
    const armed = rig.app.service.listJobs();
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({ state: 'scheduled', gameDate: GAME_DAY, opensAtMs: OPENS_MS, payment: 'wallet', durationMinutes: 90 });
    expect(rig.site.addEvents).toHaveLength(0);

    await rig.runPastOpening();

    // the site got exactly one booking request, for the wished court, time and duration, paid from the wallet
    expect(rig.site.addEvents).toHaveLength(1);
    const body = new URLSearchParams(rig.site.addEvents[0]?.body);
    expect(body.get('op')).toBe('add_event');
    expect(body.get('data')).toBe('2026-10-20 00:00:00');
    expect(body.get('recurso')).toBe('9');
    expect(body.get('time_ini')).toBe('18:00');
    expect(body.get('duration')).toBe('90');
    expect(body.get('socis')).toBe('12345,3,3,3');
    expect(body.get('tipo_pago_anticipado_socio')).toBe('5');

    // the window was respected: the request left only after the server itself had opened the window
    expect(rig.site.bookedBeforeOpen).toBe(0);
    expect(rig.site.addEvents[0]?.serverMs).toBeGreaterThanOrEqual(OPENS_MS);
    expect(rig.site.maxBooksInFlight).toBe(1);

    // the job is booked in the store, with the reservation id and the wished slot
    const [job] = rig.app.service.listJobs();
    expect(job).toMatchObject({
      state: 'booked',
      reservationId: FIRST_RESERVATION_ID,
      bookedChoice: { courtId: 9, startMinutes: 1080 },
      attempts: 1,
      failureReason: null,
    });

    // the owner was told, and the store already said "booked" when the message left
    const [booked] = messagesWith(rig, 'ЗАБРОНИРОВАНО');
    expect(booked?.chatId).toBe(OWNER_ID);
    expect(booked?.text).toContain('Pista 7 semicubierta');
    expect(booked?.text).toContain('вт 20.10.2026');
    expect(booked?.text).toContain('18:00–19:30');
    expect(booked?.text).toContain(`Номер брони: ${FIRST_RESERVATION_ID}`);
    expect(booked?.storeState).toBe('booked');
    expect(messagesWith(rig, 'ЗАБРОНИРОВАНО')).toHaveLength(1);

    // ten more minutes: still one booking request, no double booking, nothing cancelled
    await rig.runTo(OPENS_MS + 10 * MINUTE);
    expect(rig.site.addEvents).toHaveLength(1);
    expect(rig.site.doubleBookings).toBe(0);
    expect(rig.site.bookings).toHaveLength(1);
    expect(rig.site.cancelRequests).toEqual([]);
    expect(rig.app.service.listJobs()[0]?.state).toBe('booked');
  });

  it('walks through the whole preparation: armed, preflight ok, window open, booked - in that order', async () => {
    rig = createRig({ latency: { probeForm: 300, book: 1900 } });
    await rig.start();
    await rig.owner.createJob(FOR_20TH, [PISTA_7_AT_18]);
    await rig.runPastOpening();

    const order = ['заряжено', 'Предстартовая проверка пройдена', 'Окно бронирования открылось', 'ЗАБРОНИРОВАНО'];
    const texts = rig.sent().map((message) => message.text);
    const positions = order.map((marker) => texts.findIndex((text) => text.includes(marker)));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // the owner is the only recipient of anything the bot sends
    expect(new Set(rig.sent().map((message) => message.chatId))).toEqual(new Set([OWNER_ID]));
  });

  it('logs in on demand for the owner (the date picker) and again for the preflight, nothing else', async () => {
    rig = createRig();
    await rig.start();
    expect(rig.site.loginCount).toBe(0);
    await rig.owner.createJob(FOR_20TH, [PISTA_7_AT_18]);
    expect(rig.site.loginCount).toBe(1);
    await rig.runPastOpening();
    expect(rig.site.loginCount).toBe(2);
    expect(rig.site.count('keepAlive')).toBeGreaterThan(0);
  });

  it('falls through to the second wish when somebody else takes the first slot in the opening second', async () => {
    rig = createRig({ latency: { probeForm: 300, book: 1900 } });
    rig.site.bookScript = (nth) => (nth === 0 ? 'taken_by_other' : 'ok');
    await rig.start();
    await rig.owner.createJob(FOR_20TH, [PISTA_7_AT_18, PISTA_8_AT_1930]);
    await rig.runPastOpening(60_000);

    // two requests, one after the other (never two in flight), for two different slots; one booking in the end
    expect(rig.site.addEvents.map((event) => [event.courtId, event.startMinutes])).toEqual([
      [9, 1080],
      [10, 1170],
    ]);
    expect(rig.site.maxBooksInFlight).toBe(1);
    expect(rig.site.bookings).toHaveLength(1);
    expect(rig.site.doubleBookings).toBe(0);
    expect(rig.app.service.listJobs()[0]).toMatchObject({ state: 'booked', bookedChoice: { courtId: 10, startMinutes: 1170 } });
    expect(messagesWith(rig, 'ЗАБРОНИРОВАНО')[0]?.text).toContain('Pista 8 exterior');
  });

  it('does not offer academy courts on a weekday, even though the site lists them', async () => {
    rig = createRig();
    await rig.start();
    await rig.owner.say('/new');
    await rig.owner.press(FOR_20TH);
    const courts = rig.owner.screen().buttons.map((button) => button.text).filter((text) => text.startsWith('Pista'));
    expect(courts.map((text) => text.split(' ').slice(0, 2).join(' '))).toEqual(['Pista 4', 'Pista 7', 'Pista 8', 'Pista 9', 'Pista 10']);
    expect(rig.site.count('getDay')).toBeGreaterThan(0);
  });
});
