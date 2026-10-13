import {
  DuplicateActiveJobError,
  type Job,
  type JobPatch,
  type JobState,
  type JobStore,
  type NewJob,
} from '../contracts.js';
import { InvalidJobInputError } from './errors.js';
import { ANNOUNCED_STATES, type AnnouncedState, type ResultLedger } from '../sniper/announce.js';
import { LATEST_SCHEMA_VERSION, migrate } from './migrations.js';
import { parseJobRow, parseStoppedFlag, validateNewJob, validateTransitionArgs } from './rows.js';
import { openDatabase, type SqliteDatabase } from './sqlite.js';
import { isJobState, transitionSources } from './transitions.js';

const SQLITE_CONSTRAINT_UNIQUE = 2067;

const SQL = {
  insert: `
    INSERT INTO jobs (game_date, choices, duration_minutes, payment, state, opens_at_ms, attempts, created_at_ms, updated_at_ms)
    VALUES (:game_date, :choices, :duration_minutes, :payment, 'scheduled', :opens_at_ms, 0, :now_ms, :now_ms)
    RETURNING *`,
  byId: 'SELECT * FROM jobs WHERE id = :id',
  all: 'SELECT * FROM jobs ORDER BY id',
  byStates: 'SELECT * FROM jobs WHERE state IN (SELECT value FROM json_each(:states)) ORDER BY id',
  transition: `
    UPDATE jobs SET
      state = :to,
      updated_at_ms = :now_ms,
      reservation_id = COALESCE(:reservation_id, reservation_id),
      booked_choice = COALESCE(:booked_choice, booked_choice),
      failure_reason = COALESCE(:failure_reason, failure_reason),
      attempts = attempts + :attempts_delta
    WHERE id = :id AND state IN (SELECT value FROM json_each(:sources))
    RETURNING *`,
  unannounced: `
    SELECT * FROM jobs
    WHERE state IN ('booked', 'needs_payment', 'failed')
      AND updated_at_ms >= :since_ms
      AND (notified_state IS NULL OR notified_state != state)
    ORDER BY id`,
  markAnnounced: 'UPDATE jobs SET notified_state = :state WHERE id = :id',
  readMeta: 'SELECT value FROM meta WHERE key = :key',
  writeMeta: 'INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
} as const;

const prepareAll = (db: SqliteDatabase) => ({
  insert: db.prepare(SQL.insert),
  byId: db.prepare(SQL.byId),
  all: db.prepare(SQL.all),
  byStates: db.prepare(SQL.byStates),
  transition: db.prepare(SQL.transition),
  unannounced: db.prepare(SQL.unannounced),
  markAnnounced: db.prepare(SQL.markAnnounced),
  readMeta: db.prepare(SQL.readMeta),
  writeMeta: db.prepare(SQL.writeMeta),
});

type Statements = ReturnType<typeof prepareAll>;

const isActiveDateViolation = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const { errcode } = error as { errcode?: unknown };
  const codeMatches = errcode === undefined || errcode === SQLITE_CONSTRAINT_UNIQUE;
  return codeMatches && /UNIQUE constraint failed: jobs\.game_date/.test(error.message);
};

const STOPPED_KEY = 'stopped';

/** Jobs and the emergency-stop flag on node:sqlite. Synchronous by design: every operation is one atomic statement. */
export class SqliteJobStore implements JobStore, ResultLedger {
  private readonly db: SqliteDatabase;
  private readonly sql: Statements;
  private closed = false;

  constructor(location: string) {
    this.db = openDatabase(location);
    try {
      migrate(this.db);
      this.sql = prepareAll(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  schemaVersion(): number {
    return LATEST_SCHEMA_VERSION;
  }

  create(job: NewJob, opensAtMs: number, nowMs: number): Job {
    const input = validateNewJob(job, opensAtMs, nowMs);
    try {
      return parseJobRow(
        this.sql.insert.get({
          game_date: input.job.gameDate,
          choices: JSON.stringify(input.job.choices),
          duration_minutes: input.job.durationMinutes,
          payment: input.job.payment,
          opens_at_ms: input.opensAtMs,
          now_ms: input.nowMs,
        }),
      );
    } catch (error) {
      if (isActiveDateViolation(error)) throw new DuplicateActiveJobError(input.job.gameDate);
      throw error;
    }
  }

  get(id: number): Job | undefined {
    if (!Number.isSafeInteger(id)) return undefined;
    const row = this.sql.byId.get({ id });
    return row === undefined ? undefined : parseJobRow(row);
  }

  list(filter?: { readonly states?: readonly JobState[] }): readonly Job[] {
    const states = filter?.states;
    if (states === undefined) return this.sql.all.all().map((row) => parseJobRow(row));
    if (!Array.isArray(states) || !states.every(isJobState)) throw new InvalidJobInputError(['states'], 'list');
    return this.sql.byStates.all({ states: JSON.stringify([...new Set(states)]) }).map((row) => parseJobRow(row));
  }

  transition(
    id: number,
    from: JobState | readonly JobState[],
    to: JobState,
    nowMs: number,
    patch: JobPatch = {},
  ): Job | undefined {
    const sources = transitionSources(from, to);
    const params = validateTransitionArgs(nowMs, patch);
    if (sources.length === 0 || !Number.isSafeInteger(id)) return undefined;
    try {
      const row = this.sql.transition.get({ ...params, id, to, sources: JSON.stringify(sources) });
      return row === undefined ? undefined : parseJobRow(row);
    } catch (error) {
      // A finished job recording a late booking while another active job holds its date: nothing is applied.
      if (isActiveDateViolation(error)) return undefined;
      throw error;
    }
  }

  /** Jobs in a result state (booked, needs_payment, failed) whose result was never confirmed as delivered to the owner. */
  unannouncedResults(sinceMs: number): readonly Job[] {
    if (!Number.isFinite(sinceMs)) throw new InvalidJobInputError(['sinceMs'], 'unannouncedResults');
    return this.sql.unannounced.all({ since_ms: Math.max(0, Math.trunc(sinceMs)) }).map((row) => parseJobRow(row));
  }

  markAnnounced(jobId: number, state: AnnouncedState): void {
    if (!Number.isSafeInteger(jobId) || !ANNOUNCED_STATES.includes(state)) throw new InvalidJobInputError(['markAnnounced'], 'markAnnounced');
    this.sql.markAnnounced.run({ id: jobId, state });
  }

  isStopped(): boolean {
    return parseStoppedFlag(this.sql.readMeta.get({ key: STOPPED_KEY }));
  }

  setStopped(stopped: boolean): void {
    if (typeof stopped !== 'boolean') throw new InvalidJobInputError(['stopped'], 'setStopped');
    this.sql.writeMeta.run({ key: STOPPED_KEY, value: stopped ? '1' : '0' });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export const openJobStore = (location: string): SqliteJobStore => new SqliteJobStore(location);
