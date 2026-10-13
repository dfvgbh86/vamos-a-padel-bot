/**
 * Static guards for the integration layer: no console, no secrets, no .env reading, the process environment is
 * touched only by the two entry points, files stay small. Failures print `file:line` only, never the matched text.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const rel = (file: string): string => relative(ROOT, file).replace(/\\/g, '/');

const INTEGRATION_FILES = [
  join(ROOT, 'src', 'app.ts'),
  join(ROOT, 'src', 'main.ts'),
  join(ROOT, 'src', 'index.ts'),
  join(ROOT, 'src', 'cli.ts'),
  join(ROOT, 'src', 'config', 'env.ts'),
  ...walk(join(ROOT, 'src', 'runtime')),
  ...walk(join(ROOT, 'src', 'cli')),
].filter((file) => file.endsWith('.ts'));

const hits = (files: readonly string[], pattern: RegExp): string[] =>
  files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .flatMap((line, index) => (pattern.test(line) ? [`${rel(file)}:${index + 1}`] : [])),
  );

describe('integration layer hygiene', () => {
  it('finds the files', () => {
    expect(INTEGRATION_FILES.map(rel).sort()).toEqual(
      expect.arrayContaining([
        'src/app.ts',
        'src/cli.ts',
        'src/cli/run.ts',
        'src/config/env.ts',
        'src/index.ts',
        'src/main.ts',
        'src/runtime/logger.ts',
        'src/runtime/ownerApi.ts',
        'src/runtime/shutdown.ts',
      ]),
    );
  });

  it.each([
    ['console.*', /\bconsole\s*\./],
    ['explicit any', /(:\s*any\b|\bas\s+any\b|<any>)/],
    ['ts-ignore / eslint-disable', /@ts-(ignore|expect-error|nocheck)|eslint-disable/],
    ['TODO / FIXME / HACK', /\b(TODO|FIXME|HACK|XXX)\b/],
    ['40-hex literals (account hashes)', /\b[0-9a-f]{40}\b/i],
    ['bot-token-shaped literals', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
    ['reading dotenv files', /dotenv|readFileSync\([^)]*\.env|readFile\([^)]*\.env/],
    ['eval / Function constructor', /\b(eval\s*\(|new\s+Function\s*\()/],
  ])('has no %s', (_label, pattern) => {
    expect(hits(INTEGRATION_FILES, pattern)).toEqual([]);
  });

  it('keeps every file under 300 lines', () => {
    const long = INTEGRATION_FILES.filter((file) => readFileSync(file, 'utf8').split(/\r?\n/).length > 300);
    expect(long.map(rel)).toEqual([]);
  });

  it('touches the process environment only in the two entry points (everything else gets it as a parameter)', () => {
    const files = walk(join(ROOT, 'src')).filter((file) => file.endsWith('.ts'));
    expect(hits(files, /\bprocess\s*\.\s*env\b/).map((hit) => hit.split(':')[0])).toEqual(['src/cli.ts', 'src/main.ts']);
  });

  it('calls process.exit only where the process ends: the entry points', () => {
    const files = walk(join(ROOT, 'src')).filter((file) => file.endsWith('.ts'));
    expect(new Set(hits(files, /\bprocess\s*\.\s*exit\b/).map((hit) => hit.split(':')[0]))).toEqual(new Set(['src/cli.ts', 'src/main.ts']));
  });

  it('the pure configuration module does not read the process or the file system', () => {
    expect(hits([join(ROOT, 'src', 'config', 'env.ts')], /\bprocess\b|node:fs|node:path/)).toEqual([]);
  });

  it('nothing in src creates or reads an .env file', () => {
    const files = walk(join(ROOT, 'src')).filter((file) => file.endsWith('.ts'));
    expect(hits(files, /(readFile|writeFile|createReadStream|existsSync|appendFile)\w*\s*\([^)]*['"`][^'"`]*\.env['"`]/)).toEqual([]);
  });

  it('src/index.ts and src/cli.ts only run: no logic of their own beyond wiring the real process', () => {
    expect(readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8').trim().split(/\r?\n/).length).toBeLessThanOrEqual(3);
    expect(readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8').split(/\r?\n/).length).toBeLessThan(40);
  });
});

describe('build and run configuration', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
  };

  it('has the scripts the README promises', () => {
    expect(packageJson.scripts).toMatchObject({
      build: 'tsc -p tsconfig.build.json',
      start: 'node --env-file=.env --disable-warning=ExperimentalWarning dist/src/index.js',
      cli: 'node --env-file=.env --disable-warning=ExperimentalWarning dist/src/cli.js',
      test: 'vitest run',
      typecheck: 'tsc --noEmit',
    });
  });

  it('the start scripts point at the files the build writes', () => {
    const build = JSON.parse(readFileSync(join(ROOT, 'tsconfig.build.json'), 'utf8')) as { include: string[]; extends: string; compilerOptions: { noEmit: boolean } };
    expect(build.include).toEqual(['src']);
    expect(build.extends).toBe('./tsconfig.json');
    expect(build.compilerOptions.noEmit).toBe(false);
    const base = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')) as { compilerOptions: { rootDir: string; outDir: string } };
    // rootDir "." + include ["src"] => dist/src/index.js and dist/src/cli.js
    expect(base.compilerOptions).toMatchObject({ rootDir: '.', outDir: 'dist' });
  });

  it('adds no dependency', () => {
    expect(Object.keys(packageJson.dependencies).sort()).toEqual(['grammy', 'luxon', 'pino', 'tough-cookie', 'zod']);
  });

  it('keeps the build output and the database out of git', () => {
    const rules = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
    for (const rule of ['dist/', '.env', 'data/', '*.sqlite']) expect(rules).toContain(rule);
  });
});
