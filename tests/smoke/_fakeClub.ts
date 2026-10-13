/**
 * A fake ReservaPlay club site on a real loopback socket (127.0.0.1, ephemeral port): login page with a CSRF token,
 * POST /login with a cookie session, calendar JSON, booking form with the account hash and the host id, wallet page,
 * payment options, guest prices and POST /sportssuite/manager.php. The page formats are the ones of the fixtures in
 * tests/fixtures/reservaplay; only the transport (real HTTP) and the state (session, bookings, wallet) live here.
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { calendarPayload, type FixtureCourt } from '../fixtures/reservaplay/calendar.js';
import {
  bookingErrorPayload,
  bookingOkPayload,
  closedWindowHtml,
  dailyLimitHtml,
  guestInfoPayload,
  loginPageHtml,
  openFormHtml,
  paymentOptionsPayload,
  walletPageHtml,
} from '../fixtures/reservaplay/pages.js';
import { clubDate, type Synthetic } from './_synthetic.js';
import { sleep } from './_wait.js';

/** The ten courts of the club (resource ids, not Pista numbers); the academy ones are listed too, like on the real site. */
export const CLUB_COURT_IDS: readonly number[] = [1, 2, 3, 4, 7, 8, 9, 10, 11, 12];
/** Slot starts of the synthetic club: two 90 minute slots (18:00 and 19:30). */
export const SLOT_STARTS: readonly number[] = [1080, 1170];
export const SLOT_MINUTES = 90;
/** Price of one booking: the host 3.00 EUR plus three guests at 5.34 EUR (the site's own figures in the fixtures). */
export const BOOKING_CENTS = 1902;

export interface ClubRequest {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  /** What the fake answered: open_form, closed_form, daily_limit_form, login_redirect, booked, ... */
  served: string;
}

export interface OwnBooking {
  readonly date: string;
  readonly courtId: number;
  readonly startMinutes: number;
  readonly reservationId: number;
}

export interface FakeClub {
  readonly origin: string;
  readonly requests: readonly ClubRequest[];
  readonly bookings: readonly OwnBooking[];
  /** add_event requests that arrived, accepted or not. */
  addEvents(): ClubRequest[];
  /** del_event requests: the bot must never send one. */
  cancelRequests(): ClubRequest[];
  walletCents(): number;
  close(): Promise<void>;
}

interface Reply {
  readonly status: number;
  readonly served: string;
  readonly type?: string;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string | string[]>>;
}

const HTML = 'text/html; charset=UTF-8';
const JSON_TYPE = 'application/json';

const html = (served: string, body: string, headers?: Reply['headers']): Reply => ({
  status: 200,
  served,
  type: HTML,
  body,
  ...(headers === undefined ? {} : { headers }),
});
const json = (served: string, value: unknown): Reply => ({ status: 200, served, type: JSON_TYPE, body: JSON.stringify(value) });
const redirect = (served: string, location: string, cookies: string[] = []): Reply => ({
  status: 302,
  served,
  headers: { location, ...(cookies.length === 0 ? {} : { 'set-cookie': cookies }) },
});

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const send = (response: ServerResponse, reply: Reply): void => {
  response.writeHead(reply.status, { ...(reply.type === undefined ? {} : { 'content-type': reply.type }), ...reply.headers });
  response.end(reply.body ?? '');
};

/** Plain session cookies: the cookie jar of the bot never stores a Secure cookie that came over http. */
const sessionCookie = (value: string): string => `laravel_session=${value}; Path=/; HttpOnly`;

