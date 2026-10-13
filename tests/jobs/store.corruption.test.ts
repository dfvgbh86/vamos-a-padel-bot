import { afterEach, describe, expect, it } from 'vitest';
import { CorruptJobStoreError } from '../../src/jobs/errors.js';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { cleanupTemp, date, newJob, NOW, rawDb, tempDbPath, track } from './_helpers.js';

afterEach(cleanupTemp);

const OPENS = Date.UTC(2026, 9, 13, 5, 0, 0);
const MARKER = 'SECRET-MARKER-5f3a';

interface Fixture {
  readonly path: string;
  readonly store: SqliteJobStore;
}

/** Two good jobs; job 1 is the one that gets damaged through an independent connection. */
const fixture = (): Fixture => {
  const path = tempDbPath();
  const store = track(new SqliteJobStore(path));
  store.create(newJob(), OPENS, NOW);
  store.create(newJob({ gameDate: date('2026-10-21') }), OPENS, NOW);
  return { path, store };
};

const damage = (path: string, assignment: string): void => {
  const db = rawDb(path);
  db.exec('PRAGMA ignore_check_constraints = ON');
  db.exec(`UPDATE jobs SET ${assignment} WHERE id = 1`);
};

const cases: readonly [label: string, assignment: string, field: string][] = [
  ['choices that are not JSON', `choices = '{oops ${MARKER}'`, 'choices'],
  ['choices of the wrong shape', `choices = '[{"courtId":"${MARKER}","startMinutes":600}]'`, 'choices.0.courtId'],
  ['an empty choice list', `choices = '[]'`, 'choices'],
  ['duplicate choices', `choices = '[{"courtId":9,"startMinutes":600},{"courtId":9,"startMinutes":600}]'`, 'choices'],
  ['choices that are not a list', `choices = '{"courtId":9}'`, 'choices'],
  ['a booked choice that is not JSON', `booked_choice = 'nope ${MARKER}'`, 'booked_choice'],
  ['a booked choice of the wrong shape', `booked_choice = '{"courtId":9,"startMinutes":99999}'`, 'booked_choice.startMinutes'],
  ['a text reservation id', `reservation_id = '${MARKER}'`, 'reservation_id'],
  ['a non-positive reservation id', 'reservation_id = -4', 'reservation_id'],
  ['a negative attempt count', 'attempts = -1', 'attempts'],
  ['a text attempt count', `attempts = '${MARKER}'`, 'attempts'],
  ['an unknown state', `state = '${MARKER}'`, 'state'],
  ['an unknown payment mode', `payment = '${MARKER}'`, 'payment'],
  ['a malformed game date', `game_date = '${MARKER}'`, 'game_date'],
  ['an impossible game date', `game_date = '2026-13-45'`, 'game_date'],
  ['a text opening time', `opens_at_ms = '${MARKER}'`, 'opens_at_ms'],
  ['a negative creation time', 'created_at_ms = -1', 'created_at_ms'],
  ['a fractional update time', 'updated_at_ms = 1.5', 'updated_at_ms'],
  ['a binary failure reason', "failure_reason = X'414243'", 'failure_reason'],
  ['a zero duration', 'duration_minutes = 0', 'duration_minutes'],
];

describe('every value read from the database is validated', () => {
  it.each(cases)('%s throws a clear error from get() without leaking the stored value', (_label, assignment, field) => {
    const { path, store } = fixture();
    damage(path, assignment);
    let thrown: unknown;
    try {
      store.get(1);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CorruptJobStoreError);
    const message = (thrown as CorruptJobStoreError).message;
    expect(message).toContain('jobs row 1');
    expect(message).toContain(field);
    expect(message).not.toContain(MARKER);
    expect(JSON.stringify(thrown)).not.toContain(MARKER);
  });

  it('list() fails loudly on a damaged row instead of silently skipping it, while healthy rows stay readable', () => {
    const { path, store } = fixture();
    damage(path, `state = '${MARKER}'`);
    expect(() => store.list()).toThrow(CorruptJobStoreError);
    expect(() => store.list({ states: ['scheduled'] })).not.toThrow();
    expect(store.get(2)?.gameDate).toBe('2026-10-21');
  });

  it('transition() validates the row it returns and does not leak either', () => {
    const { path, store } = fixture();
    damage(path, `choices = '{oops ${MARKER}'`);
    let thrown: unknown;
    try {
      store.transition(1, 'scheduled', 'warming', NOW + 1);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CorruptJobStoreError);
    expect((thrown as Error).message).not.toContain(MARKER);
  });

  it('a corrupted stop flag throws instead of being read as "not stopped"', () => {
    const { path, store } = fixture();
    store.setStopped(false);
    rawDb(path).exec(`UPDATE meta SET value = '${MARKER}' WHERE key = 'stopped'`);
    let thrown: unknown;
    try {
      store.isStopped();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CorruptJobStoreError);
    expect((thrown as Error).message).not.toContain(MARKER);
  });

  it('the database itself refuses an unknown state or payment mode (CHECK constraints)', () => {
    const { path } = fixture();
    const db = rawDb(path);
    expect(() => db.exec(`UPDATE jobs SET state = 'done' WHERE id = 1`)).toThrow(/CHECK/);
    expect(() => db.exec(`UPDATE jobs SET payment = 'cash' WHERE id = 1`)).toThrow(/CHECK/);
    expect(() => db.exec(`UPDATE jobs SET attempts = -1 WHERE id = 1`)).toThrow(/CHECK/);
  });

  it('the database itself refuses a second active job for a date, even bypassing the store', () => {
    const { path } = fixture();
    const db = rawDb(path);
    expect(() =>
      db.exec(
        `INSERT INTO jobs (game_date, choices, duration_minutes, payment, state, opens_at_ms, created_at_ms, updated_at_ms)
         VALUES ('2026-10-20', '[{"courtId":9,"startMinutes":600}]', 90, 'wallet', 'firing', 1, 1, 1)`,
      ),
    ).toThrow(/UNIQUE/);
  });
});
