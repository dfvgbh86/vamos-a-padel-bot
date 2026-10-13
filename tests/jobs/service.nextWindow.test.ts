import { afterEach, describe, expect, it } from 'vitest';
import type { JobState } from '../../src/contracts.js';
import { cleanupTemp, date, driveTo, HOUR, newJob, NOW } from './_helpers.js';
import { harness } from './_service.js';

afterEach(cleanupTemp);

describe('status().nextWindowOpensAtMs', () => {
  const addJob = (h: ReturnType<typeof harness>, day: string, opensAtMs: number, state: JobState = 'scheduled') => {
    const job = h.store.create(newJob({ gameDate: date(day) }), opensAtMs, NOW);
    driveTo(h.store, job.id, state);
  };

  it('is the earliest future opening among scheduled and warming jobs', async () => {
    const h = harness();
    addJob(h, '2026-10-22', NOW + 3 * HOUR);
    addJob(h, '2026-10-23', NOW + HOUR);
    addJob(h, '2026-10-24', NOW + 2 * HOUR);
    expect((await h.service.status()).nextWindowOpensAtMs).toBe(NOW + HOUR);
  });

  it('ignores windows that are already open or opening right now', async () => {
    const h = harness();
    addJob(h, '2026-10-22', NOW - HOUR);
    addJob(h, '2026-10-23', NOW);
    addJob(h, '2026-10-24', NOW + 5 * HOUR);
    expect((await h.service.status()).nextWindowOpensAtMs).toBe(NOW + 5 * HOUR);
  });

  it('still counts a job that is warming up for its window (the preflight starts about 10 minutes before it)', async () => {
    const h = harness();
    addJob(h, '2026-10-22', NOW + 9 * 60_000, 'warming');
    expect((await h.service.status()).nextWindowOpensAtMs).toBe(NOW + 9 * 60_000);
    addJob(h, '2026-10-23', NOW + 30 * 60_000);
    expect((await h.service.status()).nextWindowOpensAtMs).toBe(NOW + 9 * 60_000);
  });

  it('ignores a warming job whose window is already open', async () => {
    const h = harness();
    addJob(h, '2026-10-22', NOW - 1000, 'warming');
    expect((await h.service.status()).nextWindowOpensAtMs).toBeNull();
  });

  it('ignores jobs that are not waiting for their window', async () => {
    const h = harness();
    addJob(h, '2026-10-22', NOW + HOUR, 'firing');
    addJob(h, '2026-10-23', NOW + HOUR, 'booked');
    addJob(h, '2026-10-24', NOW + HOUR, 'needs_payment');
    addJob(h, '2026-10-25', NOW + HOUR, 'cancelled');
    addJob(h, '2026-10-26', NOW + HOUR, 'failed');
    addJob(h, '2026-10-27', NOW + HOUR, 'expired');
    expect((await h.service.status()).nextWindowOpensAtMs).toBeNull();
  });

  it('is null when nothing is scheduled in the future', async () => {
    const h = harness();
    addJob(h, '2026-10-22', NOW - 2 * HOUR);
    expect((await h.service.status()).nextWindowOpensAtMs).toBeNull();
  });

  it('moves with the injected clock', async () => {
    const h = harness();
    addJob(h, '2026-10-22', NOW + HOUR);
    expect((await h.service.status()).nextWindowOpensAtMs).toBe(NOW + HOUR);
    h.clock.advance(HOUR);
    expect((await h.service.status()).nextWindowOpensAtMs).toBeNull();
  });
});
