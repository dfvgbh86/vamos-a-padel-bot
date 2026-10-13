import { afterEach, describe, expect, it } from 'vitest';
import { buildHolidaySet } from '../../src/config/holidays.js';
import { createJobService } from '../../src/jobs/service.js';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { cleanupTemp, date, driveTo, makeApi, makeClock, makeLogger, tempDbPath, track } from './_helpers.js';
import { created, request } from './_service.js';

afterEach(cleanupTemp);

const serviceOn = (path: string) => {
  const store = new SqliteJobStore(path);
  const service = createJobService({
    store,
    api: makeApi(),
    clock: makeClock(),
    holidays: buildHolidaySet(undefined),
    logger: makeLogger(),
  });
  return { store, service };
};

describe('jobs created through the service survive a restart', () => {
  it('keeps jobs, their states, the stop flag and the one-job-per-date rule', async () => {
    const path = tempDbPath();
    const first = serviceOn(path);
    const open = created(await first.service.createJob(request())).job;
    const later = created(await first.service.createJob(request({ gameDate: date('2026-10-21'), choices: [{ courtId: 10, startMinutes: 600 }] }))).job;
    driveTo(first.store, open.id, 'warming');
    first.service.stopAll();
    const before = first.service.listJobs();
    first.store.close();

    const second = serviceOn(path);
    track(second.store);
    expect(second.service.listJobs()).toEqual(before);
    const report = await second.service.status();
    expect(report.stopped).toBe(true);
    expect(report.activeJobs.map((job) => [job.id, job.state])).toEqual([
      [open.id, 'warming'],
      [later.id, 'scheduled'],
    ]);
    expect(await second.service.createJob(request())).toMatchObject({ kind: 'rejected', reason: 'duplicate_active_job' });
    expect(await second.service.cancelJob(later.id)).toMatchObject({ kind: 'cancelled' });
    expect(created(await second.service.createJob(request({ gameDate: date('2026-10-21') }))).job.id).toBe(later.id + 1);
  });
});
