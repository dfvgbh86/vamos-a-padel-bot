import { z } from 'zod';
import { JobStoreSchemaError } from './errors.js';
import type { SqliteDatabase } from './sqlite.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  /** Frozen snapshot: never edit a released migration, append a new one. */
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs and meta',
    sql: `
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_date TEXT NOT NULL,
        choices TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
        payment TEXT NOT NULL CHECK (payment IN ('wallet', 'card')),
        state TEXT NOT NULL CHECK (state IN
          ('scheduled', 'warming', 'firing', 'booked', 'needs_payment', 'failed', 'cancelled', 'expired')),
        opens_at_ms INTEGER NOT NULL,
        reservation_id INTEGER,
        booked_choice TEXT,
        failure_reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX jobs_one_active_per_game_date ON jobs (game_date)
        WHERE state IN ('scheduled', 'warming', 'firing', 'booked', 'needs_payment');
      CREATE INDEX jobs_by_state ON jobs (state);
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'delivery of results',
    sql: `
      ALTER TABLE jobs ADD COLUMN notified_state TEXT
        CHECK (notified_state IN ('booked', 'needs_payment', 'failed'));
      UPDATE jobs SET notified_state = state WHERE state IN ('booked', 'needs_payment', 'failed');
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

const appliedRowsSchema = z.array(z.object({ version: z.number().int().positive() }));

const readAppliedVersions = (db: SqliteDatabase): readonly number[] => {
  const parsed = appliedRowsSchema.safeParse(
    db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => ({ ...row })),
  );
  if (!parsed.success) throw new JobStoreSchemaError('schema_migrations table is unreadable');
  return parsed.data.map((row) => row.version);
};

const currentVersion = (db: SqliteDatabase): number => {
  const applied = readAppliedVersions(db);
  if (applied.some((version, index) => version !== index + 1)) {
    throw new JobStoreSchemaError('schema_migrations has gaps or duplicates: the database was not created by this bot');
  }
  if (applied.length > LATEST_SCHEMA_VERSION) {
    throw new JobStoreSchemaError(
      `Database schema version ${applied.length} is newer than the supported ${LATEST_SCHEMA_VERSION}: update the bot`,
    );
  }
  return applied.length;
};

/** A failed statement may already have ended the transaction; the original error is the one worth reporting. */
const rollbackQuietly = (db: SqliteDatabase): void => {
  try {
    db.exec('ROLLBACK');
  } catch {
    return;
  }
};

/** Applies pending migrations in one write transaction; safe when two processes open the same file at once. */
export const migrate = (db: SqliteDatabase): number => {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    const from = currentVersion(db);
    const insert = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');
    for (const migration of MIGRATIONS.slice(from)) {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name);
    }
    db.exec('COMMIT');
    return LATEST_SCHEMA_VERSION;
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
};
