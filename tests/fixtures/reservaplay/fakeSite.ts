import { CSRF_TOKEN, PASSWORD, USERNAME } from './constants.js';
import { calendarPayload } from './calendar.js';
import { createFakeFetch, type FakeFetch, type RecordedCall } from './fakeFetch.js';
import {
  bookingOkPayload,
  cancelOkPayload,
  guestInfoPayload,
  loginPageHtml,
  openFormHtml,
  paymentOptionsPayload,
  walletPageHtml,
} from './pages.js';
import { htmlResponse, jsonResponse, redirectResponse } from './responses.js';

/** Cookie values are deliberately short, fake and obviously not real. */
export const GUEST_SESSION = 'sess-guest';
export const AUTHED_SESSION = 'sess-authed';

type Respond = (call: RecordedCall, signal: AbortSignal | undefined) => Response | Promise<Response>;

export interface FakeSite extends FakeFetch {
  /** The site forgets the session: protected pages redirect to /login until the next successful login. */
  expireSession(): void;
  readonly state: {
    sessionAlive: boolean;
    acceptCredentials: boolean;
    loginPage: () => string;
    calendar: () => unknown;
    form: Respond;
    wallet: () => string;
    paymentOptions: () => unknown;
    guestInfo: () => Response;
    manager: Respond;
  };
  callsTo(pathFragment: string): RecordedCall[];
}

const protectedPath = (path: string): boolean => path !== '/login';

const hasAuthedCookie = (call: RecordedCall): boolean => (call.headers['cookie'] ?? '').split('; ').includes(`laravel_session=${AUTHED_SESSION}`);

/** An in-memory stand-in for the club website with a real cookie session (login, protected pages, redirect to /login). */
export const createFakeSite = (): FakeSite => {
  const state: FakeSite['state'] = {
    sessionAlive: true,
    acceptCredentials: true,
    loginPage: () => loginPageHtml(),
    calendar: () => calendarPayload([{ id: 9, name: 'Pista 7', slots: [{ start: 1080, end: 1170, duration: 90 }] }]),
    form: () => htmlResponse(openFormHtml()),
    wallet: () => walletPageHtml(1902),
    paymentOptions: () => paymentOptionsPayload(),
    guestInfo: () => jsonResponse(guestInfoPayload()),
    manager: (call) => jsonResponse(call.body?.includes('op=del_event') ? cancelOkPayload() : bookingOkPayload(100002)),
  };

  const login = (call: RecordedCall): Response => {
    const params = new URLSearchParams(call.body ?? '');
    const valid =
      state.acceptCredentials &&
      params.get('_token') === CSRF_TOKEN &&
      params.get('username') === USERNAME &&
      params.get('password') === PASSWORD &&
      (call.headers['cookie'] ?? '').includes(`laravel_session=${GUEST_SESSION}`);
    if (!valid) return redirectResponse('/login', { cookies: [`laravel_session=${GUEST_SESSION}; Path=/; Secure; HttpOnly`] });
    state.sessionAlive = true;
    return redirectResponse('/home', {
      cookies: [`laravel_session=${AUTHED_SESSION}; Path=/; Secure; HttpOnly`, 'XSRF-TOKEN=xsrf-01; Path=/; Secure'],
    });
  };

  const handler = (call: RecordedCall, signal: AbortSignal | undefined): Response | Promise<Response> => {
    const url = new URL(call.url);
    if (url.pathname === '/login') {
      if (call.method === 'POST') return login(call);
      return htmlResponse(state.loginPage(), {
        cookies: [`laravel_session=${GUEST_SESSION}; Path=/; Secure; HttpOnly`, 'AWSALB=alb-01; Path=/'],
      });
    }
    if (protectedPath(url.pathname) && !(state.sessionAlive && hasAuthedCookie(call))) return redirectResponse('/login');

    switch (url.pathname) {
      case '/reserves/cal_week.php':
        return htmlResponse('<html><body><div id="week">Semana</div></body></html>');
      case '/api/tipo_recurso/1/reservas_usuario':
        return jsonResponse(state.calendar());
      case '/reserves/cal_event.php':
        return state.form(call, signal);
      case '/view/reserves/compra-moneder':
        return htmlResponse(state.wallet());
      case '/sportssuite/manager.php':
        return state.manager(call, signal);
      default:
        if (url.pathname.startsWith('/view/reserves/load_content/pago_anticipado_select/')) return jsonResponse(state.paymentOptions());
        if (url.pathname.startsWith('/api/reserves/socios/')) return state.guestInfo();
        return new Response('not found', { status: 404 });
    }
  };

  const fake = createFakeFetch(handler);
  return {
    ...fake,
    state,
    expireSession: () => {
      state.sessionAlive = false;
    },
    callsTo: (fragment) => fake.calls.filter((call) => call.url.includes(fragment)),
  };
};
