import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

// vite-node (vitest 2.x) rewrites the built-in `node:sqlite` to the unresolvable `sqlite`; require() keeps it intact.
const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type SqliteDatabase = DatabaseSync;

export const IN_MEMORY = ':memory:';

const BUSY_TIMEOUT_MS = 5000;

export const applyConnectionPragmas = (db: SqliteDatabase): void => {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
};

/** Opens (creating the parent directory when needed) a database file, or `:memory:`, with the connection pragmas applied. */
export const openDatabase = (location: string): SqliteDatabase => {
  if (typeof location !== 'string' || location.length === 0) throw new Error('Job store location must be a non-empty path');
  if (location !== IN_MEMORY) mkdirSync(dirname(location), { recursive: true });
  const db = new sqlite.DatabaseSync(location);
  try {
    applyConnectionPragmas(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
};
