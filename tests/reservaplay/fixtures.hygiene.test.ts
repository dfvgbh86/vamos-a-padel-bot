import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HASH } from '../fixtures/reservaplay/constants.js';

const FIXTURES = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'reservaplay');

/** Keys that carry other people's data in the site's answers. They must not even appear as words in a fixture. */
const FORBIDDEN_KEYS = ['nombre', 'pin', 'codigo', 'email', 'telefono', 'dni', 'nif'] as const;
const FORBIDDEN = new RegExp(`\\b(${FORBIDDEN_KEYS.join('|')})\\b`, 'i');
const FORTY_HEX = /\b[0-9a-f]{40}\b/gi;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const withoutAccents = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** `file:line` of every violation: never the offending text itself. */
const findViolations = (file: string, content: string): string[] => {
  const hits: string[] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const where = `${file}:${index + 1}`;
    if (FORBIDDEN.test(withoutAccents(line))) hits.push(`${where} forbidden key`);
    for (const match of line.match(FORTY_HEX) ?? []) if (match !== HASH) hits.push(`${where} 40-hex string`);
  });
  return hits;
};

describe('the scanner itself', () => {
  it.each([
    ['a JSON key', '{"nombre": "x"}'],
    ['an upper-case key', 'PIN: 1234'],
    ['an accented key', 'código de acceso'],
    ['a quoted key in code', "{ email: 'a@b.test' }"],
    ['telefono', 'telefono=1'],
    ['dni', '"dni":1'],
    ['nif', 'NIF'],
  ])('flags %s', (_name, content) => {
    expect(findViolations('f', content)).toHaveLength(1);
  });

  it('flags a 40-hex string other than the synthetic hash, in any case, but not the synthetic hash', () => {
    expect(findViolations('f', 'a'.repeat(40))).toHaveLength(1);
    expect(findViolations('f', 'ABCDEF0123'.repeat(4))).toHaveLength(1);
    expect(findViolations('f', `hash=${HASH}`)).toEqual([]);
    expect(findViolations('f', `${'a'.repeat(39)}`)).toEqual([]);
    expect(findViolations('f', `${'a'.repeat(41)}`)).toEqual([]);
  });

  it('does not flag ordinary words that merely contain a forbidden word', () => {
    expect(findViolations('f', 'pinned spinner typing nifty emailing')).toEqual([]);
  });

  it('never prints the offending text', () => {
    expect(findViolations('f', '{"email": "secret@example.test"}').join('')).not.toContain('secret');
  });
});

describe('fixtures under tests/fixtures/reservaplay', () => {
  const files = walk(FIXTURES);

  it('exist (the scan is not vacuous)', () => {
    const names = files.map((file) => relative(FIXTURES, file).replace(/\\/g, '/'));
    expect(names).toEqual(expect.arrayContaining(['calendar.ts', 'constants.ts', 'fakeFetch.ts', 'fakeSite.ts', 'pages.ts', 'responses.ts']));
  });

  it('contain none of the forbidden keys and no 40-hex string besides the synthetic hash', () => {
    const violations = files.flatMap((file) => findViolations(relative(FIXTURES, file).replace(/\\/g, '/'), readFileSync(file, 'utf8')));
    expect(violations).toEqual([]);
  });

  it('use the documented synthetic values only', () => {
    const constants = readFileSync(join(FIXTURES, 'constants.ts'), 'utf8');
    expect(constants).toContain('12345');
    expect(constants).toContain('0123456789abcdef0123456789abcdef01234567');
    expect(constants).toContain('Test Player');
  });

  it('contain no realistic session cookie, bearer token or bot token', () => {
    const text = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(text).not.toMatch(/(laravel_session|XSRF-TOKEN|AWSALB\w*)\s*=\s*[A-Za-z0-9%+/_-]{16,}/);
    expect(text).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{20,}/);
    expect(text).not.toMatch(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/);
  });
});
