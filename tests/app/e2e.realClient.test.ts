/**
 * END-TO-END with the REAL ReservaPlay client: cookies, CSRF login, calendar parsing, form classification, price
 * quote and the booking POST all run for real, over the fixture site (fake fetch) that opens its window at the
 * virtual 07:00. Together with e2e.booking.test.ts (fake API) this covers the client <-> sniper <-> Telegram seam.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { parseGameDate } from '../../src/config/gameDate.js';
import { CLUB_LUXON_OPTIONS } from '../../src/config/timezone.js';
import { bookingOpensAt } from '../../src/sniper/openTime.js';
import { calendarPayload } from '../fixtures/reservaplay/calendar.js';
import { ACCOUNT_ID, BASE_URL, HASH, PASSWORD, USERNAME } from '../fixtures/reservaplay/constants.js';
import { bodyParams } from '../fixtures/reservaplay/fakeFetch.js';
import { createFakeSite, type FakeSite as FixtureSite } from '../fixtures/reservaplay/fakeSite.js';
import { bookingErrorPayload, bookingOkPayload, closedWindowHtml, dailyLimitHtml, openFormHtml, walletPageHtml } from '../fixtures/reservaplay/pages.js';
import { htmlResponse, jsonResponse } from '../fixtures/reservaplay/responses.js';
import { GAME_DAY, MINUTE, OPENS_MS, createRig, messagesWith, type Rig } from './_rig.js';
import type { VirtualClock } from './_virtualClock.js';

const RESERVATION_ID = 100_002;

interface AddEventSeen {
  readonly serverMs: number;
  readonly params: URLSearchParams;
  readonly cookie: string;
}

/** A club site (fixtures) whose booking window follows the virtual clock, like the real one. */
const clubSite = (clock: VirtualClock) => {
  const site: FixtureSite = createFakeSite();
  const addEvents: AddEventSeen[] = [];
  let bookedOn: string | null = null;
  let walletCents = 5000;
  let beforeOpen = 0;

  const slotsOf = (date: string) =>
    [1080, 1170].map((start) => ({ start, end: start + 90, duration: 90, ...(bookedOn === date && start === 1080 ? { own: true, taken: true } : {}) }));

  const requestedDay = (): string => {
    const url = new URL(site.calls.at(-1)?.url ?? BASE_URL);
    return `20${(url.searchParams.get('day') ?? '').slice(0, 8)}`;
  };

  site.state.calendar = () => {
    const date = requestedDay();
    return calendarPayload([
      { id: 4, name: 'Pista 4', slots: slotsOf(date).map(({ own: _own, taken: _taken, ...rest }) => rest) },
      { id: 9, name: 'Pista 7', slots: slotsOf(date) },
    ]);
  };

  site.state.form = (call) => {
    const date = new URL(call.url).searchParams.get('data')?.slice(0, 10) ?? '';
    if (bookedOn === date) return htmlResponse(dailyLimitHtml());
    if (clock.serverNowMs() < bookingOpensAt(parseGameDate(date)).toMillis()) {
      const reading = DateTime.fromMillis(Math.floor(clock.serverNowMs() / 1000) * 1000, CLUB_LUXON_OPTIONS);
      return htmlResponse(closedWindowHtml(reading.toFormat('dd/MM/yyyy HH:mm:ss')));
    }
    return htmlResponse(openFormHtml());
  };

  site.state.wallet = () => walletPageHtml(walletCents);

  site.state.manager = async (call) => {
    const params = bodyParams(call);
    if (params.get('op') !== 'add_event') return jsonResponse(bookingErrorPayload('not expected'));
    addEvents.push({ serverMs: clock.serverNowMs(), params, cookie: call.headers['cookie'] ?? '' });
    await clock.sleep(1900);
    const date = params.get('data')?.slice(0, 10) ?? '';
    if (clock.serverNowMs() < bookingOpensAt(parseGameDate(date)).toMillis()) {
      beforeOpen++;
      return jsonResponse(bookingErrorPayload('No puedes reservar hasta las 07:00'));
    }
    if (bookedOn !== null || params.get('hash') !== HASH) return jsonResponse(bookingErrorPayload('Ya tienes 1 reserva/s para este dia'));
    bookedOn = date;
    walletCents -= 1902;
    return jsonResponse(bookingOkPayload(RESERVATION_ID));
  };

  return { site, addEvents, beforeOpen: () => beforeOpen, bookedOn: () => bookedOn };
};

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.stop();
  rig = undefined;
});

