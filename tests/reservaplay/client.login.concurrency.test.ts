import { describe, expect, it } from 'vitest';
import { LoginFailedError } from '../../src/reservaplay/errors.js';
import { createFakeSite, type FakeSite } from '../fixtures/reservaplay/fakeSite.js';
import { failureOf, makeClient } from './helpers.js';

const isLoginPost = (input: string | URL | Request, init?: RequestInit): boolean => init?.method === 'POST' && String(input).endsWith('/login');

/** A site whose login POST is held back until `release()`: the window in which a second login could start. */
const slowLogin = (site: FakeSite) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { held: 0 };
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (!isLoginPost(input, init)) return site.fetchImpl(input, init);
    state.held += 1;
    return gate.then(() => site.fetchImpl(input, init));
  }) as typeof fetch;
  return { fetchImpl, release: () => release(), state };
};

const sequence = (site: FakeSite): string[] => site.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);

const LOGIN_ONCE = ['GET /login', 'POST /login', 'GET /reserves/cal_week.php'];

describe('login() is single flight', () => {
  it('shares one attempt between callers that start in the same tick', async () => {
    const site = createFakeSite();
    const client = makeClient(site);
    await Promise.all([client.login(), client.login(), client.login()]);
    expect(sequence(site)).toEqual(LOGIN_ONCE);
    await expect(client.keepAlive()).resolves.toBeUndefined();
  });

  it('shares the running attempt with a caller that arrives while the login POST is in flight', async () => {
    const site = createFakeSite();
    const slow = slowLogin(site);
    const client = makeClient(site, { fetchImpl: slow.fetchImpl });

    const first = client.login();
    await expectEventually(() => slow.state.held === 1);
    const second = client.login();
    slow.release();
    await Promise.all([first, second]);

    expect(sequence(site)).toEqual(LOGIN_ONCE);
    expect(slow.state.held).toBe(1);
    await expect(client.keepAlive()).resolves.toBeUndefined();
  });

  it('would corrupt the cookie jar without it: both logins succeed and the session is usable', async () => {
    const site = createFakeSite();
    const slow = slowLogin(site);
    const client = makeClient(site, { fetchImpl: slow.fetchImpl });
    const both = Promise.all([client.login(), client.login()]);
    await expectEventually(() => slow.state.held >= 1);
    slow.release();
    await expect(both).resolves.toEqual([undefined, undefined]);
    await expect(client.getWallet()).resolves.toEqual({ balanceCents: 1902 });
  });

  it('gives every waiting caller the same failure, after a single attempt', async () => {
    const site = createFakeSite();
    site.state.acceptCredentials = false;
    const client = makeClient(site);
    const errors = await Promise.all([failureOf(client.login()), failureOf(client.login())]);
    for (const error of errors) expect(error).toBeInstanceOf(LoginFailedError);
    expect(site.callsTo('/login').filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('starts a fresh attempt once the previous one has finished, whether it succeeded or failed', async () => {
    const site = createFakeSite();
    const client = makeClient(site);
    await client.login();
    await client.login();
    expect(sequence(site)).toEqual([...LOGIN_ONCE, ...LOGIN_ONCE]);

    site.state.acceptCredentials = false;
    await expect(client.login()).rejects.toBeInstanceOf(LoginFailedError);
    site.state.acceptCredentials = true;
    site.calls.length = 0;
    await client.login();
    expect(sequence(site)).toEqual(LOGIN_ONCE);
  });

  it('does not leave an unhandled rejection behind when a failed login has a single caller', async () => {
    const site = createFakeSite();
    site.state.acceptCredentials = false;
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      await failureOf(makeClient(site).login());
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', record);
    }
    expect(unhandled).toEqual([]);
  });
});

const expectEventually = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(condition()).toBe(true);
};
