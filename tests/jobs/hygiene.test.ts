/**
 * Static guards for src/jobs: time only through the injected Clock, no console, no network, no secrets,
 * no `any`. Failures print `file:line` only, never the matched text.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const JOBS_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'src', 'jobs');
const files = readdirSync(JOBS_DIR).filter((name) => name.endsWith('.ts'));

const hits = (pattern: RegExp): string[] =>
  files.flatMap((name) =>
    readFileSync(join(JOBS_DIR, name), 'utf8')
      .split(/\r?\n/)
      .flatMap((line, index) => (pattern.test(line) ? [`${name}:${index + 1}`] : [])),
  );

describe('src/jobs hygiene', () => {
  it('finds the modules', () => {
    expect(files).toEqual(
      expect.arrayContaining(['store.ts', 'service.ts', 'transitions.ts', 'migrations.ts', 'rows.ts', 'sqlite.ts']),
    );
  });

  it.each([
    ['console.*', /\bconsole\s*\./],
    ['Date.now()', /\bDate\s*\.\s*now\s*\(/],
    ['new Date(', /\bnew\s+Date\s*\(/],
    ['DateTime.now / local()', /\bDateTime\s*\.\s*(now|local)\s*\(/],
    ['performance.now', /\bperformance\s*\.\s*now\b/],
    ['setTimeout / setInterval / setImmediate', /\bset(Timeout|Interval|Immediate)\s*\(/],
    ['process.env / process.exit', /\bprocess\s*\.\s*(env|exit)\b/],
    ['network access', /\b(fetch\s*\(|undici|node:(http|https|net|tls|dgram|child_process))/],
    ['reading dotenv files', /\.env\b|dotenv/],
    ['explicit any', /(:\s*any\b|\bas\s+any\b|<any>)/],
    ['ts-ignore / eslint-disable', /@ts-(ignore|expect-error|nocheck)|eslint-disable/],
    ['TODO / FIXME / HACK', /\b(TODO|FIXME|HACK|XXX)\b/],
    ['40-hex literals (account hashes)', /\b[0-9a-f]{40}\b/i],
  ])('has no %s', (_label, pattern) => {
    expect(hits(pattern)).toEqual([]);
  });

  it('keeps every module under 300 lines', () => {
    const long = files.filter((name) => readFileSync(join(JOBS_DIR, name), 'utf8').split(/\r?\n/).length > 300);
    expect(long).toEqual([]);
  });

  it('never cancels or books on its own: the service has no call to api.book / api.cancel / api.login', () => {
    const service = readFileSync(join(JOBS_DIR, 'service.ts'), 'utf8');
    expect(service).not.toMatch(/\.(book|cancel|login|probeForm|getAccountContext)\s*\(/);
  });
});
