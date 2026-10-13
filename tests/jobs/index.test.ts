import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import * as jobs from '../../src/jobs/index.js';
import { buildHolidaySet } from '../../src/config/holidays.js';
import { cleanupTemp, makeApi, makeClock, track } from './_helpers.js';

afterEach(cleanupTemp);

describe('public surface of src/jobs', () => {
  it('exports the store, the service factory and the transition matrix', () => {
    expect(typeof jobs.SqliteJobStore).toBe('function');
    expect(typeof jobs.openJobStore).toBe('function');
    expect(typeof jobs.createJobService).toBe('function');
    expect(jobs.ALLOWED_TRANSITIONS.scheduled).toContain('warming');
    expect(jobs.MAX_DAYS_AHEAD).toBe(20);
    expect(jobs.DEFAULT_ESTIMATED_PRICE_CENTS).toBe(1902);
  });

  it('openJobStore opens a usable store', () => {
    const store = track(jobs.openJobStore(':memory:'));
    expect(store.list()).toEqual([]);
    expect(store.isStopped()).toBe(false);
  });

  it('accepts a real pino logger as the injected logger (structural compatibility)', () => {
    const service = jobs.createJobService({
      store: track(jobs.openJobStore(':memory:')),
      api: makeApi(),
      clock: makeClock(),
      holidays: buildHolidaySet(undefined),
      logger: pino({ level: 'silent' }),
    });
    expect(service.listJobs()).toEqual([]);
  });
});
