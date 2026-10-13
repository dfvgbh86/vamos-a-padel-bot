/**
 * A booking result must reach the owner even when Telegram is unreachable for a long time or the bot restarts before
 * the message went out. The whole app is real; the site, the clock and Telegram are fakes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { MINUTE, OPENS_MS, createRig, messagesWith, type Rig } from './_rig.js';

const WISH = [{ court: 'Pista 7', time: '18:00' }] as const;
const DAY = 'вт 20.10';

const rigs: Rig[] = [];
const stores: SqliteJobStore[] = [];

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.stop();
  for (const store of stores.splice(0)) store.close();
});

const sharedStore = (): SqliteJobStore => {
  const store = new SqliteJobStore(':memory:');
  stores.push(store);
  return Object.assign(store, { close: () => undefined });
};

const rigOn = (store: SqliteJobStore, startMs?: number): Rig => {
  const rig = createRig({
    store,
    latency: { probeForm: 300, book: 1900 },
    overrides: { notificationDrainMs: 1 },
    ...(startMs === undefined ? {} : { startMs }),
  });
  rigs.push(rig);
  return rig;
};

describe('results that Telegram could not take', () => {
  it('are announced after a restart, exactly once, and never again after that', async () => {
    const store = sharedStore();
    const first = rigOn(store);
    await first.start();
    await first.owner.createJob(DAY, WISH);
    await first.runTo(OPENS_MS - 5 * MINUTE);
    first.transport.setOffline(true);
    await first.runPastOpening(60_000);

    expect(first.site.addEvents).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({ state: 'booked' });
    expect(store.unannouncedResults(0).map((job) => job.state)).toEqual(['booked']);
    await first.stop();
    rigs.splice(rigs.indexOf(first), 1);

    const second = rigOn(store, OPENS_MS + 10 * MINUTE);
    await second.start();
    const [announced] = messagesWith(second, 'ЗАБРОНИРОВАНО');
    expect(announced?.text).toContain('Pista 7 semicubierta');
    expect(messagesWith(second, 'ЗАБРОНИРОВАНО')).toHaveLength(1);
    expect(store.unannouncedResults(0)).toEqual([]);
    expect(second.logText()).toContain('never confirmed as delivered');
    await second.stop();
    rigs.splice(rigs.indexOf(second), 1);

    const third = rigOn(store, OPENS_MS + 20 * MINUTE);
    await third.start();
    expect(messagesWith(third, 'ЗАБРОНИРОВАНО')).toHaveLength(0);
  });

  it('are retried for hours in the background and recorded as delivered once Telegram is back', async () => {
    const store = sharedStore();
    const rig = rigOn(store);
    await rig.start();
    await rig.owner.createJob(DAY, WISH);
    await rig.runTo(OPENS_MS - 5 * MINUTE);
    rig.transport.setOffline(true);
    await rig.runPastOpening(10 * MINUTE);
    expect(store.unannouncedResults(0)).toHaveLength(1);
    const attemptsWhileOffline = messagesWith(rig, 'ЗАБРОНИРОВАНО').length;
    expect(attemptsWhileOffline).toBeGreaterThan(5);

    rig.transport.setOffline(false);
    await rig.runPastOpening(60 * MINUTE);
    expect(store.unannouncedResults(0)).toEqual([]);
    expect(messagesWith(rig, 'ЗАБРОНИРОВАНО').length).toBeGreaterThan(attemptsWhileOffline);
  });

  it('a result that was delivered at once is recorded as delivered', async () => {
    const store = sharedStore();
    const rig = rigOn(store);
    await rig.start();
    await rig.owner.createJob(DAY, WISH);
    await rig.runPastOpening(60_000);
    expect(store.list()[0]?.state).toBe('booked');
    expect(store.unannouncedResults(0)).toEqual([]);
  });

  it('a failure the owner was told about is not announced again at the next start', async () => {
    const store = sharedStore();
    const rig = rigOn(store);
    rig.site.walletCents = 500;
    await rig.start();
    await rig.owner.createJob(DAY, WISH);
    await rig.runPastOpening(2 * MINUTE);
    expect(store.list()[0]).toMatchObject({ state: 'failed' });
    expect(store.unannouncedResults(0)).toEqual([]);
  });
});
