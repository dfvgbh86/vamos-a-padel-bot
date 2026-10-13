import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/jobs/migrations.js';
import { InvalidJobInputError } from '../../src/jobs/errors.js';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { cleanupTemp, date, driveTo, newJob, NOW, rawDb, tempDbPath, track } from './_helpers.js';

afterEach(cleanupTemp);

const OPENS = Date.UTC(2026, 9, 13, 5, 0, 0);
const WISH = { courtId: 9, startMinutes: 1080 };

const book = (store: SqliteJobStore, day: string, nowMs: number) => {
  const job = store.create(newJob({ gameDate: date(day) }), OPENS, NOW);
  driveTo(store, job.id, 'firing');
  store.transition(job.id, 'firing', 'booked', nowMs, { bookedChoice: WISH });
  return job.id;
};

const fail = (store: SqliteJobStore, day: string, nowMs: number, reason = 'daily_limit') => {
  const job = store.create(newJob({ gameDate: date(day) }), OPENS, NOW);
  store.transition(job.id, 'scheduled', 'failed', nowMs, { failureReason: reason });
  return job.id;
};

describe('the ledger of delivered results', () => {
  it('lists booked, needs_payment and failed jobs nobody confirmed, and nothing else', () => {
    const store = track(new SqliteJobStore(':memory:'));
    const booked = book(store, '2026-10-20', NOW + 10);
    const failed = fail(store, '2026-10-21', NOW + 20);
    const card = store.create(newJob({ gameDate: date('2026-10-22'), payment: 'card' }), OPENS, NOW);
    driveTo(store, card.id, 'firing');
    store.transition(card.id, 'firing', 'needs_payment', NOW + 30);
    store.create(newJob({ gameDate: date('2026-10-23') }), OPENS, NOW);
    const cancelled = store.create(newJob({ gameDate: date('2026-10-24') }), OPENS, NOW);
    store.transition(cancelled.id, 'scheduled', 'cancelled', NOW + 40);

    expect(store.unannouncedResults(0).map((job) => job.id)).toEqual([booked, failed, card.id]);
  });

  it('markAnnounced removes a job from the list, and only for the state that was announced', () => {
    const store = track(new SqliteJobStore(':memory:'));
    const id = fail(store, '2026-10-20', NOW + 10);
    store.markAnnounced(id, 'failed');
    expect(store.unannouncedResults(0)).toEqual([]);

    store.markAnnounced(id, 'booked');
    expect(store.unannouncedResults(0).map((job) => job.id)).toEqual([id]);
  });

  it('a late booking after an announced failure is listed again (the booked result was never delivered)', () => {
    const store = track(new SqliteJobStore(':memory:'));
    const job = store.create(newJob(), OPENS, NOW);
    driveTo(store, job.id, 'firing');
    store.transition(job.id, 'firing', 'failed', NOW + 10, { failureReason: 'ambiguous_unresolved' });
    store.markAnnounced(job.id, 'failed');
    expect(store.unannouncedResults(0)).toEqual([]);

    store.transition(job.id, 'failed', 'booked', NOW + 20, { bookedChoice: WISH });
    expect(store.unannouncedResults(0).map((listed) => listed.state)).toEqual(['booked']);
  });

  it('only results updated since the given time are listed', () => {
    const store = track(new SqliteJobStore(':memory:'));
    const old = fail(store, '2026-10-20', 1000);
    const recent = fail(store, '2026-10-21', 5000);
    expect(store.unannouncedResults(2000).map((job) => job.id)).toEqual([recent]);
    expect(store.unannouncedResults(0).map((job) => job.id)).toEqual([old, recent]);
  });

  it('the mark survives a restart', () => {
    const path = tempDbPath();
    const first = new SqliteJobStore(path);
    const delivered = book(first, '2026-10-20', NOW + 10);
    const lost = fail(first, '2026-10-21', NOW + 20);
    first.markAnnounced(delivered, 'booked');
    first.close();

    const second = track(new SqliteJobStore(path));
    expect(second.unannouncedResults(0).map((job) => job.id)).toEqual([lost]);
  });

  it('refuses nonsense instead of writing it', () => {
    const store = track(new SqliteJobStore(':memory:'));
    expect(() => store.markAnnounced(1.5, 'failed')).toThrow(InvalidJobInputError);
    expect(() => store.markAnnounced(1, 'scheduled' as never)).toThrow(InvalidJobInputError);
    expect(() => store.unannouncedResults(Number.NaN)).toThrow(InvalidJobInputError);
  });

  it('jobs read back exactly as before: the ledger column is not part of a Job', () => {
    const store = track(new SqliteJobStore(':memory:'));
    const id = book(store, '2026-10-20', NOW + 10);
    store.markAnnounced(id, 'booked');
    expect(Object.keys(store.get(id) ?? {})).not.toContain('notifiedState');
    expect(Object.keys(store.get(id) ?? {})).not.toContain('notified_state');
  });
});

describe('migration 2 on a database from before the ledger existed', () => {
  const v1Database = (): string => {
    const path = tempDbPath();
    const raw = rawDb(path);
    const first = MIGRATIONS[0];
    if (first === undefined) throw new Error('no migration');
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    raw.exec(first.sql);
    raw.exec(`INSERT INTO schema_migrations (version, name) VALUES (1, '${first.name}')`);
    const insert = raw.prepare(
      `INSERT INTO jobs (game_date, choices, duration_minutes, payment, state, opens_at_ms, attempts, created_at_ms, updated_at_ms)
       VALUES (?, '[{"courtId":9,"startMinutes":1080}]', 90, 'wallet', ?, ?, 1, ?, ?)`,
    );
    insert.run('2026-10-20', 'booked', OPENS, NOW, NOW);
    insert.run('2026-10-21', 'failed', OPENS, NOW, NOW);
    insert.run('2026-10-22', 'scheduled', OPENS, NOW, NOW);
    raw.close();
    return path;
  };

  it('treats every result of the past as delivered (no flood of old messages after the upgrade)', () => {
    const store = track(new SqliteJobStore(v1Database()));
    expect(store.unannouncedResults(0)).toEqual([]);
    expect(store.list().map((job) => job.state)).toEqual(['booked', 'failed', 'scheduled']);
  });

  it('results after the upgrade are tracked from then on', () => {
    const store = track(new SqliteJobStore(v1Database()));
    const id = fail(store, '2026-10-25', NOW + 100);
    expect(store.unannouncedResults(0).map((job) => job.id)).toEqual([id]);
  });
});
