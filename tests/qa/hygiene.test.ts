/**
 * Repository hygiene guards (static). They never print a matched value, only `file:line`, so a failure
 * cannot leak a secret into CI logs. They do not read any `.env` file (only `.env.example`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FAKE_HASH } from './_helpers.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === 'coverage') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

const rel = (file: string): string => relative(ROOT, file).replace(/\\/g, '/');

const grepLines = (files: string[], pattern: RegExp, allow: (match: string) => boolean = () => false): string[] => {
  const hits: string[] = [];
  for (const file of files) {
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        for (const match of line.match(pattern) ?? []) if (!allow(match)) hits.push(`${rel(file)}:${index + 1}`);
      });
  }
  return hits;
};

const textFiles = (): string[] =>
  walk(ROOT).filter((path) => /\.(ts|js|mjs|json|md|example|yml|yaml|txt)$/.test(path) && !path.endsWith('package-lock.json'));

describe('QA hygiene: no secrets in the repository', () => {
  it('no 40-hex literal in src/ or tests/ other than the synthetic QA hash (an account `hash` must never be committed)', () => {
    const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'tests'))].filter((path) => path.endsWith('.ts'));
    expect(grepLines(files, /\b[0-9a-f]{40}\b/gi, (match) => match === FAKE_HASH)).toEqual([]);
  });

  it('no Telegram-bot-token-shaped string in any text file', () => {
    expect(grepLines(textFiles(), /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g)).toEqual([]);
  });

  it('no session-cookie or CSRF token assignments in any text file (laravel_session=..., XSRF-TOKEN=..., Bearer ...)', () => {
    const files = textFiles().filter((path) => !path.endsWith('PLAN.md'));
    expect(grepLines(files, /(laravel_session|XSRF-TOKEN|AWSALB\w*)\s*=\s*[A-Za-z0-9%+/_-]{16,}/g)).toEqual([]);
    expect(grepLines(files, /\bBearer\s+[A-Za-z0-9._-]{20,}/g)).toEqual([]);
  });

  it('.env.example contains no real values: every secret key is empty', () => {
    const lines = readFileSync(join(ROOT, '.env.example'), 'utf8').split(/\r?\n/);
    const values = new Map<string, string>();
    for (const line of lines) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match) values.set(match[1] as string, match[2] as string);
    }
    for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USER_IDS', 'RESERVAPLAY_USERNAME', 'RESERVAPLAY_PASSWORD', 'EXTRA_HOLIDAYS']) {
      expect(values.has(key), `${key} documented`).toBe(true);
      expect(values.get(key), `${key} must be empty in .env.example`).toBe('');
    }
    expect(values.get('RESERVAPLAY_BASE_URL')).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    // nothing else that looks like a credential
    for (const [key, value] of values) {
      if (/(TOKEN|PASSWORD|SECRET|COOKIE|KEY)/.test(key)) expect(value, key).toBe('');
    }
  });
});

describe('QA hygiene: pure-logic modules stay pure (no clock, no console, no network, no `any`, no timers)', () => {
  const pure = [
    ...walk(join(ROOT, 'src', 'config')),
    join(ROOT, 'src', 'reservaplay', 'bookingBody.ts'),
    join(ROOT, 'src', 'reservaplay', 'classify.ts'),
    join(ROOT, 'src', 'sniper', 'openTime.ts'),
  ].filter((path) => path.endsWith('.ts'));

  it('found the modules', () => {
    expect(pure.map(rel).sort()).toEqual([
      'src/config/courts.ts',
      'src/config/gameDate.ts',
      'src/config/holidays.ts',
      'src/config/timezone.ts',
      'src/reservaplay/bookingBody.ts',
      'src/reservaplay/classify.ts',
      'src/sniper/openTime.ts',
    ]);
  });

  it.each([
    ['console.*', /\bconsole\s*\./],
    ['Date.now()', /\bDate\s*\.\s*now\s*\(/],
    ['new Date(', /\bnew\s+Date\s*\(/],
    ['DateTime.now / local()', /\bDateTime\s*\.\s*(now|local)\s*\(/],
    ['performance.now', /\bperformance\s*\.\s*now\b/],
    ['setTimeout / setInterval', /\bset(Timeout|Interval|Immediate)\s*\(/],
    ['process.env / process.exit', /\bprocess\s*\.\s*(env|exit)\b/],
    ['fetch / http / net imports', /\b(fetch\s*\(|from\s+['"](node:)?(http|https|net|tls|dgram|child_process)['"]|undici)/],
    ['eval / Function constructor', /\b(eval\s*\(|new\s+Function\s*\()/],
    ['explicit any', /(:\s*any\b|\bas\s+any\b|<any>)/],
    ['ts-ignore / ts-expect-error / eslint-disable', /@ts-(ignore|expect-error|nocheck)|eslint-disable/],
    ['TODO / FIXME / HACK', /\b(TODO|FIXME|HACK|XXX)\b/],
  ])('no %s', (_label, pattern) => {
    expect(grepLines(pure, new RegExp(pattern.source, 'g'))).toEqual([]);
  });

  it('src/ never logs: no console.* anywhere', () => {
    expect(grepLines(walk(join(ROOT, 'src')).filter((path) => path.endsWith('.ts')), /\bconsole\s*\./g)).toEqual([]);
  });
});

describe('QA hygiene: .gitignore baseline (the stricter checks are BUG-14)', () => {
  it('ignores .env, node_modules, dist, sqlite and runtime data', () => {
    const rules = readFileSync(join(ROOT, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim());
    for (const rule of ['.env', 'node_modules/', 'dist/', '*.sqlite', 'data/', 'logs/']) expect(rules, rule).toContain(rule);
    expect(rules).not.toContain('!.env');
  });
});
