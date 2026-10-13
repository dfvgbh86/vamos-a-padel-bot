import { describe, expect, it } from 'vitest';
import { createReservaplayClient } from '../../src/reservaplay/client.js';
import { AuthExpiredError, LoginFailedError, UnexpectedResponseError } from '../../src/reservaplay/errors.js';
import { TransportError, USER_AGENT } from '../../src/reservaplay/http.js';
import { BASE_URL, CSRF_TOKEN, PASSWORD, USERNAME } from '../fixtures/reservaplay/constants.js';
import { bodyParams, networkError } from '../fixtures/reservaplay/fakeFetch.js';
import { AUTHED_SESSION, GUEST_SESSION, createFakeSite } from '../fixtures/reservaplay/fakeSite.js';
import { dailyLimitHtml, loginPageHtml } from '../fixtures/reservaplay/pages.js';
import { emptyResponse, htmlResponse, redirectResponse } from '../fixtures/reservaplay/responses.js';
import { captureLogger, clubNow, makeClient, silentLogger } from './helpers.js';

const failureOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
};

describe('createReservaplayClient: configuration', () => {
  const base = { baseUrl: BASE_URL, username: USERNAME, password: PASSWORD, logger: silentLogger, now: () => clubNow() };

  it('refuses a missing username or password', () => {
    expect(() => createReservaplayClient({ ...base, username: '' })).toThrow(/username/);
    expect(() => createReservaplayClient({ ...base, password: '' })).toThrow(/password/);
    expect(() => createReservaplayClient({ ...base, password: undefined as unknown as string })).toThrow(/password/);
  });

  it('refuses a base URL that would send the password in clear text', () => {
    expect(() => createReservaplayClient({ ...base, baseUrl: 'http://club.example.test' })).toThrow(/https/);
  });

  it('does not put the credentials in the configuration error', () => {
    try {
      createReservaplayClient({ ...base, baseUrl: 'http://club.example.test', password: PASSWORD });
    } catch (error) {
      expect((error as Error).message).not.toContain(PASSWORD);
    }
  });
});

