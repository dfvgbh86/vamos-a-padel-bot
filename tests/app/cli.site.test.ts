import { describe, expect, it } from 'vitest';
import { USAGE } from '../../src/cli/run.js';
import type { ReservaplayApi } from '../../src/contracts.js';
import { AuthExpiredError, LoginFailedError, UnexpectedResponseError } from '../../src/reservaplay/errors.js';
import { TransportError } from '../../src/reservaplay/http.js';
import { createCliRig, SITE_ENV } from './_cli.js';
import { PASSWORD } from './_rig.js';
import { SITE_HASH } from './_site.js';

const rowsOf = (out: string): string[][] =>
  out
    .split('\n')
    .filter((line) => /^\d+\s{2}/.test(line))
    .map((line) => line.split(/\s{2,}/));

describe('usage', () => {
  it('without a command prints the usage on stderr and exits with 2', async () => {
    const rig = createCliRig();
    const result = await rig.run([]);
    expect(result).toMatchObject({ code: 2, out: '' });
    expect(result.err).toBe(USAGE);
    expect(rig.site.calls).toEqual([]);
  });

  it.each(['help', '--help', '-h'])('%s prints the usage on stdout and exits with 0', async (word) => {
    const result = await createCliRig().run([word]);
    expect(result).toEqual({ code: 0, out: USAGE, err: '' });
  });

  it('names every command in the usage', () => {
    for (const command of ['login-check', 'slots <YYYY-MM-DD>', 'wallet', 'status', 'whoami-telegram']) expect(USAGE).toContain(command);
  });

  it('an unknown command is a usage error that echoes at most a short prefix of it', async () => {
    const rig = createCliRig();
    const result = await rig.run(['book-everything-now'.padEnd(200, 'x')]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('Unknown command: book-everything-now');
    expect(result.err.length).toBeLessThan(USAGE.length + 100);
    expect(rig.site.calls).toEqual([]);
  });

  it.each(['login-check', 'wallet', 'status', 'whoami-telegram'])('%s takes no arguments', async (command) => {
    const rig = createCliRig();
    const result = await rig.run([command, 'extra']);
    expect(result).toMatchObject({ code: 2, out: '' });
    expect(result.err).toContain(`${command} takes no arguments`);
    expect(rig.site.calls).toEqual([]);
  });
});

describe('login-check', () => {
  it('prints OK and nothing else when the login works', async () => {
    const rig = createCliRig();
    const result = await rig.run(['login-check']);
    expect(result).toEqual({ code: 0, out: 'OK\n', err: '' });
    expect(rig.site.loginCount).toBe(1);
    expect(rig.site.calls.map((call) => call.name)).toEqual(['login']);
  });

  it('prints FAIL on stdout and the reason on stderr when the site refuses the login', async () => {
    const rig = createCliRig();
    rig.site.loginFails = true;
    const result = await rig.run(['login-check']);
    expect(result.code).toBe(1);
    expect(result.out).toBe('FAIL\n');
    expect(result.err).toContain('did not accept the login');
    expect(result.err).toContain('RESERVAPLAY_PASSWORD');
    expect(result.err).not.toContain(PASSWORD);
  });

  it('prints FAIL and names the missing keys when the account is not configured', async () => {
    const result = await createCliRig({}).run(['login-check']);
    expect(result.code).toBe(1);
    expect(result.out).toBe('FAIL\n');
    expect(result.err).toContain('missing: RESERVAPLAY_USERNAME, RESERVAPLAY_PASSWORD');
  });

  it('needs no Telegram settings', async () => {
    const result = await createCliRig({ ...SITE_ENV }).run(['login-check']);
    expect(result.out).toBe('OK\n');
  });

  it.each([
    ['a network failure', new TransportError('login_page', 'network', false, 'ENOTFOUND'), 'could not be reached'],
    ['a timeout', new TransportError('login_submit', 'timeout', true, null), 'could not be reached'],
    ['an unexpected page', new UnexpectedResponseError('No CSRF token found on the login page'), 'does not understand'],
    ['a rejected session', new AuthExpiredError(), 'rejected the session'],
  ])('says what went wrong after %s, by the kind of error only', async (_label, error, hint) => {
    const rig = createCliRig();
    const result = await rig.run(['login-check'], {
      createApi: () => ({ login: async () => Promise.reject(error) }) as unknown as ReservaplayApi,
    });
    expect(result).toMatchObject({ code: 1, out: 'FAIL\n' });
    expect(result.err).toContain(hint);
  });

  it('never prints the message of an unexpected error: it may carry account data', async () => {
    const rig = createCliRig();
    const result = await rig.run(['login-check'], {
      createApi: () => ({ login: async () => Promise.reject(new Error(`boom ${PASSWORD} ${SITE_HASH}`)) }) as unknown as ReservaplayApi,
    });
    expect(result.out).toBe('FAIL\n');
    expect(result.err).toBe('Unexpected error (Error).\n');
    expect(result.out + result.err).not.toContain(PASSWORD);
    expect(result.out + result.err).not.toContain(SITE_HASH);
  });
});

describe('wallet', () => {
  it('prints the balance in euros', async () => {
    const rig = createCliRig();
    rig.site.walletCents = 1902;
    expect(await rig.run(['wallet'])).toEqual({ code: 0, out: 'Wallet: 19.02 EUR\n', err: '' });
  });

  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [100, '1.00'],
    [123456, '1234.56'],
  ])('formats %i cents as %s', async (cents, text) => {
    const rig = createCliRig();
    rig.site.walletCents = cents;
    expect((await rig.run(['wallet'])).out).toBe(`Wallet: ${text} EUR\n`);
  });

  it('fails with the reason on stderr and nothing on stdout when the login fails', async () => {
    const rig = createCliRig();
    rig.site.loginFails = true;
    const result = await rig.run(['wallet']);
    expect(result).toMatchObject({ code: 1, out: '' });
    expect(result.err).toContain('did not accept the login');
    expect(rig.site.count('getWallet')).toBe(0);
  });

  it('fails when the account is not configured', async () => {
    const result = await createCliRig({ RESERVAPLAY_USERNAME: 'test-player' }).run(['wallet']);
    expect(result).toMatchObject({ code: 1, out: '' });
    expect(result.err).toContain('missing: RESERVAPLAY_PASSWORD');
  });
});

