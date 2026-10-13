import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeJobService, daySchedule, date, makeJob } from './_fakes.js';
import { createHarness, type Harness } from './_harness.js';

const D20 = date('2026-10-20');
const SERVICE_DEADLINE_CEILING_MS = 30_000;
const SCHEDULE_DEADLINE_CEILING_MS = 10_000;

let service: FakeJobService;
let h: Harness;

beforeEach(async () => {
  service = new FakeJobService();
  service.schedules.set(D20, daySchedule(D20, { 4: [1080, 1170], 9: [1080, 1170] }));
  h = await createHarness({ service });
});

const dataOf = (label: string): string => h.buttons().find((button) => button.text.includes(label))?.data ?? 'missing';

describe('every button press is answered exactly once, whatever the handler does', () => {
  it('a handler that throws before it answers still gets the query answered (once)', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    const court = dataOf('Pista 4');
    h.transport.clear();
    vi.spyOn(service, 'allowedCourts').mockImplementation(() => {
      throw new Error('service exploded');
    });

    await h.pressData(court);

    expect(h.answers()).toHaveLength(1);
    expect(h.logs.entries.some((entry) => entry.level === 'error' && entry.msg?.includes('handler failed'))).toBe(true);
  });

  it('a handler that throws after it answered does not answer a second time', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Pista 4');
    const time = dataOf('18:00');
    h.transport.clear();
    vi.spyOn(service, 'allowedCourts')
      .mockImplementationOnce(() => [4, 9])
      .mockImplementation(() => {
        throw new Error('service exploded later');
      });

    await h.pressData(time);

    expect(h.answers()).toHaveLength(1);
  });

  it('a normal press is answered once', async () => {
    await h.say('/new');
    const day = dataOf('вт 20.10');
    h.transport.clear();
    await h.pressData(day);
    expect(h.answers()).toHaveLength(1);
  });

  it('a press the handler refuses is answered once, with the alert', async () => {
    await h.say('/new');
    await h.press('вт 20.10');
    const forged = `n:c:${dataOf('Pista 4').split(':')[2]}:2`;
    h.transport.clear();
    await h.pressData(forged);
    expect(h.answers()).toHaveLength(1);
    expect(h.answers()[0]?.payload).toMatchObject({ show_alert: true });
  });
});

describe('every wait on the service has a deadline that keeps the owner able to /stop', () => {
  it('the schedule of a day is given up after at most 10 seconds', async () => {
    service.hangGetDay = true;
    h.clock.sleepMode = 'immediate';
    await h.say('/new');
    await h.press('вт 20.10');
    expect(h.clock.sleeps.length).toBeGreaterThan(0);
    for (const ms of h.clock.sleeps) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(SCHEDULE_DEADLINE_CEILING_MS);
    }
  });

  it('the /new flow as a whole waits at most 2 x 10 s for schedules, even for a date that is not open yet', async () => {
    service.hangGetDay = true;
    h.clock.sleepMode = 'immediate';
    await h.say('/new');
    await h.press('ср 21.10');
    expect(h.clock.sleeps.length).toBeLessThanOrEqual(2);
    expect(h.clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(2 * SCHEDULE_DEADLINE_CEILING_MS);
  });

  it('creating a job is given up after at most 30 seconds', async () => {
    service.createResult = () => new Promise(() => undefined);
    h.clock.sleepMode = 'immediate';
    await h.say('/new');
    await h.press('вт 20.10');
    await h.press('Pista 4');
    await h.press('18:00');
    await h.press('Готово');
    h.clock.sleeps.length = 0;
    await h.press('Подтвердить');
    expect(h.clock.sleeps).toHaveLength(1);
    expect(h.clock.sleeps[0]).toBeGreaterThan(0);
    expect(h.clock.sleeps[0]).toBeLessThanOrEqual(SERVICE_DEADLINE_CEILING_MS);
  });

  it('cancelling a job is given up after at most 30 seconds', async () => {
    service.jobs = [makeJob({ id: 5, state: 'scheduled' })];
    service.cancelResult = () => new Promise(() => undefined);
    h.clock.sleepMode = 'immediate';
    await h.say('/cancel 5');
    h.clock.sleeps.length = 0;
    await h.press('Да, отменить');
    expect(h.clock.sleeps).toHaveLength(1);
    expect(h.clock.sleeps[0]).toBeGreaterThan(0);
    expect(h.clock.sleeps[0]).toBeLessThanOrEqual(SERVICE_DEADLINE_CEILING_MS);
  });

  it.each(['/jobs', '/status', '/wallet'])('%s is given up after at most 30 seconds', async (command) => {
    await h.say(command);
    expect(h.clock.sleeps).toHaveLength(1);
    expect(h.clock.sleeps[0]).toBeGreaterThan(0);
    expect(h.clock.sleeps[0]).toBeLessThanOrEqual(SERVICE_DEADLINE_CEILING_MS);
  });

  it('/stop and /resume do not wait on anything: no deadline is even started', async () => {
    await h.say('/stop');
    await h.say('/resume');
    expect(h.clock.sleeps).toEqual([]);
  });
});

describe('the Bot API client', () => {
  it('has a request timeout above the 30 s long poll but far below grammY\'s 500 s default', () => {
    const seconds = h.handle.bot.api.options?.timeoutSeconds;
    expect(seconds).toBeGreaterThan(30);
    expect(seconds).toBeLessThanOrEqual(120);
  });
});