describe('login()', () => {
  it('fetches the login page, posts the form with the CSRF token and confirms with an authenticated request', async () => {
    const site = createFakeSite();
    await makeClient(site).login();

    expect(site.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /login',
      'POST /login',
      'GET /reserves/cal_week.php',
    ]);

    const [page, submit, confirm] = site.calls;
    expect(page?.url).toBe(`${BASE_URL}/login`);
    expect(page?.headers['cookie']).toBeUndefined();

    expect(submit?.url).toBe(`${BASE_URL}/login`);
    expect(submit?.body).toBe(`_token=${CSRF_TOKEN}&username=${USERNAME}&password=${PASSWORD}`);
    expect(submit?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(submit?.headers['x-requested-with']).toBe('XMLHttpRequest');
    expect(submit?.headers['user-agent']).toBe(USER_AGENT);
    expect(submit?.redirect).toBe('manual');
    expect(submit?.headers['cookie']).toContain(`laravel_session=${GUEST_SESSION}`);

    expect(confirm?.headers['cookie']).toContain(`laravel_session=${AUTHED_SESSION}`);
  });

  it('encodes credentials that contain reserved characters', async () => {
    const site = createFakeSite();
    const client = makeClient(site, { password: 'p&ss=w+rd %1' });
    await failureOf(client.login());
    expect(bodyParams(site.callsTo('/login')[1]!).get('password')).toBe('p&ss=w+rd %1');
  });

  it('reads the token from a meta tag too', async () => {
    const site = createFakeSite();
    site.state.loginPage = () => loginPageHtml({ metaOnly: true });
    await expect(makeClient(site).login()).resolves.toBeUndefined();
  });

  it('starts every login from an empty cookie jar', async () => {
    const site = createFakeSite();
    const client = makeClient(site);
    await client.login();
    await client.login();
    const loginPages = site.calls.filter((call) => call.method === 'GET' && call.url.endsWith('/login'));
    expect(loginPages).toHaveLength(2);
    expect(loginPages[1]?.headers['cookie']).toBeUndefined();
  });

  it('can log in again after the session expired', async () => {
    const site = createFakeSite();
    const client = makeClient(site);
    await client.login();
    site.expireSession();
    await expect(client.keepAlive()).rejects.toBeInstanceOf(AuthExpiredError);
    await client.login();
    await expect(client.keepAlive()).resolves.toBeUndefined();
  });

  describe('rejected credentials', () => {
    it('throws LoginFailedError when the site bounces back to the login page', async () => {
      const site = createFakeSite();
      site.state.acceptCredentials = false;
      const error = await failureOf(makeClient(site).login());
      expect(error).toBeInstanceOf(LoginFailedError);
      expect((error as Error).message).toBe('Login was not accepted (HTTP 302)');
    });

    it('throws LoginFailedError when the post "succeeds" but the confirmation still shows the login page', async () => {
      const site = createFakeSite();
      const original = site.fetchImpl;
      let confirmations = 0;
      const client = makeClient({
        fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
          if (String(input).endsWith('/reserves/cal_week.php')) {
            confirmations += 1;
            return Promise.resolve(htmlResponse(loginPageHtml()));
          }
          return original(input, init);
        }) as typeof fetch,
      });
      await expect(client.login()).rejects.toBeInstanceOf(LoginFailedError);
      expect(confirmations).toBe(1);
    });

    it('throws LoginFailedError when the confirmation answers with another status', async () => {
      const site = createFakeSite();
      const original = site.fetchImpl;
      const client = makeClient({
        fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
          String(input).endsWith('/reserves/cal_week.php') ? Promise.resolve(emptyResponse(403)) : original(input, init)) as typeof fetch,
      });
      await expect(client.login()).rejects.toBeInstanceOf(LoginFailedError);
    });

    it.each([429, 500, 503])('stops at HTTP %i without confirming and without retrying', async (status) => {
      const site = createFakeSite();
      const original = site.fetchImpl;
      const client = makeClient({
        fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
          init?.method === 'POST' ? Promise.resolve(htmlResponse('Too many attempts, try later', { status })) : original(input, init)) as typeof fetch,
      });
      const error = await failureOf(client.login());
      expect(error).toBeInstanceOf(LoginFailedError);
      expect((error as Error).message).toBe(`Login request refused (HTTP ${status})`);
      expect(site.calls.map((call) => call.method)).toEqual(['GET']);
    });

    it('never puts the password, the token or any response text into the error or the logs', async () => {
      const site = createFakeSite();
      site.state.acceptCredentials = false;
      const logger = captureLogger();
      const error = (await failureOf(makeClient(site, { logger }).login())) as Error;
      for (const secret of [PASSWORD, CSRF_TOKEN, GUEST_SESSION]) {
        expect(error.message).not.toContain(secret);
        expect(error.stack ?? '').not.toContain(secret);
        expect(logger.dump()).not.toContain(secret);
      }
    });

    it('makes exactly one attempt: no automatic retry', async () => {
      const site = createFakeSite();
      site.state.acceptCredentials = false;
      await failureOf(makeClient(site).login());
      expect(site.callsTo('/login').filter((call) => call.method === 'POST')).toHaveLength(1);
    });
  });

  describe('unexpected login pages', () => {
    it('throws UnexpectedResponseError when there is no CSRF token, and posts nothing', async () => {
      const site = createFakeSite();
      site.state.loginPage = () => dailyLimitHtml();
      const error = await failureOf(makeClient(site).login());
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect(site.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    });

    it('throws UnexpectedResponseError when the login page is not a 200', async () => {
      const client = makeClient({ fetchImpl: (() => Promise.resolve(htmlResponse('Server error', { status: 500 }))) as unknown as typeof fetch });
      const error = await failureOf(client.login());
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect((error as UnexpectedResponseError).status).toBe(500);
    });

    it('does not treat a redirect away from the login page as success', async () => {
      const client = makeClient({ fetchImpl: (() => Promise.resolve(redirectResponse('/home'))) as unknown as typeof fetch });
      await expect(client.login()).rejects.toBeInstanceOf(UnexpectedResponseError);
    });

    it('does not mistake a redirect of the login page to itself for an expired session', async () => {
      const client = makeClient({ fetchImpl: (() => Promise.resolve(redirectResponse('/login'))) as unknown as typeof fetch });
      await expect(client.login()).rejects.toBeInstanceOf(UnexpectedResponseError);
    });
  });

  describe('network problems', () => {
    it('lets a transport error on the login page propagate as TransportError', async () => {
      const client = makeClient({
        fetchImpl: (() => {
          throw networkError('ENOTFOUND');
        }) as unknown as typeof fetch,
      });
      expect(await failureOf(client.login())).toMatchObject({ name: 'TransportError', mayHaveReachedServer: false });
    });

    it('lets a transport error on the confirmation propagate as TransportError, not as a rejected login', async () => {
      const site = createFakeSite();
      const original = site.fetchImpl;
      const client = makeClient({
        fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
          if (String(input).endsWith('/reserves/cal_week.php')) throw networkError('ECONNRESET');
          return original(input, init);
        }) as typeof fetch,
      });
      const error = await failureOf(client.login());
      expect(error).toBeInstanceOf(TransportError);
      expect(error).not.toBeInstanceOf(LoginFailedError);
    });
  });
});