export const createFakeClub = async (synthetic: Synthetic): Promise<FakeClub> => {
  const requests: ClubRequest[] = [];
  const bookings: OwnBooking[] = [];
  let wallet = 5000;
  let nextSeq = 1;

  const hasCookie = (request: ClubRequest, session: string): boolean =>
    (request.headers['cookie'] ?? '').split('; ').includes(`laravel_session=${session}`);

  const slotsOf = (courtId: number, date: string): FixtureCourt['slots'] =>
    SLOT_STARTS.map((start) => {
      const own = bookings.some((b) => b.date === date && b.courtId === courtId && b.startMinutes === start);
      const heldByOthers = courtId === 9 || (courtId === 4 && start === 1170);
      return { start, end: start + SLOT_MINUTES, duration: SLOT_MINUTES, taken: own || heldByOthers, ...(own ? { own: true } : {}) };
    });

  const calendar = (request: ClubRequest): Reply => {
    const day = request.query.get('day') ?? '';
    const date = `20${day.slice(0, 8)}`;
    const courts = CLUB_COURT_IDS.map((id) => ({ id, name: `Pista ${id}`, slots: slotsOf(id, date) }));
    return json('calendar', calendarPayload(courts));
  };

  const form = (request: ClubRequest): Reply => {
    const date = (request.query.get('data') ?? '').slice(0, 10);
    if (bookings.some((booking) => booking.date === date)) return html('daily_limit_form', dailyLimitHtml());
    if (date > clubDate(7)) return html('closed_form', closedWindowHtml());
    return html('open_form', openFormHtml({ hash: synthetic.hash, accountId: synthetic.accountId }));
  };

  const login = (request: ClubRequest): Reply => {
    const params = new URLSearchParams(request.body);
    const valid =
      params.get('_token') === synthetic.csrfToken &&
      params.get('username') === synthetic.username &&
      params.get('password') === synthetic.password &&
      hasCookie(request, synthetic.guestSession);
    if (!valid) return redirect('login_refused', '/login', [sessionCookie(synthetic.guestSession)]);
    return redirect('login_ok', '/home', [sessionCookie(synthetic.authedSession), `XSRF-TOKEN=${synthetic.xsrfCookie}; Path=/`]);
  };

  const addEvent = async (params: URLSearchParams): Promise<Reply> => {
    await sleep(150);
    const date = (params.get('data') ?? '').slice(0, 10);
    const [hours, minutes] = (params.get('time_ini') ?? '0:0').split(':').map(Number);
    const startMinutes = (hours ?? 0) * 60 + (minutes ?? 0);
    if (params.get('hash') !== synthetic.hash) return json('add_event_bad_hash', bookingErrorPayload('Token no valido'));
    if (date > clubDate(7)) return json('add_event_too_early', bookingErrorPayload('No puedes reservar hasta las 07:00'));
    if (bookings.some((booking) => booking.date === date)) {
      return json('add_event_daily_limit', bookingErrorPayload('Ya tienes 1 reserva/s para este dia'));
    }
    const reservationId = synthetic.reservationId + bookings.length;
    bookings.push({ date, courtId: Number(params.get('recurso')), startMinutes, reservationId });
    wallet -= BOOKING_CENTS;
    return json('booked', bookingOkPayload(reservationId));
  };

  const manager = async (request: ClubRequest): Promise<Reply> => {
    const params = new URLSearchParams(request.body);
    if (request.headers['x-requested-with'] !== 'XMLHttpRequest') return { status: 400, served: 'manager_not_xhr', body: 'bad request' };
    if (params.get('op') === 'add_event') return addEvent(params);
    return json('manager_other', bookingErrorPayload('operation not supported by the fake club'));
  };

  const protectedRoute = async (request: ClubRequest): Promise<Reply> => {
    const { path } = request;
    if (path === '/reserves/cal_week.php') return html('cal_week', '<html><body><div id="week">Semana</div></body></html>');
    if (path === '/api/tipo_recurso/1/reservas_usuario') return calendar(request);
    if (path === '/reserves/cal_event.php') return form(request);
    if (path === '/view/reserves/compra-moneder') return html('wallet', walletPageHtml(wallet));
    if (path === '/sportssuite/manager.php' && request.method === 'POST') return manager(request);
    if (path.startsWith('/view/reserves/load_content/pago_anticipado_select/')) return json('payment_options', paymentOptionsPayload());
    if (path.startsWith('/api/reserves/socios/')) return json('guest_prices', guestInfoPayload());
    return { status: 404, served: 'not_found', body: 'not found' };
  };

  const route = async (request: ClubRequest): Promise<Reply> => {
    if (request.path === '/login') {
      if (request.method === 'POST') return login(request);
      return html('login_page', loginPageHtml({ token: synthetic.csrfToken }), { 'set-cookie': [sessionCookie(synthetic.guestSession)] });
    }
    if (!hasCookie(request, synthetic.authedSession)) return redirect('login_redirect', '/login');
    return protectedRoute(request);
  };

  const server: Server = createServer((incoming, response) => {
    void readBody(incoming).then(async (body) => {
      const url = new URL(incoming.url ?? '/', 'http://club.local');
      const request: ClubRequest = {
        seq: nextSeq++,
        method: incoming.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: incoming.headers,
        body,
        served: 'pending',
      };
      requests.push(request);
      const reply = await route(request);
      request.served = reply.served;
      send(response, reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    bookings,
    addEvents: () => requests.filter((request) => request.method === 'POST' && request.body.includes('op=add_event')),
    cancelRequests: () => requests.filter((request) => request.body.includes('op=del_event')),
    walletCents: () => wallet,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
