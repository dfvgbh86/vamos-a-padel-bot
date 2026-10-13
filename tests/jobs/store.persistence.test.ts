import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTIVE_JOB_STATES, DuplicateActiveJobError } from '../../src/contracts.js';
import { InvalidJobInputError, JobStoreSchemaError } from '../../src/jobs/errors.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, migrate } from '../../src/jobs/migrations.js';
import { applyConnectionPragmas } from '../../src/jobs/sqlite.js';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { JOB_STATES } from '../../src/jobs/transitions.js';
import { cleanupTemp, date, driveTo, newJob, NOW, rawDb, tempDbPath, tempDir, track } from './_helpers.js';

afterEach(cleanupTemp);

const OPENS = Date.UTC(2026, 9, 13, 5, 0, 0);

describe('restart: data written to a file survives closing and reopening', () => {
  it('restores every job exactly, the emergency stop flag and the id sequence', () => {
    const path = tempDbPath();
    const first = new SqliteJobStore(path);
    const scheduled = first.create(newJob({ gameDate: date('2026-10-20') }), OPENS, NOW);
    const firing = first.create(newJob({ gameDate: date('2026-10-21'), payment: 'card', durationMinutes: 120 }), OPENS + 1, NOW + 1);
    driveTo(first, firing.id, 'firing');
    first.transition(firing.id, 'firing', 'booked', NOW + 50, {
      reservationId: 100002,
      bookedChoice: { courtId: 10, startMinutes: 1080 },
      attemptsDelta: 2,
    });
    const failed = first.create(newJob({ gameDate: date('2026-10-22') }), OPENS, NOW + 2);
    first.transition(failed.id, 'scheduled', 'failed', NOW + 60, { failureReason: 'no funds' });
    first.setStopped(true);
    const before = first.list();
    first.close();

    const second = track(new SqliteJobStore(path));
    expect(second.list()).toEqual(before);
    expect(second.get(scheduled.id)).toEqual(scheduled);
    expect(second.get(firing.id)).toMatchObject({
      state: 'booked',
      reservationId: 100002,
      bookedChoice: { courtId: 10, startMinutes: 1080 },
      attempts: 2,
      payment: 'card',
      durationMinutes: 120,
      opensAtMs: OPENS + 1,
      createdAtMs: NOW + 1,
      updatedAtMs: NOW + 50,
    });
    expect(second.get(failed.id)).toMatchObject({ state: 'failed', failureReason: 'no funds' });
    expect(second.isStopped()).toBe(true);
    expect(second.create(newJob({ gameDate: date('2026-10-23') }), OPENS, NOW + 9).id).toBe(4);
  });

  it('still enforces one active job per date after a restart', () => {
    const path = tempDbPath();
    const first = new SqliteJobStore(path);
    for (const [index, state] of ACTIVE_JOB_STATES.entries()) {
      const job = first.create(newJob({ gameDate: date(`2026-10-${20 + index}`) }), OPENS, NOW);
      driveTo(first, job.id, state);
    }
    first.close();
    const second = track(new SqliteJobStore(path));
    for (let index = 0; index < ACTIVE_JOB_STATES.length; index += 1) {
      expect(() => second.create(newJob({ gameDate: date(`2026-10-${20 + index}`) }), OPENS, NOW)).toThrow(DuplicateActiveJobError);
    }
  });

  it('keeps the matrix enforced on reloaded jobs (a finished job stays finished)', () => {
    const path = tempDbPath();
    const first = new SqliteJobStore(path);
    const job = first.create(newJob(), OPENS, NOW);
    driveTo(first, job.id, 'cancelled');
    first.close();
    const second = track(new SqliteJobStore(path));
    expect(second.transition(job.id, 'cancelled', 'scheduled', NOW)).toBeUndefined();
    expect(second.transition(job.id, 'cancelled', 'warming', NOW)).toBeUndefined();
    expect(second.get(job.id)?.state).toBe('cancelled');
  });

  it('creates missing parent directories for the database file', () => {
    const path = join(tempDir(), 'nested', 'deeper', 'jobs.sqlite');
    const store = track(new SqliteJobStore(path));
    store.create(newJob(), OPENS, NOW);
    expect(existsSync(path)).toBe(true);
  });

  it('rejects an empty or non-string location', () => {
    expect(() => new SqliteJobStore('')).toThrow();
    expect(() => new SqliteJobStore(undefined as never)).toThrow();
  });

  it('close() is idempotent and a closed store refuses work', () => {
    const store = new SqliteJobStore(':memory:');
    store.close();
    expect(() => store.close()).not.toThrow();
    expect(() => store.list()).toThrow();
  });

  it(':memory: stores are independent of each other', () => {
    const a = track(new SqliteJobStore(':memory:'));
    const b = track(new SqliteJobStore(':memory:'));
    a.create(newJob(), OPENS, NOW);
    a.setStopped(true);
    expect(b.list()).toEqual([]);
    expect(b.isStopped()).toBe(false);
  });
});

