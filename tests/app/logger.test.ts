import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, REDACTED, redactPaths, scoped, SECRET_KEYS } from '../../src/runtime/logger.js';

const capture = (level: Parameters<typeof createLogger>[0] = 'debug') => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const logger = createLogger(level, stream);
  const records = (): Record<string, unknown>[] => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, records };
};

const SECRET = 'sentinel-secret-value-0001';

describe('the application logger redacts secrets by key', () => {
  it.each(SECRET_KEYS)('censors %s at the top level', (key) => {
    const { logger, lines, records } = capture();
    logger.info({ [key]: SECRET, visible: 'yes' }, 'event');
    expect(lines.join('')).not.toContain(SECRET);
    expect(records()[0]).toMatchObject({ [key]: REDACTED, visible: 'yes', msg: 'event' });
  });

  it.each(SECRET_KEYS)('censors %s nested one, two and three levels deep', (key) => {
    const { logger, lines } = capture();
    logger.info({ a: { [key]: SECRET }, b: { c: { [key]: SECRET } }, d: { e: { f: { [key]: SECRET } } } }, 'event');
    expect(lines.join('')).not.toContain(SECRET);
    expect(lines.join('').split(REDACTED)).toHaveLength(4);
  });

  it('covers the keys the project promised to hide', () => {
    for (const key of ['password', 'token', 'authorization', 'cookie', 'set-cookie', 'hash', '_token', 'laravel_session', 'XSRF-TOKEN']) {
      expect(SECRET_KEYS).toContain(key);
    }
  });

  it('censors HTTP header objects in any spelling', () => {
    const { logger, lines } = capture();
    logger.warn(
      { headers: { authorization: SECRET, Authorization: SECRET, cookie: SECRET, Cookie: SECRET, 'set-cookie': [SECRET], 'Set-Cookie': [SECRET], accept: 'text/html' } },
      'request',
    );
    expect(lines.join('')).not.toContain(SECRET);
    expect(lines.join('')).toContain('text/html');
  });

  it('keeps ordinary fields, including similarly named ones', () => {
    const { logger, records } = capture();
    logger.info({ jobId: 7, hashing: 'on', tokens: 3, passwordless: true }, 'event');
    expect(records()[0]).toMatchObject({ jobId: 7, hashing: 'on', tokens: 3, passwordless: true });
  });

  it('builds a path for every key at every depth', () => {
    expect(redactPaths()).toHaveLength(SECRET_KEYS.length * 4);
    expect(redactPaths()).toContain('["set-cookie"]');
    expect(redactPaths()).toContain('*.*.["XSRF-TOKEN"]');
  });
});

describe('the application logger output', () => {
  it('is one JSON object per line with an ISO time, the app name and no host name or process id', () => {
    const { logger, records } = capture();
    logger.info({ jobId: 1 }, 'hello');
    const [record] = records();
    expect(record).toMatchObject({ app: 'vamos-a-padel-bot', msg: 'hello', level: 30 });
    expect(String(record?.['time'])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(record).not.toHaveProperty('hostname');
    expect(record).not.toHaveProperty('pid');
  });

  it('honours the level', () => {
    const { logger, lines } = capture('warn');
    logger.debug({}, 'quiet');
    logger.info({}, 'quiet');
    logger.warn({}, 'loud');
    logger.error({}, 'louder');
    expect(lines).toHaveLength(2);
  });

  it('says nothing at all on "silent"', () => {
    const { logger, lines } = capture('silent');
    logger.error({}, 'x');
    expect(lines).toEqual([]);
  });

  it('works without a message', () => {
    const { logger, records } = capture();
    logger.info({ jobId: 1 });
    expect(records()[0]).toMatchObject({ jobId: 1 });
  });
});

describe('scoped', () => {
  it('adds the module name to every line of every level', () => {
    const { logger, records } = capture();
    const sniper = scoped(logger, 'sniper');
    sniper.debug({ a: 1 }, 'd');
    sniper.info({ a: 2 }, 'i');
    sniper.warn({ a: 3 }, 'w');
    sniper.error({ a: 4 }, 'e');
    expect(records().map((record) => [record['module'], record['a'], record['msg']])).toEqual([
      ['sniper', 1, 'd'],
      ['sniper', 2, 'i'],
      ['sniper', 3, 'w'],
      ['sniper', 4, 'e'],
    ]);
  });

  it('keeps censoring secrets that pass through it', () => {
    const { logger, lines } = capture();
    scoped(logger, 'reservaplay').info({ password: SECRET, nested: { cookie: SECRET } }, 'x');
    expect(lines.join('')).not.toContain(SECRET);
  });
});
