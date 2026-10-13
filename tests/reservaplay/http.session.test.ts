import { describe, expect, it } from 'vitest';
import { AuthExpiredError } from '../../src/reservaplay/errors.js';
import {
  createHttpSession,
  isAuthRejection,
  normalizeBaseUrl,
  TransportError,
  USER_AGENT,
} from '../../src/reservaplay/http.js';
import { BASE_URL } from '../fixtures/reservaplay/constants.js';
import { createFakeFetch } from '../fixtures/reservaplay/fakeFetch.js';
import { emptyResponse, htmlResponse, redirectResponse } from '../fixtures/reservaplay/responses.js';
import { captureLogger } from './helpers.js';
import { failureOf, get, open } from './httpHelpers.js';

describe('normalizeBaseUrl', () => {
  it.each([
    ['https://club.example.test', 'https://club.example.test'],
    ['https://club.example.test/', 'https://club.example.test'],
    ['https://club.example.test///', 'https://club.example.test'],
    ['https://CLUB.example.test:443/', 'https://club.example.test'],
    ['https://club.example.test:8443', 'https://club.example.test:8443'],
    ['https://club.example.test/app/', 'https://club.example.test/app'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
  ])('accepts %s', (raw, normalized) => {
    expect(normalizeBaseUrl(raw)).toBe(normalized);
  });

  it.each([
    ['plain http on a real host (the password would travel in clear text)', 'http://club.example.test'],
    ['another scheme', 'ftp://club.example.test'],
    ['garbage', 'not a url'],
    ['an empty string', ''],
    ['embedded credentials', 'https://someone:hunter2@club.example.test'],
    ['a query string', 'https://club.example.test/?a=1'],
    ['a fragment', 'https://club.example.test/#x'],
    ['a lookalike of localhost', 'http://localhost.evil.test'],
  ])('rejects %s', (_name, raw) => {
    expect(() => normalizeBaseUrl(raw)).toThrow();
  });

  it('does not echo credentials in the error', () => {
    try {
      normalizeBaseUrl('https://someone:hunter2@club.example.test');
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2');
    }
  });
});

describe('isAuthRejection', () => {
  it.each([
    [401, null, true],
    [419, null, true],
    [302, '/login', true],
    [301, 'https://club.example.test/login?next=1', true],
    [307, '/login', true],
    [302, '/home', false],
    [302, null, false],
    [200, '/login', false],
    [403, null, false],
    [500, null, false],
  ])('status %i with location %j gives %s', (status, location, expected) => {
    expect(isAuthRejection(status, location)).toBe(expected);
  });
});

describe('request basics', () => {
  it('sends the method, headers and body, never follows redirects and identifies itself plainly', async () => {
    const { session, calls } = open(() => htmlResponse('ok'));
    await session.request({
      method: 'POST',
      url: `${BASE_URL}/form`,
      label: 'test',
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'Mozilla/5.0 pretending' },
      body: 'a=1&b=2',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${BASE_URL}/form`, method: 'POST', body: 'a=1&b=2', redirect: 'manual' });
    expect(calls[0]?.headers['x-requested-with']).toBe('XMLHttpRequest');
    expect(calls[0]?.headers['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/vamos-a-padel-bot/);
    expect(USER_AGENT).not.toMatch(/mozilla|chrome|safari/i);
  });

  it('returns status, headers, text and the raw location', async () => {
    const { session } = open(() => redirectResponse('/elsewhere?x=1', { status: 303, headers: { 'x-extra': 'yes' } }));
    const response = await get(session);
    expect(response.status).toBe(303);
    expect(response.location).toBe('/elsewhere?x=1');
    expect(response.headers.get('x-extra')).toBe('yes');
    expect(response.text).toBe('');
  });

  it('returns null as location when there is none and decodes UTF-8 text', async () => {
    const { session } = open(() => htmlResponse('Anfitrión €'));
    const response = await get(session);
    expect(response.location).toBeNull();
    expect(response.text).toBe('Anfitrión €');
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('€19');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        controller.enqueue(bytes.slice(1, 2));
        controller.enqueue(bytes.slice(2));
        controller.close();
      },
    });
    const { session } = open(() => new Response(stream, { status: 200 }));
    expect((await get(session)).text).toBe('€19');
  });

  it('handles an empty body', async () => {
    const { session } = open(() => emptyResponse(204));
    const response = await get(session);
    expect(response).toMatchObject({ status: 204, text: '' });
  });

  it('refuses to send anything outside the configured origin (no cookie or credential can leak)', async () => {
    const { session, calls } = open(() => htmlResponse('ok'));
    const error = await failureOf(session.request({ method: 'GET', url: 'https://evil.example.test/steal', label: 'test' }));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TransportError);
    await expect(get(session, '/ok')).resolves.toBeDefined();
    await expect(session.request({ method: 'GET', url: 'http://club.example.test/page', label: 'test' })).rejects.toThrow();
    await expect(session.request({ method: 'GET', url: 'https://club.example.test:8443/page', label: 'test' })).rejects.toThrow();
    expect(calls.map((call) => call.url)).toEqual([`${BASE_URL}/ok`]);
  });

  it('reports an unparsable URL as a plain error, before anything is sent', async () => {
    const { session, calls } = open(() => htmlResponse('ok'));
    const error = await failureOf(session.request({ method: 'GET', url: 'nonsense', label: 'test' }));
    expect(error).not.toBeInstanceOf(TransportError);
    expect(calls).toHaveLength(0);
  });
});

describe('cookie jar', () => {
  const cookieOf = (call: { headers: Readonly<Record<string, string>> } | undefined): string | undefined => call?.headers['cookie'];

  it('sends nothing before any cookie was set', async () => {
    const { session, calls } = open(() => htmlResponse('ok'));
    await get(session);
    expect(cookieOf(calls[0])).toBeUndefined();
  });

  it('stores every Set-Cookie of a response and sends them all back', async () => {
    let first = true;
    const { session, calls } = open(() => {
      const response = htmlResponse('ok', { cookies: first ? ['a=1; Path=/', 'b=2; Path=/; HttpOnly'] : [] });
      first = false;
      return response;
    });
    await get(session);
    await get(session);
    expect(cookieOf(calls[1])?.split('; ').sort()).toEqual(['a=1', 'b=2']);
  });

  it('stores cookies from redirect responses and from POST responses', async () => {
    const { session, calls } = open((call) =>
      call.method === 'POST'
        ? htmlResponse('ok', { cookies: ['from_post=p; Path=/'] })
        : redirectResponse('/elsewhere', { cookies: ['from_redirect=r; Path=/'] }),
    );
    await get(session);
    await session.request({ method: 'POST', url: `${BASE_URL}/post`, label: 'test', body: 'x=1' });
    await get(session);
    expect(cookieOf(calls[1])).toBe('from_redirect=r');
    expect(cookieOf(calls[2])?.split('; ').sort()).toEqual(['from_post=p', 'from_redirect=r']);
  });

  it('stores cookies even from the response that makes the request fail with AuthExpiredError', async () => {
    let step = 0;
    const { session, calls } = open(() => {
      step += 1;
      return step === 1 ? redirectResponse('/login', { cookies: ['guest=g; Path=/'] }) : htmlResponse('ok');
    });
    await expect(get(session)).rejects.toBeInstanceOf(AuthExpiredError);
    await get(session);
    expect(cookieOf(calls[1])).toBe('guest=g');
  });

  it('replaces a cookie that is set again and drops one that is expired by the server', async () => {
    const plan = [['a=1; Path=/'], ['a=2; Path=/'], ['a=; Path=/; Max-Age=0'], ['b=1; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'], []];
    let step = 0;
    const { session, calls } = open(() => htmlResponse('ok', { cookies: plan[step++] ?? [] }));
    for (let index = 0; index < plan.length; index += 1) await get(session);
    expect(calls.map((call) => cookieOf(call))).toEqual([undefined, 'a=1', 'a=2', undefined, undefined]);
  });

  it('scopes cookies by path', async () => {
    const { session, calls } = open((call) => (call.url.endsWith('/set') ? htmlResponse('ok', { cookies: ['api=1; Path=/api', 'all=1; Path=/'] }) : htmlResponse('ok')));
    await get(session, '/set');
    await get(session, '/api/calendar');
    await get(session, '/other');
    expect(cookieOf(calls[1])?.split('; ').sort()).toEqual(['all=1', 'api=1']);
    expect(cookieOf(calls[2])).toBe('all=1');
  });

  it('honours Secure: sent over https, but never stored from or sent over plain http', async () => {
    const secure = open((call) => (call.url.endsWith('/set') ? htmlResponse('ok', { cookies: ['s=1; Path=/; Secure', 'p=1; Path=/'] }) : htmlResponse('ok')));
    await get(secure.session, '/set');
    await get(secure.session);
    expect(cookieOf(secure.calls[1])?.split('; ').sort()).toEqual(['p=1', 's=1']);

    const fake = createFakeFetch((call) =>
      call.url.endsWith('/set') ? htmlResponse('ok', { cookies: ['s=1; Path=/; Secure', 'p=1; Path=/'] }) : htmlResponse('ok'),
    );
    const local = createHttpSession({ baseUrl: 'http://localhost:3000', logger: captureLogger(), fetchImpl: fake.fetchImpl });
    await local.request({ method: 'GET', url: 'http://localhost:3000/set', label: 'test' });
    await local.request({ method: 'GET', url: 'http://localhost:3000/page', label: 'test' });
    expect(cookieOf(fake.calls[1])).toBe('p=1');
  });

  it('ignores cookies for another domain and malformed Set-Cookie headers without failing', async () => {
    const { session, calls } = open((call) =>
      call.url.endsWith('/set')
        ? htmlResponse('ok', { cookies: ['evil=1; Domain=evil.example.org; Path=/', '=;;;', 'novalue', 'ok=1; Path=/'] })
        : htmlResponse('ok'),
    );
    await get(session, '/set');
    await get(session);
    expect(cookieOf(calls[1])).toBe('ok=1');
  });

  it('forgets everything on clearCookies', async () => {
    const { session, calls } = open((call) => (call.url.endsWith('/set') ? htmlResponse('ok', { cookies: ['a=1; Path=/'] }) : htmlResponse('ok')));
    await get(session, '/set');
    await session.clearCookies();
    await get(session);
    expect(cookieOf(calls[1])).toBeUndefined();
  });

  it('keeps separate sessions separate', async () => {
    const one = open((call) => (call.url.endsWith('/set') ? htmlResponse('ok', { cookies: ['a=1; Path=/'] }) : htmlResponse('ok')));
    const two = open(() => htmlResponse('ok'));
    await get(one.session, '/set');
    await get(two.session);
    expect(cookieOf(two.calls[0])).toBeUndefined();
  });
});

describe('session expiry', () => {
  it.each([
    ['a relative redirect to /login', () => redirectResponse('/login')],
    ['an absolute redirect to /login with a query', () => redirectResponse(`${BASE_URL}/login?next=%2Fx`)],
    ['a permanent redirect to /login', () => redirectResponse('/login', { status: 301 })],
    ['HTTP 401', () => emptyResponse(401)],
    ['HTTP 419', () => emptyResponse(419)],
  ])('throws AuthExpiredError on %s', async (_name, respond) => {
    const { session } = open(respond);
    await expect(get(session)).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it.each([
    ['a redirect elsewhere', () => redirectResponse('/home')],
    ['HTTP 403', () => emptyResponse(403)],
    ['HTTP 404', () => emptyResponse(404)],
    ['HTTP 500', () => htmlResponse('boom', { status: 500 })],
    ['HTTP 502', () => emptyResponse(502)],
  ])('hands %s back to the caller', async (_name, respond) => {
    const { session } = open(respond);
    await expect(get(session)).resolves.toBeDefined();
  });

  it.each([
    ['a redirect to /login', () => redirectResponse('/login')],
    ['HTTP 401', () => emptyResponse(401)],
    ['HTTP 419', () => emptyResponse(419)],
  ])('returns %s instead of throwing when the caller asks for the raw response', async (_name, respond) => {
    const { session } = open(respond);
    const response = await get(session, '/page', { onAuthRejected: 'return' });
    expect([301, 302, 401, 419]).toContain(response.status);
  });
});