describe('slots', () => {
  it('lists the free slots of the allowed courts on a weekday, never an academy court', async () => {
    const rig = createCliRig();
    const result = await rig.run(['slots', '2026-10-20']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain('2026-10-20 (Tue): courts the bot may book: 4, 9, 10, 11, 12');
    const rows = rowsOf(result.out);
    expect(rows.map((row) => row[0])).toEqual(['4', '4', '9', '9', '10', '10', '11', '11', '12', '12']);
    for (const academy of ['1', '2', '3', '7', '8']) expect(rows.map((row) => row[0])).not.toContain(academy);
    expect(rows[0]).toEqual(['4', 'Pista 4 semicubierta', '18:00', '19:30', '90']);
    expect(rows[3]).toEqual(['9', 'Pista 7 semicubierta', '19:30', '21:00', '90']);
    expect(result.out).toContain('court id  court');
  });

  it('leaves out slots that are taken and the slot of the own booking', async () => {
    const rig = createCliRig();
    rig.site.takenByOthers.push({ courtId: 10, startMinutes: 1080 });
    rig.site.bookings.push({ gameDate: '2026-10-20' as never, courtId: 9, startMinutes: 1170, durationMinutes: 90, reservationId: 100_002 });
    const rows = rowsOf((await rig.run(['slots', '2026-10-20'])).out).map((row) => `${row[0]}@${row[2]}`);
    expect(rows).not.toContain('10@18:00');
    expect(rows).not.toContain('9@19:30');
    expect(rows).toContain('10@19:30');
    expect(rows).toContain('9@18:00');
    expect(rows).toHaveLength(8);
  });

  it('offers every court on a Saturday', async () => {
    const rig = createCliRig();
    const result = await rig.run(['slots', '2026-10-24']);
    expect(result.out).toContain('(Sat): courts the bot may book: 1, 2, 3, 4, 7, 8, 9, 10, 11, 12');
    expect(new Set(rowsOf(result.out).map((row) => row[0]))).toEqual(new Set(['1', '2', '3', '4', '7', '8', '9', '10', '11', '12']));
  });

  it('offers every court on an official holiday that falls on a weekday', async () => {
    const result = await createCliRig().run(['slots', '2026-12-08']);
    expect(result.out).toContain('(Tue): courts the bot may book: 1, 2, 3, 4, 7, 8, 9, 10, 11, 12');
    expect(rowsOf(result.out)).toHaveLength(20);
  });

  it('honours EXTRA_HOLIDAYS from the environment', async () => {
    const rig = createCliRig({ ...SITE_ENV, EXTRA_HOLIDAYS: '2026-10-20' });
    expect((await rig.run(['slots', '2026-10-20'])).out).toContain('courts the bot may book: 1, 2, 3, 4, 7, 8, 9, 10, 11, 12');
  });

  it('says so when nothing is free', async () => {
    const rig = createCliRig();
    for (const courtId of [4, 9, 10, 11, 12]) for (const startMinutes of [1080, 1170]) rig.site.takenByOthers.push({ courtId, startMinutes });
    const result = await rig.run(['slots', '2026-10-20']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('No free slots on those courts.');
    expect(rowsOf(result.out)).toEqual([]);
  });

  it('says whether the booking window is open', async () => {
    const rig = createCliRig();
    expect((await rig.run(['slots', '2026-10-20'])).out).toContain('Booking window: opens 2026-10-13 07:00 Madrid (not open yet)');
    expect((await rig.run(['slots', '2026-10-19'])).out).toContain('Booking window: open since 2026-10-12 07:00 Madrid');
  });

  it.each([
    ['no date', []],
    ['two dates', ['2026-10-20', '2026-10-21']],
    ['a day that does not exist', ['2026-02-30']],
    ['another format', ['20-10-2026']],
    ['text', ['tomorrow']],
    ['a date with a time', ['2026-10-20T07:00']],
  ])('refuses %s as a usage error before it touches the site', async (_label, args) => {
    const rig = createCliRig();
    const result = await rig.run(['slots', ...args]);
    expect(result).toMatchObject({ code: 2, out: '' });
    expect(result.err).toContain('Usage: slots <YYYY-MM-DD>');
    expect(rig.site.calls).toEqual([]);
  });

  it('logs in once and reads the calendar once', async () => {
    const rig = createCliRig();
    await rig.run(['slots', '2026-10-20']);
    expect(rig.site.calls.map((call) => call.name)).toEqual(['login', 'getDay']);
  });

  it('fails with the reason when the session is rejected', async () => {
    const rig = createCliRig();
    rig.site.loginFails = true;
    const result = await rig.run(['slots', '2026-10-20']);
    expect(result).toMatchObject({ code: 1, out: '' });
    expect(result.err).toContain('did not accept the login');
  });

  it('prints site text safely: control characters removed, long names cut', async () => {
    const rig = createCliRig();
    const api = {
      login: async () => undefined,
      getDay: async (gameDate: string) => ({
        gameDate,
        courts: [{ courtId: 9, name: `Pista\u0007 7\u001b[31m ${'x'.repeat(80)}`, slots: [{ startMinutes: 1080, endMinutes: 1170, durationMinutes: 90, free: true, ownBooking: false }] }],
      }),
    } as unknown as ReservaplayApi;
    const result = await rig.run(['slots', '2026-10-20'], { createApi: () => api });
    expect(result.out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    const row = rowsOf(result.out)[0];
    expect(row?.[1]?.length).toBeLessThanOrEqual(40);
  });

  it('never prints the password, the hash or a cookie', async () => {
    const rig = createCliRig();
    const result = await rig.run(['slots', '2026-10-20']);
    const everything = result.out + result.err;
    for (const secret of [PASSWORD, SITE_HASH]) expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/laravel_session|XSRF|cookie|Bearer/i);
  });
});

describe('the site client the CLI builds', () => {
  it('gets the account from the environment, and no Telegram settings', async () => {
    const rig = createCliRig({ ...SITE_ENV, RESERVAPLAY_BASE_URL: 'https://club.example.test' });
    await rig.run(['login-check']);
    expect(rig.createdFor).toHaveLength(1);
    expect(rig.createdFor[0]).toMatchObject({ baseUrl: 'https://club.example.test', username: SITE_ENV.RESERVAPLAY_USERNAME });
  });

  it('a configuration error is reported by its key names only', async () => {
    const rig = createCliRig({ ...SITE_ENV, RESERVAPLAY_BASE_URL: 'http://sentinel-host-0001.example.test' });
    const result = await rig.run(['wallet']);
    expect(result.err).toContain('invalid: RESERVAPLAY_BASE_URL');
    expect(result.err).not.toContain('sentinel-host-0001');
    expect(rig.createdFor).toEqual([]);
  });

  it('a wrong-looking login result is a LoginFailedError for the owner, not a crash', async () => {
    const rig = createCliRig();
    const result = await rig.run(['login-check'], { createApi: () => ({ login: async () => Promise.reject(new LoginFailedError()) }) as unknown as ReservaplayApi });
    expect(result).toMatchObject({ code: 1, out: 'FAIL\n' });
  });
});
