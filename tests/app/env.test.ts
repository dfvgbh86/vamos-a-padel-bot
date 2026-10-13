import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_URL,
  DEFAULT_DB_PATH,
  ENV_KEYS,
  EnvError,
  loadEnv,
  loadSiteEnv,
  loadTelegramTokenEnv,
  type EnvSource,
} from '../../src/config/env.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Synthetic values only. */
const VALID: EnvSource = {
  TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN-NOT-REAL',
  TELEGRAM_ALLOWED_USER_IDS: '42',
  RESERVAPLAY_USERNAME: 'test-player',
  RESERVAPLAY_PASSWORD: 'synthetic-password-0001',
};

const load = (patch: Record<string, string | undefined> = {}) => loadEnv({ ...VALID, ...patch });

const failure = (patch: Record<string, string | undefined>, source: (env: EnvSource) => unknown = loadEnv): EnvError => {
  try {
    source({ ...VALID, ...patch });
  } catch (error) {
    if (error instanceof EnvError) return error;
    throw error;
  }
  throw new Error('expected loadEnv to throw an EnvError');
};

describe('loadEnv: a valid environment', () => {
  it('reads the four required keys and fills in the defaults', () => {
    const env = load();
    expect(env).toMatchObject({
      telegramBotToken: '123456:TEST-TOKEN-NOT-REAL',
      allowedUserIds: [42],
      baseUrl: DEFAULT_BASE_URL,
      username: 'test-player',
      password: 'synthetic-password-0001',
      dbPath: DEFAULT_DB_PATH,
      logLevel: 'info',
    });
    expect(DEFAULT_BASE_URL).toBe('https://enjoyvalenciaclubesoutdoor.reservaplay.com');
    expect(DEFAULT_DB_PATH).toBe('data/bot.sqlite');
  });

  it('includes the official holidays even without EXTRA_HOLIDAYS', () => {
    const { holidays } = load();
    expect(holidays.has('2026-12-08' as never)).toBe(true);
    expect(holidays.has('2027-10-12' as never)).toBe(true);
    expect(holidays.size).toBeGreaterThan(20);
  });

  it('adds EXTRA_HOLIDAYS to the official ones', () => {
    const { holidays } = load({ EXTRA_HOLIDAYS: '2027-03-18, 2027-03-19 ,2027-04-02' });
    expect(holidays.has('2027-03-18' as never)).toBe(true);
    expect(holidays.has('2027-04-02' as never)).toBe(true);
    expect(holidays.has('2026-12-08' as never)).toBe(true);
  });

  it('accepts several user ids, trims them, drops duplicates and blank entries', () => {
    expect(load({ TELEGRAM_ALLOWED_USER_IDS: ' 42, 7 ,42,, 123456789012 ,' }).allowedUserIds).toEqual([42, 7, 123456789012]);
  });

  it('takes explicit values for the optional keys', () => {
    const env = load({
      RESERVAPLAY_BASE_URL: 'https://club.example.test/',
      DB_PATH: ' var/jobs.sqlite ',
      LOG_LEVEL: ' DEBUG ',
    });
    expect(env).toMatchObject({ baseUrl: 'https://club.example.test', dbPath: 'var/jobs.sqlite', logLevel: 'debug' });
  });

  it('keeps a base URL path prefix and drops trailing slashes', () => {
    expect(load({ RESERVAPLAY_BASE_URL: 'https://club.example.test/app///' }).baseUrl).toBe('https://club.example.test/app');
  });

  it('trims the token and the username but never the password', () => {
    const env = load({ TELEGRAM_BOT_TOKEN: '  123456:TEST-TOKEN-NOT-REAL  ', RESERVAPLAY_USERNAME: ' test-player ', RESERVAPLAY_PASSWORD: ' pass word ' });
    expect(env.telegramBotToken).toBe('123456:TEST-TOKEN-NOT-REAL');
    expect(env.username).toBe('test-player');
    expect(env.password).toBe(' pass word ');
  });

  it.each(['RESERVAPLAY_BASE_URL', 'DB_PATH', 'LOG_LEVEL', 'EXTRA_HOLIDAYS'])('treats an empty %s (a copied .env.example) as "not set"', (key) => {
    const env = load({ [key]: '' });
    expect(env.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(env.dbPath).toBe(DEFAULT_DB_PATH);
    expect(env.logLevel).toBe('info');
  });

  it.each(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])('accepts the log level %s', (level) => {
    expect(load({ LOG_LEVEL: level }).logLevel).toBe(level);
  });

  it('ignores unrelated variables of the process', () => {
    expect(() => load({ PATH: 'x', HOME: 'y', SOMETHING_ELSE: 'z' })).not.toThrow();
  });
});

