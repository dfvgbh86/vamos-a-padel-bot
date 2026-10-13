/** createApp: the database location, the real ReservaPlay client, and the parts that must keep working when others fail. */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { resolveDbLocation } from '../../src/runtime/dbPath.js';
import { AuthExpiredError, LoginFailedError } from '../../src/reservaplay/errors.js';
import { createFakeSite } from '../fixtures/reservaplay/fakeSite.js';
import { BASE_URL, PASSWORD as FIXTURE_PASSWORD, USERNAME as FIXTURE_USERNAME } from '../fixtures/reservaplay/constants.js';
import { createFakeTransport } from '../telegram/_harness.js';
import { GAME_DAY, MINUTE, OPENS_MS, START_MS, TEST_ENV, createRig, messagesWith, type Rig } from './_rig.js';
import { FakeSite } from './_site.js';
import { createVirtualClock } from './_virtualClock.js';
import { useCleanups } from './_wire.js';

const { add, tempDir } = useCleanups();

describe('the database location', () => {
  it('creates the folder of DB_PATH, nested folders included', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'nested', 'deeper', 'bot.sqlite');
    const clock = createVirtualClock(START_MS);
    const app = createApp({ ...TEST_ENV, dbPath }, { clock, api: new FakeSite(clock), telegramTransformer: createFakeTransport().transformer });
    expect(existsSync(dirname(dbPath))).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    await app.stop();
  });

  it('keeps the jobs in that file across restarts', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'bot.sqlite');
    const first = createRig({ env: { dbPath } });
    await first.start();
    await first.owner.createJob('вт 20.10', [{ court: 'Pista 7', time: '18:00' }]);
    await first.stop();

    const second = createRig({ env: { dbPath } });
    await second.start();
    expect(second.app.service.listJobs()).toHaveLength(1);
    expect(second.app.service.listJobs()[0]).toMatchObject({ gameDate: GAME_DAY, state: 'scheduled' });
    await second.stop();
  });

  it('resolves a relative path against the working directory and leaves :memory: alone', () => {
    expect(resolveDbLocation('data/bot.sqlite')).toBe(resolve('data/bot.sqlite'));
    expect(isAbsolute(resolveDbLocation('data/bot.sqlite'))).toBe(true);
    expect(resolveDbLocation(':memory:')).toBe(':memory:');
    const absolute = resolve(tmpdir(), 'x.sqlite');
    expect(resolveDbLocation(absolute)).toBe(absolute);
  });
});

describe('the real ReservaPlay client is wired from the environment', () => {
  it('logs in with the configured account on the configured address when the owner asks for the wallet', async () => {
    const site = createFakeSite();
    const clock = createVirtualClock(START_MS);
    const app = createApp(
      { ...TEST_ENV, baseUrl: BASE_URL, username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD },
      { clock, fetchImpl: site.fetchImpl, telegramTransformer: createFakeTransport().transformer },
    );
    add(() => app.stop());

    await expect(app.service.wallet()).resolves.toEqual({ balanceCents: 1902 });
    const logins = site.callsTo('/login').filter((call) => call.method === 'POST');
    expect(logins).toHaveLength(1);
    const params = new URLSearchParams(logins[0]?.body ?? '');
    expect(params.get('username')).toBe(FIXTURE_USERNAME);
    expect(params.get('password')).toBe(FIXTURE_PASSWORD);
    expect(site.calls.every((call) => call.url.startsWith(BASE_URL))).toBe(true);
  });

  it('a wrong password surfaces as a failed login, not as a hang', async () => {
    const site = createFakeSite();
    site.state.acceptCredentials = false;
    const clock = createVirtualClock(START_MS);
    const app = createApp(
      { ...TEST_ENV, baseUrl: BASE_URL, username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD },
      { clock, fetchImpl: site.fetchImpl, telegramTransformer: createFakeTransport().transformer },
    );
    add(() => app.stop());
    await expect(app.service.wallet()).rejects.toBeInstanceOf(LoginFailedError);
  });
});

describe('Telegram dying while the bot runs', () => {
  it('is reported, the job still books at 07:00 and the result still reaches the owner', async () => {
    const onTelegramFatal = vi.fn();
    const rig: Rig = createRig({ latency: { probeForm: 300, book: 1900 }, overrides: { onTelegramFatal } });
    rig.transport.failNext('getUpdates', { code: 409, description: 'Conflict: terminated by other getUpdates request' });
    await rig.start();
    await vi.waitFor(() => expect(onTelegramFatal).toHaveBeenCalledTimes(1));
    expect(rig.logText()).toContain('telegram polling stopped');
    expect(rig.logText()).toContain('booking jobs and result notifications continue');

    await rig.owner.createJob('вт 20.10', [{ court: 'Pista 7', time: '18:00' }]);
    await rig.runPastOpening();
    expect(rig.site.addEvents).toHaveLength(1);
    expect(messagesWith(rig, 'ЗАБРОНИРОВАНО')).toHaveLength(1);
    await rig.stop();
  });
});

describe('the owner may use the bot while the sniper is not busy, and only then', () => {
  it('does not log in for the owner within 15 minutes of an opening: the sniper owns the session then', async () => {
    const rig = createRig({ startMs: OPENS_MS - 12 * MINUTE, loggedIn: false });
    await rig.start();
    // the job is created through the store: the session is dead and the owner request must not log in
    rig.app.store.create({ gameDate: GAME_DAY, choices: [{ courtId: 9, startMinutes: 1080 }], durationMinutes: 90, payment: 'wallet' }, OPENS_MS, rig.clock.nowMs());
    rig.site.loggedIn = false;
    const before = rig.site.loginCount;
    await expect(rig.app.service.wallet()).rejects.toBeInstanceOf(AuthExpiredError);
    expect(rig.site.loginCount).toBe(before);
    await rig.stop();
  });
});
