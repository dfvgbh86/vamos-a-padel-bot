import { describe, expect, it } from 'vitest';
import { parseGameDate } from '../../src/config/gameDate.js';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { closable, createCliRig, SITE_ENV } from './_cli.js';
import { OPENS_MS, PASSWORD, START_MS } from './_rig.js';
import { SITE_HASH } from './_site.js';

const DAY = parseGameDate('2026-10-20');

const arm = (store: SqliteJobStore, gameDate = DAY, courtId = 9) =>
  store.create({ gameDate, choices: [{ courtId, startMinutes: 1080 }, { courtId: 10, startMinutes: 1170 }], durationMinutes: 90, payment: 'wallet' }, OPENS_MS, START_MS);

describe('status', () => {
  it('prints the stop flag, session, wallet, next window, holidays and the active jobs', async () => {
    const rig = createCliRig();
    const store = new SqliteJobStore(':memory:');
    arm(store);
    const wrapped = closable(store);
    const result = await rig.run(['status'], { openStore: () => wrapped });

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const lines = result.out.split('\n');
    expect(lines).toContain('Emergency stop: off');
    expect(lines).toContain('Session: alive');
    expect(lines).toContain('Wallet: 50.00 EUR');
    expect(lines).toContain('Next window opens: 2026-10-13 07:00 Madrid');
    expect(lines).toContain('Holidays in the next 30 days: none');
    expect(lines).toContain('Active jobs: 1');
    expect(lines).toContain('  #1  2026-10-20  scheduled  90 min  wallet  Pista 7 semicubierta 18:00, Pista 8 exterior 19:30');
    expect(result.out).not.toContain('Recent finished jobs');
    expect(wrapped.closed).toBe(true);
  });

  it('shows the emergency stop in capitals with the way out', async () => {
    const rig = createCliRig();
    const store = new SqliteJobStore(':memory:');
    store.setStopped(true);
    const result = await rig.run(['status'], { openStore: () => closable(store) });
    expect(result.out).toContain('Emergency stop: ON (no booking requests are sent; /resume in Telegram lifts it)');
    expect(result.out).toContain('Active jobs: 0');
    expect(result.out).toContain('Next window opens: no armed jobs');
  });

  it('lists a booked job among the active ones and the finished jobs separately, most recent first', async () => {
    const rig = createCliRig();
    const store = new SqliteJobStore(':memory:');
    const booked = arm(store, parseGameDate('2026-10-19'));
    store.transition(booked.id, 'scheduled', 'warming', START_MS);
    store.transition(booked.id, 'warming', 'firing', START_MS, { attemptsDelta: 1 });
    store.transition(booked.id, 'firing', 'booked', START_MS + 1000, { bookedChoice: { courtId: 9, startMinutes: 1080 }, reservationId: 100_002 });
    const failed = arm(store, parseGameDate('2026-10-18'));
    store.transition(failed.id, 'scheduled', 'failed', START_MS + 2000, { failureReason: 'no_funds' });
    const cancelled = arm(store, parseGameDate('2026-10-17'));
    store.transition(cancelled.id, 'scheduled', 'cancelled', START_MS + 500);
    const result = await rig.run(['status'], { openStore: () => closable(store) });

    const lines = result.out.split('\n');
    const at =(prefix: string): number => lines.findIndex((line) => line.startsWith(prefix));
    const finished = at('Recent finished jobs:');
    expect(finished).toBeGreaterThan(at('Active jobs: 1'));
    expect(at('  #1 ')).toBeLessThan(finished);
    expect(lines[at('  #1 ')]).toContain('booked  90 min  wallet');
    expect(lines[at('  #1 ')]).toContain('-> booked Pista 7 semicubierta 18:00 (reservation 100002)');
    expect(lines[at('  #2 ')]).toContain('failed');
    expect(lines[at('  #2 ')]).toContain('[no_funds]');
    expect(at('  #2 ')).toBeGreaterThan(finished);
    expect(at('  #3 ')).toBeGreaterThan(at('  #2 '));
  });

  it('reports a dead session and carries on', async () => {
    const rig = createCliRig();
    rig.site.loginFails = true;
    const store = new SqliteJobStore(':memory:');
    const result = await rig.run(['status'], { openStore: () => closable(store) });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Session: not active');
    expect(result.out).toContain('Wallet: could not be read');
    expect(result.err).toContain('Could not log in: The site did not accept the login');
  });

  it('does not open the database when the site client cannot be built, and prints no message of the error', async () => {
    const rig = createCliRig();
    let opened = 0;
    const result = await rig.run(['status'], {
      openStore: () => {
        opened++;
        return closable(new SqliteJobStore(':memory:'));
      },
      createApi: () => {
        throw new Error(`broken ${PASSWORD}`);
      },
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe('Unexpected error (Error).\n');
    expect(opened).toBe(0);
  });

  it('closes the database when the report itself fails', async () => {
    const rig = createCliRig();
    const wrapped = closable(new SqliteJobStore(':memory:'));
    const broken = { ...wrapped, list: () => { throw new Error('database is locked'); }, close: wrapped.close };
    const result = await rig.run(['status'], { openStore: () => broken });
    expect(result.code).toBe(1);
    expect(wrapped.closed).toBe(true);
  });

  it('opens the database at DB_PATH, resolved against the working directory', async () => {
    const rig = createCliRig({ ...SITE_ENV, DB_PATH: 'var/test.sqlite' });
    const opened: string[] = [];
    await rig.run(['status'], {
      openStore: (location) => {
        opened.push(location);
        return closable(new SqliteJobStore(':memory:'));
      },
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/var[\\/]test\.sqlite$/);
    expect(opened[0]).not.toBe('var/test.sqlite');
  });

  it('fails without opening the database when the account is not configured', async () => {
    const rig = createCliRig({});
    const opened: string[] = [];
    const result = await rig.run(['status'], {
      openStore: (location) => {
        opened.push(location);
        return closable(new SqliteJobStore(':memory:'));
      },
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain('missing: RESERVAPLAY_USERNAME, RESERVAPLAY_PASSWORD');
    expect(opened).toEqual([]);
  });

  it('never prints the password, the hash or a cookie', async () => {
    const rig = createCliRig();
    const store = new SqliteJobStore(':memory:');
    arm(store);
    const result = await rig.run(['status'], { openStore: () => closable(store) });
    const everything = result.out + result.err;
    for (const secret of [PASSWORD, SITE_HASH]) expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/laravel_session|XSRF|cookie/i);
  });
});