describe('connection settings', () => {
  it('uses the write-ahead log, persisted in the file', () => {
    const path = tempDbPath();
    track(new SqliteJobStore(path));
    expect(rawDb(path).prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
  });

  it('applyConnectionPragmas switches on foreign keys, WAL and a busy timeout', () => {
    const db = rawDb(tempDbPath('pragmas.sqlite'));
    applyConnectionPragmas(db);
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
  });
});

describe('versioned migrations', () => {
  it('records the applied versions in a migration table and does not re-apply them on reopen', () => {
    const path = tempDbPath();
    const store = new SqliteJobStore(path);
    store.close();
    track(new SqliteJobStore(path));
    const rows = rawDb(path).prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    expect(rows.map((row) => ({ ...row }))).toEqual(MIGRATIONS.map((migration) => ({ version: migration.version, name: migration.name })));
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS.length);
    expect(track(new SqliteJobStore(':memory:')).schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
  });

  it('migration versions are 1..n without gaps', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(MIGRATIONS.map((_, index) => index + 1));
  });

  it('the unique index predicate lists exactly ACTIVE_JOB_STATES and the state check lists every state', () => {
    const path = tempDbPath();
    track(new SqliteJobStore(path));
    const schema = (name: string): string =>
      (rawDb(path).prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string }).sql;
    const quoted = (sql: string): string[] => [...sql.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] as string).sort();

    const index = schema('jobs_one_active_per_game_date');
    expect(index).toMatch(/^CREATE UNIQUE INDEX/i);
    expect(quoted(index.split(/WHERE/i)[1] ?? '')).toEqual([...ACTIVE_JOB_STATES].sort());
    for (const state of JOB_STATES) expect(schema('jobs')).toContain(`'${state}'`);
  });

  it('refuses a database written by a newer schema and releases the file', () => {
    const path = tempDbPath();
    new SqliteJobStore(path).close();
    const raw = rawDb(path);
    raw.exec(`INSERT INTO schema_migrations (version, name) VALUES (${LATEST_SCHEMA_VERSION + 1}, 'from the future')`);
    expect(() => new SqliteJobStore(path)).toThrow(JobStoreSchemaError);
    expect(() => new SqliteJobStore(path)).toThrow(/newer/);
  });

  it('refuses a migration table with gaps or unreadable versions', () => {
    const gappy = tempDbPath();
    new SqliteJobStore(gappy).close();
    rawDb(gappy).exec("INSERT INTO schema_migrations (version, name) VALUES (3, 'gap')");
    expect(() => new SqliteJobStore(gappy)).toThrow(JobStoreSchemaError);

    const garbled = tempDbPath();
    const raw = rawDb(garbled);
    raw.exec('CREATE TABLE schema_migrations (version TEXT, name TEXT)');
    raw.exec("INSERT INTO schema_migrations (version, name) VALUES ('abc', 'bad')");
    expect(() => new SqliteJobStore(garbled)).toThrow(JobStoreSchemaError);
  });

  it('applies migrations atomically: a failing migration leaves no migration table behind', () => {
    const path = tempDbPath();
    const raw = rawDb(path);
    raw.exec('CREATE TABLE jobs (id INTEGER)');
    expect(() => new SqliteJobStore(path)).toThrow(/already exists/);
    const left = raw.prepare("SELECT name FROM sqlite_master WHERE name IN ('schema_migrations', 'meta', 'jobs_by_state')").all();
    expect(left).toEqual([]);
  });
});

describe('migrate() on a long-lived connection', () => {
  it('rolls the transaction back on failure, leaving the connection usable and no migration table behind', () => {
    const db = rawDb(tempDbPath());
    db.exec('CREATE TABLE jobs (id INTEGER)');
    expect(() => migrate(db)).toThrow(/already exists/);
    expect(() => db.exec('BEGIN')).not.toThrow();
    db.exec('ROLLBACK');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").all()).toEqual([]);
  });

  it('is idempotent and reports the latest version', () => {
    const db = rawDb(tempDbPath());
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toMatchObject({ n: LATEST_SCHEMA_VERSION });
  });
});

describe('emergency stop flag', () => {
  it('is off by default, toggles and survives reopening', () => {
    const path = tempDbPath();
    const first = new SqliteJobStore(path);
    expect(first.isStopped()).toBe(false);
    first.setStopped(true);
    first.setStopped(true);
    expect(first.isStopped()).toBe(true);
    first.close();
    const second = track(new SqliteJobStore(path));
    expect(second.isStopped()).toBe(true);
    second.setStopped(false);
    expect(second.isStopped()).toBe(false);
    second.close();
    expect(track(new SqliteJobStore(path)).isStopped()).toBe(false);
  });

  it('does not block storing or transitioning jobs (the sniper reads the flag, the store only keeps it)', () => {
    const store = track(new SqliteJobStore(':memory:'));
    store.setStopped(true);
    const job = store.create(newJob(), OPENS, NOW);
    expect(store.transition(job.id, 'scheduled', 'warming', NOW)?.state).toBe('warming');
  });

  it('accepts only real booleans (a truthy string must not silently set or clear the flag)', () => {
    const store = track(new SqliteJobStore(':memory:'));
    for (const bad of ['false', 'true', 0, 1, null, undefined]) {
      expect(() => store.setStopped(bad as never), String(bad)).toThrow(InvalidJobInputError);
    }
    expect(store.isStopped()).toBe(false);
  });
});
