/**
 * BLACK-BOX SMOKE TEST. The built bot (`node --env-file=... dist/src/index.js`, a real child process) talks over real
 * loopback sockets to two fake servers started here: a ReservaPlay club site and a Telegram Bot API. The scenario is
 * the one the owner lives: /start, /new with buttons, confirm, and the booking of a date that is already open.
 *
 * Only synthetic credentials generated in this file's run are used; the owner's .env is never read, and the bot's
 * every outgoing connection is checked (netGuard.cjs) to go to one of the two fake servers.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowedCourtIds } from '../../src/config/courts.js';
import { parseGameDate } from '../../src/config/gameDate.js';
import { buildHolidaySet } from '../../src/config/holidays.js';
import {
  buildBot,
  isAlive,
  killAll,
  probeGuard,
  readNetLog,
  runToExit,
  startBot,
  type BotProcess,
} from './_bot.js';
import { createFakeClub, type ClubRequest, type FakeClub } from './_fakeClub.js';
import { createFakeTelegram, type FakeTelegram } from './_fakeTelegram.js';
import { createOwner, strangerUpdates, type Owner } from './_owner.js';
import { clubDate, createSynthetic, secretsOf } from './_synthetic.js';
import { sleep, waitFor } from './_wait.js';

const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const synthetic = createSynthetic();
const GAME_DATE = clubDate(3);
const START_1930 = 1170;
const IGNORED_SENDER = 'telegram: update from a non-allowed sender or chat ignored';
const COURTS_WISHED = [10, 11, 12] as const;

let dir = '';
let club: FakeClub;
let telegram: FakeTelegram;
let owner: Owner;
let bot: BotProcess | undefined;

const dbFile = (): string => join(dir, 'data', 'bot.sqlite').replaceAll('\\', '/');

const botEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  TELEGRAM_BOT_TOKEN: synthetic.botToken,
  TELEGRAM_ALLOWED_USER_IDS: String(synthetic.ownerId),
  RESERVAPLAY_BASE_URL: club.origin,
  RESERVAPLAY_USERNAME: synthetic.username,
  RESERVAPLAY_PASSWORD: synthetic.password,
  TELEGRAM_API_ROOT: telegram.origin,
  DB_PATH: dbFile(),
  LOG_LEVEL: 'debug',
  ...extra,
});

const portOf = (origin: string): string => new URL(origin).port;

const running = (): BotProcess => {
  if (bot === undefined) throw new Error('the bot is not running: an earlier step failed');
  return bot;
};

/** The add_event body the site's own form sends (see CONTRACT.md), written out independently of src/. */
const expectedBody = (courtId: number): string =>
  [
    `hash=${synthetic.hash}`,
    'id_reserva=',
    'libres=0',
    'libres_step=1',
    'nivel=0',
    'nivel_max=7',
    'sx=-',
    'lista_usuarios=0',
    `data=${GAME_DATE}+00%3A00%3A00`,
    `recurso=${courtId}`,
    'op=add_event',
    'desactivar_pago=0',
    'tipo_pago_anticipado_socio=5',
    'array_of_bonos=',
    'esReservaFija=0',
    'array_of_bonos=',
    'esReservaFija=0',
    'tipoabonos=0',
    'tipo_pago_anticipado_tpvonline=0',
    'duration=90',
    'time_ini=19%3A30',
    `socis=${synthetic.accountId}%2C3%2C3%2C3`,
  ].join('&');

interface JobRow {
  readonly state: string;
  readonly game_date: string;
  readonly reservation_id: number | null;
  readonly attempts: number;
  readonly booked_choice: string | null;
  readonly notified_state: string | null;
}

const readDatabase = (readOnly: boolean): { jobs: JobRow[]; integrity: string[] } => {
  const db = new sqlite.DatabaseSync(dbFile(), { readOnly });
  try {
    const jobs = db
      .prepare('SELECT state, game_date, reservation_id, attempts, booked_choice, notified_state FROM jobs ORDER BY id')
      .all()
      .map((row) => ({ ...row }) as unknown as JobRow);
    const integrity = db
      .prepare('PRAGMA integrity_check')
      .all()
      .map((row) => String(Object.values(row)[0]));
    return { jobs, integrity };
  } finally {
    db.close();
  }
};

const expectNoSecrets = (what: string, text: string): void => {
  for (const secret of [...secretsOf(synthetic), synthetic.username]) {
    expect(text.includes(secret), `${what} must not contain a secret (${secret.length} chars, starts ${secret.slice(0, 2)}...)`).toBe(false);
  }
};

