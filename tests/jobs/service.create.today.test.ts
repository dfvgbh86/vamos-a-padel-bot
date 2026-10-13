import { afterEach, describe, expect, it } from 'vitest';
import { apiCallCount, cleanupTemp, date } from './_helpers.js';
import { created, harness, request } from './_service.js';

afterEach(cleanupTemp);

/** Tuesday 13 Oct 2026, 14:00 in Madrid (UTC+2). */
const AFTERNOON = Date.UTC(2026, 9, 13, 12, 0, 0);
const TODAY = date('2026-10-13');
const at = (startMinutes: number, courtId = 9) => ({ courtId, startMinutes });

describe('createJob for today: a start time that has already begun is refused', () => {
  it('rejects a start earlier in the day and names both times, without touching the site or the store', async () => {
    const { service, store, api } = harness({ now: AFTERNOON });
    const result = await service.createJob(request({ gameDate: TODAY, choices: [at(480)] }));
    expect(result).toMatchObject({ kind: 'rejected', reason: 'invalid_input' });
    expect((result as { detail: string }).detail).toContain('08:00');
    expect((result as { detail: string }).detail).toContain('14:00');
    expect(store.list()).toEqual([]);
    expect(apiCallCount(api)).toBe(0);
  });

  it('a start in the current minute is already too late, the next minute is fine', async () => {
    const { service } = harness({ now: AFTERNOON });
    expect(await service.createJob(request({ gameDate: TODAY, choices: [at(840)] }))).toMatchObject({ reason: 'invalid_input' });
    expect(created(await service.createJob(request({ gameDate: TODAY, choices: [at(841)] }))).job.gameDate).toBe('2026-10-13');
  });

  it('one choice that is gone rejects the whole request, whichever position it has', async () => {
    const first = harness({ now: AFTERNOON });
    expect(await first.service.createJob(request({ gameDate: TODAY, choices: [at(600), at(1080)] }))).toMatchObject({ reason: 'invalid_input' });
    const second = harness({ now: AFTERNOON });
    expect(await second.service.createJob(request({ gameDate: TODAY, choices: [at(1080), at(600, 10)] }))).toMatchObject({ reason: 'invalid_input' });
    expect(first.store.list()).toEqual([]);
    expect(second.store.list()).toEqual([]);
  });

  it('accepts a later start today and any start on a later day', async () => {
    const { service } = harness({ now: AFTERNOON });
    created(await service.createJob(request({ gameDate: TODAY, choices: [at(1080)] })));
    created(await service.createJob(request({ gameDate: date('2026-10-14'), choices: [at(480)] })));
  });

  it('uses the club clock, not UTC: 00:30 in Madrid is still the evening before in UTC', async () => {
    const { service } = harness({ now: Date.UTC(2026, 9, 12, 22, 30, 0) });
    expect(await service.createJob(request({ gameDate: TODAY, choices: [at(15)] }))).toMatchObject({ reason: 'invalid_input' });
    expect(created(await service.createJob(request({ gameDate: TODAY, choices: [at(60)] }))).job.choices).toEqual([at(60)]);
  });

  it('follows the injected clock', async () => {
    const { service, clock } = harness({ now: AFTERNOON - 3_600_000 });
    expect(created(await service.createJob(request({ gameDate: TODAY, choices: [at(790)] }))).job.id).toBe(1);
    clock.set(AFTERNOON);
    expect(await service.createJob(request({ gameDate: date('2026-10-13'), choices: [at(840)] }))).toMatchObject({ reason: 'invalid_input' });
  });

  it('checks the court rules first: a forbidden court is still reported as such', async () => {
    const { service } = harness({ now: AFTERNOON });
    expect(await service.createJob(request({ gameDate: TODAY, choices: [at(480, 1)] }))).toMatchObject({ reason: 'court_not_allowed' });
  });
});
