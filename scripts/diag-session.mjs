// Read-only diagnostics of the club session (no booking is ever sent). Run through scripts\diag-session.cmd.
// Prints cookie NAMES and attributes, status codes and sizes only: never a cookie value, hash, password or page body.
import { CookieJar } from 'tough-cookie';

const base = (process.env.RESERVAPLAY_BASE_URL ?? 'https://enjoyvalenciaclubesoutdoor.reservaplay.com').replace(/\/+$/, '');
const username = process.env.RESERVAPLAY_USERNAME;
const password = process.env.RESERVAPLAY_PASSWORD;
if (!username || !password) {
  console.error('RESERVAPLAY_USERNAME / RESERVAPLAY_PASSWORD missing in .env');
  process.exit(1);
}

const BOT_UA = 'vamos-a-padel-bot/0.1 (personal booking assistant for one account)';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const jar = new CookieJar();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const describeCookie = (c) =>
  `${c.key}(domain=${c.domain ?? '-'}${c.hostOnly ? '/hostOnly' : ''} path=${c.path}${c.secure ? ' secure' : ''}${c.httpOnly ? ' httpOnly' : ''} ${
    c.expires === 'Infinity' || c.expires === undefined ? 'session' : 'expires=' + new Date(c.expires).toISOString()
  } sameSite=${c.sameSite ?? '-'})`;

const call = async (label, method, path, { headers = {}, body, ua = BOT_UA } = {}) => {
  const url = base + path;
  const cookieString = await jar.getCookieString(url);
  const sent = cookieString === '' ? [] : cookieString.split('; ').map((c) => c.split('=')[0]);
  const started = performance.now();
  const response = await fetch(url, {
    method,
    redirect: 'manual',
    headers: { 'User-Agent': ua, ...headers, ...(cookieString === '' ? {} : { Cookie: cookieString }) },
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  const setCookies = response.headers.getSetCookie();
  for (const raw of setCookies) await jar.setCookie(raw, url, { ignoreError: true });
  console.log(
    `[${label}] ${method} -> HTTP ${response.status}, ${text.length} bytes, ${Math.round(performance.now() - started)} ms` +
      `, content-type=${response.headers.get('content-type') ?? '-'}` +
      `${response.headers.get('location') ? ', redirect=' + new URL(response.headers.get('location'), url).pathname : ''}`,
  );
  console.log(`    cookies sent: ${sent.join(', ') || '(none)'}`);
  console.log(`    cookies set : ${setCookies.map((raw) => raw.split('=')[0]).join(', ') || '(none)'}`);
  return { status: response.status, text };
};

const ACCEPT_HTML = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
const XHR = { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' };

const login = await call('login page', 'GET', '/login', { headers: ACCEPT_HTML });
const token = /name="_token"[^>]*value="([^"]+)"|value="([^"]+)"[^>]*name="_token"/.exec(login.text);
if (!token) throw new Error('no CSRF token on the login page');
await call('login submit', 'POST', '/login', {
  headers: { ...XHR, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams([
    ['_token', token[1] ?? token[2]],
    ['username', username],
    ['password', password],
  ]).toString(),
});
console.log('cookies in the jar after login:');
for (const c of await jar.getCookies(base + '/')) console.log('    ' + describeCookie(c));

const isLoginPage = (text) => /type="password"/i.test(text);
const week = await call('cal_week', 'GET', '/reserves/cal_week.php', { headers: ACCEPT_HTML });
console.log(`    looks like login page: ${isLoginPage(week.text)}`);

const slot = '/reserves/cal_event.php?data=2026-10-20%2000:00:00&hora=900&hora_fin=990&resource=11&date=26-10-13&diaheader20';
const form = await call('booking form', 'GET', slot, { headers: ACCEPT_HTML });
console.log(`    open form with hash: ${/id="event-form"/.test(form.text) && /name="hash"/.test(form.text)}; login page: ${isLoginPage(form.text)}`);
console.log('cookies in the jar after the form:');
for (const c of await jar.getCookies(base + '/')) console.log('    ' + describeCookie(c));

const probe = '/sportssuite/manager.php?op=get_user_list&name=zzzzqqqq&lvl=0&exclude_ids=-1';
const asBot = await call('manager.php read-only (bot UA)', 'GET', probe, { headers: XHR });
const asBrowser = await call('manager.php read-only (browser UA)', 'GET', probe, { headers: XHR, ua: BROWSER_UA });
for (const [name, r] of [['bot UA', asBot], ['browser UA', asBrowser]]) {
  try {
    const json = JSON.parse(r.text);
    console.log(`    ${name}: JSON, status field = ${String(json.status)}`);
  } catch {
    console.log(`    ${name}: not JSON`);
  }
}

for (const wait of [30, 60]) {
  console.log(`waiting ${wait} s to see whether the session survives ...`);
  await sleep(wait * 1000);
  const again = await call(`cal_week after +${wait} s`, 'GET', '/reserves/cal_week.php', { headers: ACCEPT_HTML });
  console.log(`    looks like login page: ${isLoginPage(again.text)}`);
}
console.log('done');