const setup = () => {
  const holder: { club?: ReturnType<typeof clubSite> } = {};
  // the club needs the rig's clock, the rig needs the club's fetch: the clock is created first by the rig, the fetch late-binds
  const lateFetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (holder.club === undefined) throw new Error('the club site is not ready');
    return holder.club.site.fetchImpl(input, init);
  }) as typeof fetch;
  const built = createRig({
    fetchImpl: lateFetch,
    env: { baseUrl: BASE_URL, username: USERNAME, password: PASSWORD },
  });
  holder.club = clubSite(built.clock);
  rig = built;
  return { rig: built, club: holder.club };
};

describe('the real client against the club fixtures: from /new to a booking at 07:00', () => {
  it('logs in, prepares, waits for the open form, sends exactly one booking request, and tells the owner', async () => {
    const { rig: bot, club } = setup();
    await bot.start();
    await bot.owner.createJob('вт 20.10', [{ court: 'Pista 7', time: '18:00' }]);
    expect(bot.owner.screen().text).toContain('Задание создано');
    expect(club.addEvents).toHaveLength(0);

    await bot.runPastOpening();

    expect(club.addEvents).toHaveLength(1);
    const [request] = club.addEvents;
    expect(request?.serverMs).toBeGreaterThanOrEqual(OPENS_MS);
    expect(club.beforeOpen()).toBe(0);
    expect(Object.fromEntries(request?.params ?? [])).toMatchObject({
      op: 'add_event',
      hash: HASH,
      data: '2026-10-20 00:00:00',
      recurso: '9',
      time_ini: '18:00',
      duration: '90',
      socis: `${ACCOUNT_ID},3,3,3`,
      tipo_pago_anticipado_socio: '5',
    });
    expect(request?.cookie).toContain('laravel_session=sess-authed');

    expect(bot.app.service.listJobs()[0]).toMatchObject({ state: 'booked', reservationId: RESERVATION_ID, attempts: 1 });
    const [told] = messagesWith(bot, 'ЗАБРОНИРОВАНО');
    expect(told?.text).toContain(`Номер брони: ${RESERVATION_ID}`);
    expect(told?.storeState).toBe('booked');
  });

  it('sends nothing to the booking endpoint until the window is open, and never a second request afterwards', async () => {
    const { rig: bot, club } = setup();
    await bot.start();
    await bot.owner.createJob('вт 20.10', [{ court: 'Pista 7', time: '18:00' }]);
    await bot.runTo(OPENS_MS - 5_000);
    expect(club.site.callsTo('manager.php')).toEqual([]);
    expect(club.site.callsTo('cal_event.php').length).toBeGreaterThan(0);

    await bot.runTo(OPENS_MS + 10 * MINUTE);
    expect(club.site.callsTo('manager.php')).toHaveLength(1);
    expect(club.bookedOn()).toBe(GAME_DAY);
  });

  it('keeps the session cookie and the CSRF login out of the log and out of Telegram', async () => {
    const { rig: bot } = setup();
    await bot.start();
    await bot.owner.createJob('вт 20.10', [{ court: 'Pista 7', time: '18:00' }]);
    await bot.runPastOpening();
    const everything = [bot.logText(), ...bot.sent().map((message) => message.text)].join('\n');
    for (const secret of [PASSWORD, HASH, 'sess-authed', 'sess-guest', 'synthetic-csrf-token-0001', 'xsrf-01']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('reads the real calendar for the date picker and offers only courts the bot may book on a weekday', async () => {
    const { rig: bot } = setup();
    await bot.start();
    await bot.owner.say('/new');
    await bot.owner.press('вт 20.10');
    const courts = bot.owner.screen().buttons.map((button) => button.text).filter((text) => text.startsWith('Pista'));
    expect(courts.map((text) => text.split(' ').slice(0, 2).join(' '))).toEqual(['Pista 4', 'Pista 7']);
  });
});
