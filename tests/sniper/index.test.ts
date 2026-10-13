import pino from 'pino';
import { describe, expect, it } from 'vitest';
import * as sniper from '../../src/sniper/index.js';
import type { SniperLogger } from '../../src/sniper/index.js';

describe('sniper public API', () => {
  it('exports the entry points the application wires together', () => {
    const entryPoints = ['createSystemClock', 'createSniperRunner', 'recoverJobs', 'runFiring', 'runPreflight', 'createEventQueue', 'estimateCostCents'];
    for (const name of entryPoints) {
      expect(typeof (sniper as Record<string, unknown>)[name], name).toBe('function');
    }
    expect(sniper.UNKNOWN_RESERVATION_ID).toBe(0);
    expect(sniper.DEFAULT_FIRE_OPTIONS.maxAttempts).toBe(3);
    expect(sniper.estimateCostCents(sniper.DEFAULT_ESTIMATED_COST_CENTS, 60)).toBe(1268);
  });

  it('a pino logger can be passed as the sniper logger (and a silent one logs nothing)', () => {
    const logger: SniperLogger = pino({ level: 'silent' });
    expect(() => {
      logger.info({ jobId: 1 }, 'hello');
      logger.error({ jobId: 1 });
    }).not.toThrow();
  });

  it('the no-op logger accepts everything', () => {
    sniper.NOOP_LOGGER.warn({ a: 1 }, 'x');
    sniper.NOOP_LOGGER.debug({});
  });

  it('every failure reason has a description', () => {
    for (const [reason, text] of Object.entries(sniper.FIRE_FAILURE_DESCRIPTIONS)) {
      expect(text.length, reason).toBeGreaterThan(10);
    }
  });
});