describe('loadEnv: missing keys', () => {
  it('lists every missing required key, in the order of .env.example, and nothing else', () => {
    const error = failure({
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_ALLOWED_USER_IDS: undefined,
      RESERVAPLAY_USERNAME: undefined,
      RESERVAPLAY_PASSWORD: undefined,
    });
    expect(error.missing).toEqual(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USER_IDS', 'RESERVAPLAY_USERNAME', 'RESERVAPLAY_PASSWORD']);
    expect(error.invalid).toEqual([]);
    expect(error.message).toContain('missing: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, RESERVAPLAY_USERNAME, RESERVAPLAY_PASSWORD');
    expect(error.message).toContain('.env.example');
  });

  it('fails on a completely empty environment', () => {
    expect(() => loadEnv({})).toThrow(EnvError);
  });

  it.each(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USER_IDS', 'RESERVAPLAY_USERNAME', 'RESERVAPLAY_PASSWORD'])('fails when %s is absent, empty or blank', (key) => {
    for (const value of [undefined, '', '   ', '\t']) {
      const error = failure({ [key]: value });
      expect(error.missing).toEqual([key]);
    }
  });

  it('an empty allowlist is a startup error, never "everyone"', () => {
    for (const value of ['', ' ', ',', ' , ,']) {
      expect(() => load({ TELEGRAM_ALLOWED_USER_IDS: value })).toThrow(EnvError);
    }
  });
});

describe('loadEnv: invalid values', () => {
  it.each([
    ['letters', 'abc'],
    ['a negative id (group chats are negative)', '-100123'],
    ['zero', '0'],
    ['a fraction', '1.5'],
    ['an exponent', '1e3'],
    ['hex', '0x10'],
    ['a sign', '+5'],
    ['a list with one bad entry', '42,abc'],
    ['two ids without a comma', '42 43'],
    ['a semicolon list', '42;43'],
    ['more digits than a safe integer', '99999999999999999999'],
    ['a username', '@someone'],
  ])('rejects an allowlist with %s', (_label, value) => {
    const error = failure({ TELEGRAM_ALLOWED_USER_IDS: value });
    expect(error.invalid).toEqual(['TELEGRAM_ALLOWED_USER_IDS']);
    expect(error.missing).toEqual([]);
  });

  it.each([
    ['plain http', 'http://club.example.test'],
    ['http on localhost', 'http://localhost:8080'],
    ['not a URL', 'club.example.test'],
    ['another scheme', 'ftp://club.example.test'],
    ['credentials in the URL', 'https://user:secret@club.example.test'],
    ['a query string', 'https://club.example.test/?a=1'],
    ['a fragment', 'https://club.example.test/#x'],
  ])('rejects a base URL with %s', (_label, value) => {
    expect(failure({ RESERVAPLAY_BASE_URL: value }).invalid).toEqual(['RESERVAPLAY_BASE_URL']);
  });

  it.each(['2027-02-30', '2027-13-01', '27-03-18', 'tomorrow', '2027-03-18;2027-03-19'])('rejects the extra holiday %s', (value) => {
    expect(failure({ EXTRA_HOLIDAYS: value }).invalid).toEqual(['EXTRA_HOLIDAYS']);
  });

  it('rejects a good date next to a bad one (nothing is silently dropped)', () => {
    expect(failure({ EXTRA_HOLIDAYS: '2027-03-18,nope' }).invalid).toEqual(['EXTRA_HOLIDAYS']);
  });

  it.each(['verbose', 'INFO2', '3'])('rejects the log level %s', (value) => {
    expect(failure({ LOG_LEVEL: value }).invalid).toEqual(['LOG_LEVEL']);
  });

  it('rejects a database path with a NUL character', () => {
    expect(failure({ DB_PATH: 'data/\0bot.sqlite' }).invalid).toEqual(['DB_PATH']);
  });

  it('reports missing and invalid keys together, each under its own heading', () => {
    const error = failure({ RESERVAPLAY_PASSWORD: undefined, TELEGRAM_ALLOWED_USER_IDS: 'abc', LOG_LEVEL: 'loud' });
    expect(error.missing).toEqual(['RESERVAPLAY_PASSWORD']);
    expect(error.invalid).toEqual(['TELEGRAM_ALLOWED_USER_IDS', 'LOG_LEVEL']);
    expect(error.message).toContain('missing: RESERVAPLAY_PASSWORD');
    expect(error.message).toContain('invalid: TELEGRAM_ALLOWED_USER_IDS, LOG_LEVEL');
  });
});