describe('keepAlive()', () => {
  it('requests cal_week.php with the session cookie and succeeds on a 200', async () => {
    const site = createFakeSite();
    const client = makeClient(site);
    await client.login();
    site.calls.length = 0;

    await expect(client.keepAlive()).resolves.toBeUndefined();
    expect(site.calls).toHaveLength(1);
    expect(site.calls[0]).toMatchObject({ method: 'GET', url: `${BASE_URL}/reserves/cal_week.php`, redirect: 'manual' });
    expect(site.calls[0]?.headers['cookie']).toContain(`laravel_session=${AUTHED_SESSION}`);
    expect(site.calls[0]?.headers['user-agent']).toBe(USER_AGENT);
  });

  it('throws AuthExpiredError without a session (redirect to /login)', async () => {
    await expect(makeClient(createFakeSite()).keepAlive()).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('throws AuthExpiredError when the site expired the session', async () => {
    const site = createFakeSite();
    const client = makeClient(site);
    await client.login();
    site.expireSession();
    await expect(client.keepAlive()).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it.each([401, 419])('throws AuthExpiredError on HTTP %i', async (status) => {
    const client = makeClient({ fetchImpl: (() => Promise.resolve(emptyResponse(status))) as unknown as typeof fetch });
    await expect(client.keepAlive()).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('throws AuthExpiredError when a 200 page is really the login form', async () => {
    const client = makeClient({ fetchImpl: (() => Promise.resolve(htmlResponse(loginPageHtml()))) as unknown as typeof fetch });
    await expect(client.keepAlive()).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('throws UnexpectedResponseError (with the status, without the body) on other statuses', async () => {
    for (const response of [() => htmlResponse('Laravel debug page with secrets', { status: 500 }), () => redirectResponse('/elsewhere'), () => emptyResponse(404)]) {
      const client = makeClient({ fetchImpl: (() => Promise.resolve(response())) as unknown as typeof fetch });
      const error = await failureOf(client.keepAlive());
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect((error as Error).message).not.toContain('secrets');
      expect((error as UnexpectedResponseError).status).toBeGreaterThanOrEqual(300);
    }
  });

  it('propagates transport errors', async () => {
    const client = makeClient({
      fetchImpl: (() => {
        throw networkError('ECONNRESET');
      }) as unknown as typeof fetch,
    });
    await expect(client.keepAlive()).rejects.toBeInstanceOf(TransportError);
  });
});