const clubRequestsBefore = (request: ClubRequest): ClubRequest[] => club.requests.filter((other) => other.seq < request.seq);

const bookedMessages = (): string[] =>
  telegram
    .of('sendMessage')
    .map((call) => String(call.payload['text']))
    .filter((text) => text.includes('ЗАБРОНИРОВАНО'));

beforeAll(async () => {
  buildBot();
  dir = mkdtempSync(join(tmpdir(), 'padel-smoke-'));
  club = await createFakeClub(synthetic);
  telegram = await createFakeTelegram(synthetic.botToken);
  owner = createOwner(telegram, synthetic.ownerId);
}, 180_000);

afterAll(async () => {
  await killAll();
  await telegram?.close();
  await club?.close();
  if (dir !== '') rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}, 60_000);

describe('the connection guard that proves "no other network peer"', () => {
  it('records and refuses a connection to an address outside this machine (nothing is ever sent to it)', () => {
    const probe = probeGuard(dir, 'guard');
    expect(probe.stdout).toContain('203.0.113.9:81 was refused');
    expect(probe.log).toEqual(['BLOCKED 203.0.113.9:81']);
  }, 30_000);
});

describe('configuration errors end the process at once', () => {
  it('an empty environment: exit 1, the missing key names only, nothing on stdout, no connection', async () => {
    const result = await runToExit({ envFile: {}, noEnvFile: true, dir, tag: 'empty' });
    expect(result.exit).toEqual({ code: 1, signal: null });
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain(
      'Fatal: Configuration error (missing: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, RESERVAPLAY_USERNAME, RESERVAPLAY_PASSWORD).',
    );
    expect(readNetLog(dir, 'empty')).toEqual([]);
  }, 30_000);

  it('invalid values: exit 1, only the key names, never a value; no connection', async () => {
    const sentinel = `sentinel-${synthetic.csrfToken}`;
    const result = await runToExit({
      envFile: {
        TELEGRAM_BOT_TOKEN: synthetic.botToken,
        TELEGRAM_ALLOWED_USER_IDS: sentinel,
        RESERVAPLAY_BASE_URL: `http://${sentinel}.example.test`,
        RESERVAPLAY_USERNAME: synthetic.username,
        RESERVAPLAY_PASSWORD: synthetic.password,
        TELEGRAM_API_ROOT: `https://${sentinel}.example.test`,
      },
      dir,
      tag: 'invalid',
    });
    expect(result.exit).toEqual({ code: 1, signal: null });
    expect(result.stderr).toContain('invalid: TELEGRAM_ALLOWED_USER_IDS, RESERVAPLAY_BASE_URL, TELEGRAM_API_ROOT');
    expect(result.stderr).not.toContain('missing');
    expect(result.stdout).toBe('');
    for (const value of [sentinel, ...secretsOf(synthetic), synthetic.username]) expect(result.stderr).not.toContain(value);
    expect(readNetLog(dir, 'invalid')).toEqual([]);
  }, 30_000);

  it.each([
    ['the real Telegram', 'https://api.telegram.org'],
    ['plain http to the real Telegram', 'http://api.telegram.org'],
    ['a host that merely starts like localhost', 'http://localhost.example.test:8081'],
    ['another address of this machine', 'http://127.0.0.2:8081'],
  ])('TELEGRAM_API_ROOT pointing at %s is refused before anything is sent', async (_label, root) => {
    const callsBefore = telegram.calls.length;
    const tag = `root-${synthetic.hash.slice(0, 6)}-${root.length}`;
    const result = await runToExit({ envFile: botEnv({ TELEGRAM_API_ROOT: root }), dir, tag });
    expect(result.exit).toEqual({ code: 1, signal: null });
    expect(result.stderr).toContain('invalid: TELEGRAM_API_ROOT');
    expect(result.stderr).not.toContain(root);
    expect(result.stderr).not.toContain(synthetic.botTokenSecret);
    expect(result.stdout).toBe('');
    expect(readNetLog(dir, tag)).toEqual([]);
    expect(telegram.calls.length).toBe(callsBefore);
    expect(club.requests).toHaveLength(0);
  }, 30_000);
});