describe('error messages never contain a value', () => {
  const SENTINELS = {
    TELEGRAM_BOT_TOKEN: '999111:SENTINEL-TOKEN-VALUE-0001',
    RESERVAPLAY_USERNAME: 'sentinel-username-0001',
    RESERVAPLAY_PASSWORD: 'sentinel-password-0001',
  };

  it.each([
    ['an invalid allowlist', { TELEGRAM_ALLOWED_USER_IDS: 'sentinel-ids-0001' }],
    ['an invalid base URL', { RESERVAPLAY_BASE_URL: 'http://sentinel-host-0001.example.test' }],
    ['an invalid holiday', { EXTRA_HOLIDAYS: '2027-02-31-sentinel-0001' }],
    ['an invalid log level', { LOG_LEVEL: 'sentinel-level-0001' }],
    ['a missing id list', { TELEGRAM_ALLOWED_USER_IDS: undefined }],
  ])('%s', (_label, patch) => {
    const error = failure({ ...SENTINELS, ...patch });
    for (const value of [...Object.values(SENTINELS), ...Object.values(patch)]) {
      if (value !== undefined) expect(error.message).not.toContain(value);
    }
    expect(JSON.stringify({ missing: error.missing, invalid: error.invalid })).not.toContain('sentinel');
  });
});

describe('loadSiteEnv and loadTelegramTokenEnv (for the CLI)', () => {
  const SITE_ONLY: EnvSource = { RESERVAPLAY_USERNAME: 'test-player', RESERVAPLAY_PASSWORD: 'synthetic-password-0001' };

  it('the site settings need no Telegram settings', () => {
    expect(loadSiteEnv(SITE_ONLY)).toMatchObject({ username: 'test-player', baseUrl: DEFAULT_BASE_URL, dbPath: DEFAULT_DB_PATH });
  });

  it('the site settings still demand the account', () => {
    expect(() => loadSiteEnv({ RESERVAPLAY_USERNAME: 'test-player' })).toThrow(/missing: RESERVAPLAY_PASSWORD/);
  });

  it('the site settings validate the optional keys too', () => {
    expect(() => loadSiteEnv({ ...SITE_ONLY, RESERVAPLAY_BASE_URL: 'http://x.example.test' })).toThrow(/invalid: RESERVAPLAY_BASE_URL/);
  });

  it('the token alone is enough to find out the Telegram id', () => {
    expect(loadTelegramTokenEnv({ TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN-NOT-REAL' })).toEqual({ telegramBotToken: '123456:TEST-TOKEN-NOT-REAL' });
  });

  it('the token is required there', () => {
    expect(() => loadTelegramTokenEnv({})).toThrow(/missing: TELEGRAM_BOT_TOKEN/);
    expect(() => loadTelegramTokenEnv({ TELEGRAM_BOT_TOKEN: '  ' })).toThrow(EnvError);
  });
});

describe('.env.example matches the loader', () => {
  const documented = (): Map<string, string> => {
    const keys = new Map<string, string>();
    for (const line of readFileSync(join(ROOT, '.env.example'), 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (match) keys.set(match[1] as string, match[2] as string);
    }
    return keys;
  };

  it('documents exactly the keys the loader reads, in the same order', () => {
    expect([...documented().keys()]).toEqual([...ENV_KEYS]);
  });

  it('an untouched copy of it fails with exactly the four keys the owner has to fill in', () => {
    const copy: Record<string, string> = Object.fromEntries(documented());
    const error = (() => {
      try {
        loadEnv(copy);
      } catch (caught) {
        return caught as EnvError;
      }
      throw new Error('expected the untouched example to be rejected');
    })();
    expect(error.missing).toEqual(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USER_IDS', 'RESERVAPLAY_USERNAME', 'RESERVAPLAY_PASSWORD']);
    expect(error.invalid).toEqual([]);
  });

  it('the example values for the optional keys are the defaults', () => {
    const copy = documented();
    expect(copy.get('RESERVAPLAY_BASE_URL')).toBe(DEFAULT_BASE_URL);
    expect(copy.get('DB_PATH')).toBe(DEFAULT_DB_PATH);
    expect(copy.get('LOG_LEVEL')).toBe('info');
  });
});
