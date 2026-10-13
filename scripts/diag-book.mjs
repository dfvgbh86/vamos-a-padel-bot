// REHEARSAL: books ONE court like the site's own page does (form, payment options, guest prices, then add_event) and
// IMMEDIATELY cancels it again (the money returns to the Monedero). Run through scripts\diag-book.cmd with the bot stopped.
// Uses the bot's own request builders from dist\. Prints statuses, ids and the site's short messages; never cookies,
// hashes, passwords or page bodies.
import { CookieJar } from 'tough-cookie';
import { createEndpoints, cancelBody } from '../dist/src/reservaplay/client/endpoints.js';
import { MANAGER_POST_HEADERS, pageHeaders } from '../dist/src/reservaplay/client/headers.js';
import { buildAddEventBody } from '../dist/src/reservaplay/bookingBody.js';
import { classifyFormPage, classifyAddEventResponse } from '../dist/src/reservaplay/classify.js';
import { parseHostAccountId, parseWalletCents, parseCsrfToken, parsePaymentOptions } from '../dist/src/reservaplay/parsers/index.js';
import { buildHolidaySet } from '../dist/src/config/holidays.js';
import { DateTime } from 'luxon';

const base = (process.env.RESERVAPLAY_BASE_URL ?? 'https://enjoyvalenciaclubesoutdoor.reservaplay.com').replace(/\/+$/, '');
const { RESERVAPLAY_USERNAME: username, RESERVAPLAY_PASSWORD: password } = process.env;
if (!username || !password) {
  console.error('RESERVAPLAY_USERNAME / RESERVAPLAY_PASSWORD missing in .env');
  process.exit(1);
}

const SLOT = { gameDate: '2026-10-20', courtId: 11, startMinutes: 900, durationMinutes: 90 }; // Tuesday, Pista 9, 15:00
const UA = 'vamos-a-padel-bot/0.1 (personal booking assistant for one account)';
const jar = new CookieJar();
const endpoints = createEndpoints(base);
const ACCEPT_HTML = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
const XHR = { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' };

const call = async (label, method, url, { headers = {}, body } = {}) => {
  const cookieString = await jar.getCookieString(url);
  const started = performance.now();
  const response = await fetch(url, {
    method,
    redirect: 'manual',
    headers: { 'User-Agent': UA, ...headers, ...(cookieString === '' ? {} : { Cookie: cookieString }) },
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  for (const raw of response.headers.getSetCookie()) await jar.setCookie(raw, url, { ignoreError: true });
  console.log(`[${label}] HTTP ${response.status}, ${text.length} bytes, ${Math.round(performance.now() - started)} ms`);
  return { status: response.status, text, location: response.headers.get('location') };
};

const shortJson = (text) => {
  try {
    const json = JSON.parse(text);
    const msg = typeof json?.data?.msg === 'string' ? json.data.msg.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : null;
    return { status: json.status, msg, redirect: json?.data?.redirect?.url ?? null };
  } catch {
    return null;
  }
};

const walletCents = async () => {
  const w = await call('wallet', 'GET', endpoints.wallet, { headers: ACCEPT_HTML });
  return parseWalletCents(w.text);
};

// --- login
const loginPage = await call('login page', 'GET', endpoints.login, { headers: ACCEPT_HTML });
const token = parseCsrfToken(loginPage.text);
if (token === null) throw new Error('no CSRF token');
await call('login submit', 'POST', endpoints.login, {
  headers: { ...XHR, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams([['_token', token], ['username', username], ['password', password]]).toString(),
});
const before = await walletCents();
console.log(`wallet before: ${before} cents`);
if (before === null || before < 1902) {
  console.log('The wallet does not hold one booking (1902 cents): stopping, nothing was booked.');
  process.exit(0);
}

// --- what the site's own page does before the user presses "Reservar"
const now = DateTime.now().setZone('Europe/Madrid');
const form = await call('booking form', 'GET', endpoints.slotForm(SLOT, now), {
  headers: { ...ACCEPT_HTML, 'Accept-Language': 'es-ES,es;q=0.9', ...pageHeaders(base, SLOT.gameDate) },
});
const gate = classifyFormPage(form.text);
const accountId = parseHostAccountId(form.text);
console.log(`form gate: ${gate.kind}; account id found: ${accountId !== null}`);
if (gate.kind !== 'open' || accountId === null) {
  console.log('The form is not open for this slot: stopping, nothing was booked.');
  process.exit(0);
}
const pay = await call('payment options', 'GET', endpoints.paymentOptions(SLOT, accountId), { headers: XHR });
let options = null;
try {
  options = parsePaymentOptions(JSON.parse(pay.text));
} catch {
  /* not JSON */
}
console.log(`payment options parsed: ${options !== null}${options ? `, wallet payable: ${options.walletPayable}, host price cents: ${options.hostPriceCents}` : ''}`);
const guests = await call('guest prices', 'GET', endpoints.guestInfo(SLOT, accountId), { headers: XHR });
console.log(`guest prices answered: ${guests.status}`);

// --- ONE booking request, built by the bot's own builder
const body = buildAddEventBody({
  hash: gate.hash,
  accountId,
  ...SLOT,
  payment: 'wallet',
  holidays: buildHolidaySet(undefined),
});
const posted = await call('add_event (the only booking request)', 'POST', endpoints.manager, {
  headers: { ...MANAGER_POST_HEADERS, ...pageHeaders(base, SLOT.gameDate) },
  body,
});
const outcome = classifyAddEventResponse({ status: posted.status, location: posted.location, body: posted.text });
console.log(`classified as: ${outcome.kind}${outcome.reservationId ? ', reservation id ' + outcome.reservationId : ''}`);
const info = shortJson(posted.text);
if (info) console.log(`site said: status=${info.status}, msg=${info.msg}`);
else console.log('the answer is not JSON (a 500 page is deliberately not shown)');

if (outcome.kind === 'ok') {
  console.log('BOOKED. Cancelling at once (refund to the Monedero) ...');
  const cancelled = await call('cancel', 'POST', endpoints.manager, {
    headers: { ...MANAGER_POST_HEADERS, ...pageHeaders(base, SLOT.gameDate) },
    body: cancelBody(outcome.reservationId, accountId),
  });
  const c = shortJson(cancelled.text);
  console.log(`cancel: HTTP ${cancelled.status}${c ? `, status=${c.status}, msg=${c.msg}` : ''}`);
}
const after = await walletCents();
console.log(`wallet after: ${after} cents (before: ${before})`);
if (after !== before) console.log('!!! The wallet changed: CHECK THE SITE (my reservations, the Monedero) and cancel by hand if a booking is left.');
console.log('done');