describe('the built bot against a fake club and a fake Telegram', () => {
  it('starts like `npm start`: long polling runs against the fake Bot API', async () => {
    bot = startBot({ envFile: botEnv(), dir, tag: 'run1' });
    await bot.waitForLog('running', 30_000);

    expect(telegram.of('getMe').length).toBeGreaterThanOrEqual(1);
    const menu = telegram.of('setMyCommands')[0]?.payload['commands'] as { command: string }[] | undefined;
    expect(menu?.map((entry) => entry.command)).toContain('new');
    await waitFor('the first long poll', () => (telegram.of('getUpdates').length > 0 ? true : undefined), 10_000);
    expect(telegram.of('getUpdates')[0]?.payload['allowed_updates']).toEqual(['message', 'callback_query']);
    expect(telegram.calls.every((call) => call.tokenOk)).toBe(true);
  }, 60_000);

  it('a stranger, a stranger pressing a button and the owner in a group chat get no reply at all', async () => {
    const quiet = (): number => telegram.calls.filter((call) => call.method !== 'getUpdates').length;
    const before = quiet();
    const marker = `stranger-text-${synthetic.csrfToken}`;
    telegram.pushUpdate(strangerUpdates.privateMessage(synthetic.strangerId, `/start ${marker}`));
    telegram.pushUpdate(strangerUpdates.buttonPress(synthetic.strangerId, 'n:y:abcdef', 'stranger-query-1'));
    telegram.pushUpdate(strangerUpdates.ownerInGroup(synthetic.ownerId, `/jobs ${marker}`));

    await waitFor(
      'the three ignored updates to be logged',
      () => (running().logs().filter((line) => line.msg === IGNORED_SENDER).length >= 3 ? true : undefined),
      15_000,
    );
    expect(quiet()).toBe(before);
    const ignored = running().logs().filter((line) => line.msg === IGNORED_SENDER);
    expect(ignored.map((line) => line.fields['updateType']).sort()).toEqual(['callback_query', 'message', 'message']);
    expect(ignored.map((line) => line.fields['chatType']).sort()).toEqual(['group', 'private', 'private']);
    expect(running().stdoutLines.join('\n')).not.toContain(marker);
  }, 30_000);

  it('the owner: /start answers with the help in Russian', async () => {
    const help = await owner.say('/start');
    expect(help.call.method).toBe('sendMessage');
    expect(help.text).toMatch(/[А-Яа-яЁё]/);
    expect(help.text).toContain('/new');
    expect(help.call.payload['parse_mode']).toBe('HTML');
  }, 30_000);

  it('/new, the buttons, confirm: the club offers only courts the bot may book, then a job is created', async () => {
    const dates = await owner.say('/new');
    expect(dates.buttons.map((button) => button.data.split(':').at(-1))).toContain(GAME_DATE);

    const courts = await owner.press(new RegExp(`^n:d:[0-9a-f]{6}:${GAME_DATE}$`), 60_000);
    expect(courts.text).toContain('Окно бронирования уже открыто');
    const offered = courts.buttons.filter((button) => button.data.startsWith('n:c:')).map((button) => Number(button.data.split(':')[3]));
    const free = allowedCourtIds(parseGameDate(GAME_DATE), buildHolidaySet(undefined)).filter((id) => id !== 9);
    expect(offered.sort((a, b) => a - b)).toEqual([...free].sort((a, b) => a - b));

    for (const courtId of COURTS_WISHED) {
      const times = await owner.press(new RegExp(`^n:c:[0-9a-f]{6}:${courtId}$`));
      expect(times.buttons.map((button) => button.data)).toEqual(
        expect.arrayContaining([expect.stringMatching(new RegExp(`^n:t:[0-9a-f]{6}:${courtId}:${START_1930}$`))]),
      );
      await owner.press(new RegExp(`^n:t:[0-9a-f]{6}:${courtId}:${START_1930}$`));
    }
    const review = await owner.press(/^n:g:[0-9a-f]{6}$/);
    expect(review.text).toContain('19:30');
    expect(review.text).toContain('Pista 8 exterior');

    const created = await owner.pressUntil(/^n:y:[0-9a-f]{6}$/, 'Задание создано', 60_000);
    expect(created.text).toContain('Задание создано');
    expect(telegram.of('answerCallbackQuery').every((call) => typeof call.payload['callback_query_id'] === 'string')).toBe(true);
  }, 120_000);

  it('logs in, runs the preflight, finds the form open, sends EXACTLY ONE add_event and tells the owner', async () => {
    const booked = await waitFor('the booked notification', () => bookedMessages().at(0), 90_000);
    await sleep(1500);

    const added = club.addEvents();
    expect(added).toHaveLength(1);
    const [request] = added;
    expect(request?.served).toBe('booked');
    expect(request?.path).toBe('/sportssuite/manager.php');
    expect(request?.body).toBe(expectedBody(10));
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    expect(request?.headers['x-requested-with']).toBe('XMLHttpRequest');
    expect(request?.headers['cookie']).toContain(`laravel_session=${synthetic.authedSession}`);
    expect(String(request?.headers['user-agent'])).toMatch(/^vamos-a-padel-bot/);
    expect(club.bookings).toEqual([{ date: GAME_DATE, courtId: 10, startMinutes: START_1930, reservationId: synthetic.reservationId }]);
    expect(club.cancelRequests()).toEqual([]);
    expect(club.walletCents()).toBe(5000 - 1902);

    // The window was never bypassed: the form of that very slot was fetched, and the site answered with an OPEN one, first.
    const before = request === undefined ? [] : clubRequestsBefore(request);
    const slotForms = before.filter(
      (other) =>
        other.path === '/reserves/cal_event.php' &&
        other.query.get('data') === `${GAME_DATE} 00:00:00` &&
        other.query.get('resource') === '10' &&
        other.query.get('hora') === String(START_1930),
    );
    expect(slotForms.length).toBeGreaterThan(0);
    expect(slotForms.at(-1)?.served).toBe('open_form');

    // The session came from a real login: login page, CSRF form post, an authenticated keep-alive, in that order.
    const served = club.requests.map((other) => other.served);
    expect(served.indexOf('login_page')).toBeGreaterThanOrEqual(0);
    expect(served.indexOf('login_ok')).toBeGreaterThan(served.indexOf('login_page'));
    expect(served.indexOf('cal_week')).toBeGreaterThan(served.indexOf('login_ok'));
    // Only the very first request (the date picker, before any login) may have been bounced to the login page.
    const bounced = club.requests.filter((other) => other.served === 'login_redirect');
    const firstLogin = club.requests.find((other) => other.served === 'login_ok');
    expect(bounced.length).toBeGreaterThan(0);
    expect(bounced.every((other) => other.seq < (firstLogin?.seq ?? 0))).toBe(true);
    for (const refused of ['login_refused', 'not_found', 'manager_not_xhr', 'add_event_bad_hash', 'closed_form']) {
      expect(served, refused).not.toContain(refused);
    }
    expect(club.requests.filter((other) => other.path === '/view/reserves/compra-moneder').length).toBeGreaterThan(0);

    // The owner was told, in Russian, with the reservation number.
    expect(booked).toContain('ЗАБРОНИРОВАНО');
    expect(booked).toContain('Pista 8 exterior');
    expect(booked).toContain('19:30–21:00');
    expect(booked).toContain(`Номер брони: ${synthetic.reservationId}`);
    expect(booked).toMatch(/[А-Яа-яЁё]/);
    expect(bookedMessages()).toHaveLength(1);
    const sentTo = telegram.of('sendMessage').map((call) => Number(call.payload['chat_id']));
    expect(new Set(sentTo)).toEqual(new Set([synthetic.ownerId]));
    const notifications = telegram.of('sendMessage').map((call) => String(call.payload['text']));
    expect(notifications.findIndex((text) => text.includes('заряжено'))).toBeLessThan(notifications.findIndex((text) => text.includes('ЗАБРОНИРОВАНО')));
  }, 120_000);

  it('the job is booked in the SQLite file', async () => {
    const { jobs, integrity } = readDatabase(true);
    expect(integrity).toEqual(['ok']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      state: 'booked',
      game_date: GAME_DATE,
      reservation_id: synthetic.reservationId,
      attempts: 1,
      notified_state: 'booked',
    });
    expect(JSON.parse(jobs[0]?.booked_choice ?? 'null')).toMatchObject({ courtId: 10, startMinutes: START_1930 });
  });

  it('prints only JSON log lines, and no secret reaches the log, stderr, Telegram or the other fake server', async () => {
    const lines = running().logs();
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect(line.fields['app']).toBe('vamos-a-padel-bot');
    expect(lines.map((line) => line.msg)).toEqual(expect.arrayContaining(['starting', 'running', 'logged in', 'preflight ok', 'booking request finished', 'firing finished']));
    expect(lines.find((line) => line.msg === 'firing finished')?.fields['result']).toBe('booked');

    expectNoSecrets('stdout', running().stdoutLines.join('\n'));
    expectNoSecrets('stderr', running().stderr());
    expectNoSecrets('the Telegram traffic', JSON.stringify(telegram.calls));
    // And the other way round: the Telegram token never travelled to the club, the club's secrets never to Telegram.
    const clubTraffic = JSON.stringify(club.requests.map((request) => ({ ...request, query: request.query.toString() })));
    expect(clubTraffic).not.toContain(synthetic.botTokenSecret);
    expect(clubTraffic).not.toContain(synthetic.botToken);

    // Nothing went wrong behind the scenes. The only warnings: the announced API root and the ignored strangers (the
    // price of /new is quoted for real: the quote reads the booking form itself to learn the account id).
    const warnings = lines.filter((line) => line.level >= 40);
    expect([...new Set(warnings.map((line) => line.msg))].sort()).toEqual(
      [IGNORED_SENDER, 'telegram: the Bot API root is overridden (tests only)'].sort(),
    );
    expect(running().stderr()).toBe('');
  });

  it('talks to nobody but the two fake servers', async () => {
    const connections = readNetLog(dir, 'run1');
    expect(connections.filter((line) => line.startsWith('BLOCKED'))).toEqual([]);
    const targets = new Set(connections.map((line) => line.replace('CONNECT ', '')));
    expect([...targets].sort()).toEqual([`127.0.0.1:${portOf(club.origin)}`, `127.0.0.1:${portOf(telegram.origin)}`].sort());
    expect(telegram.calls.every((call) => call.tokenOk)).toBe(true);
    const methods = new Set(telegram.calls.map((call) => call.method));
    expect([...methods].sort()).toEqual(['answerCallbackQuery', 'deleteWebhook', 'editMessageText', 'getMe', 'getUpdates', 'sendMessage', 'setMyCommands']);
  });

  it('SIGINT: an orderly shutdown, exit code 0, no orphan, the database consistent, the last update confirmed', async () => {
    const process1 = running();
    const exit = await process1.shutdown('SIGINT');
    expect(exit).toEqual({ code: 0, signal: null });
    expect(isAlive(process1.pid)).toBe(false);

    const messages = process1.logs().map((line) => line.msg);
    expect(messages).toEqual(expect.arrayContaining(['shutdown requested', 'stopping', 'stopped']));
    expect(messages.indexOf('stopping')).toBeLessThan(messages.indexOf('stopped'));
    expect(process1.logs().find((line) => line.msg === 'shutdown requested')?.fields['signal']).toBe('SIGINT');
    expect(process1.logs().filter((line) => line.level >= 50)).toEqual([]);
    expect(process1.stderr()).toBe('');

    const seen = telegram.calls.length;
    await sleep(700);
    expect(telegram.calls.length).toBe(seen);
    expect(telegram.unconfirmed()).toBe(0);

    const { jobs, integrity } = readDatabase(false);
    expect(integrity).toEqual(['ok']);
    expect(jobs.map((job) => job.state)).toEqual(['booked']);
    expect(club.addEvents()).toHaveLength(1);
    bot = undefined;
  }, 60_000);

  it('a restart on the same database books nothing again, tells nothing twice, and answers /jobs; SIGTERM ends it in order', async () => {
    const second = startBot({ envFile: botEnv(), dir, tag: 'run2' });
    bot = second;
    await second.waitForLog('running', 30_000);
    await sleep(3500);
    expect(club.addEvents()).toHaveLength(1);
    expect(bookedMessages()).toHaveLength(1);

    const jobs = await owner.say('/jobs');
    expect(jobs.text).toContain('Статус: забронировано');
    expect(jobs.text).toContain(`${GAME_DATE.slice(8, 10)}.${GAME_DATE.slice(5, 7)}.${GAME_DATE.slice(0, 4)}`);
    expect(jobs.text).toContain(String(synthetic.reservationId));
    expect(club.addEvents()).toHaveLength(1);

    const exit = await second.shutdown('SIGTERM');
    expect(exit).toEqual({ code: 0, signal: null });
    expect(isAlive(second.pid)).toBe(false);
    expect(second.logs().find((line) => line.msg === 'shutdown requested')?.fields['signal']).toBe('SIGTERM');
    expect(second.logs().filter((line) => line.level >= 50)).toEqual([]);
    expect(second.stderr()).toBe('');
    expectNoSecrets('the second run', second.stdoutLines.join('\n'));
    expect(readNetLog(dir, 'run2').filter((line) => line.startsWith('BLOCKED'))).toEqual([]);
    bot = undefined;
  }, 90_000);

  it('a hard kill leaves a database that opens, passes the integrity check and still holds the booking', async () => {
    const third = startBot({ envFile: botEnv(), dir, tag: 'run3' });
    bot = third;
    await third.waitForLog('running', 30_000);
    const exit = await third.kill();
    expect(exit.code === null || exit.code !== 0).toBe(true);
    expect(isAlive(third.pid)).toBe(false);

    const { jobs, integrity } = readDatabase(false);
    expect(integrity).toEqual(['ok']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: 'booked', reservation_id: synthetic.reservationId });
    expect(club.addEvents()).toHaveLength(1);
    bot = undefined;
  }, 60_000);
});
