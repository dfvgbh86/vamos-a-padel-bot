import { describe, expect, it } from 'vitest';
import { ACTIVE_JOB_STATES, type JobState } from '../../src/contracts.js';
import { InvalidTransitionError } from '../../src/jobs/errors.js';
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  isJobState,
  JOB_STATES,
  TERMINAL_JOB_STATES,
  transitionSources,
} from '../../src/jobs/transitions.js';

const ALL: readonly JobState[] = ['scheduled', 'warming', 'firing', 'booked', 'needs_payment', 'failed', 'cancelled', 'expired'];

describe('transition matrix', () => {
  it('covers exactly the eight job states', () => {
    expect([...JOB_STATES].sort()).toEqual([...ALL].sort());
  });

  it('allows the main path scheduled -> warming -> firing -> booked | failed | needs_payment', () => {
    expect(canTransition('scheduled', 'warming')).toBe(true);
    expect(canTransition('warming', 'firing')).toBe(true);
    for (const outcome of ['booked', 'failed', 'needs_payment'] as const) expect(canTransition('firing', outcome)).toBe(true);
  });

  it('allows the owner to cancel only before firing', () => {
    expect(canTransition('scheduled', 'cancelled')).toBe(true);
    expect(canTransition('warming', 'cancelled')).toBe(true);
    for (const state of ['firing', 'booked', 'needs_payment'] as const) expect(canTransition(state, 'cancelled')).toBe(false);
  });

  it('lets every active state expire', () => {
    for (const state of ACTIVE_JOB_STATES) expect(canTransition(state, 'expired'), state).toBe(true);
  });

  it('makes failed, cancelled and expired final: the only way out is recording a booking that exists on the site', () => {
    expect([...TERMINAL_JOB_STATES].sort()).toEqual(['cancelled', 'expired', 'failed']);
    for (const from of TERMINAL_JOB_STATES) {
      for (const to of ALL) expect(canTransition(from, to), `${from}->${to}`).toBe(to === 'booked' || to === 'needs_payment');
    }
  });

  it('keeps the firing phase mandatory for the normal path: a job cannot skip warming or jump into firing', () => {
    expect(canTransition('scheduled', 'firing')).toBe(false);
    for (const from of ALL) expect(canTransition(from, 'firing'), from).toBe(from === 'warming' || from === 'firing');
  });

  it('records a booking from firing, from needs_payment (once paid) and from every state the sniper may find the job in late', () => {
    for (const from of ['firing', 'scheduled', 'warming', 'failed', 'cancelled', 'expired'] as const) {
      expect(canTransition(from, 'booked'), from).toBe(true);
      expect(canTransition(from, 'needs_payment'), from).toBe(true);
    }
    expect(canTransition('needs_payment', 'booked')).toBe(true);
    expect(canTransition('booked', 'booked')).toBe(false);
    expect(canTransition('booked', 'needs_payment')).toBe(false);
  });

  it('allows only firing to move onto itself (attempt counting) and never moves a booked job anywhere but expired', () => {
    for (const state of ALL) expect(canTransition(state, state), state).toBe(state === 'firing');
    expect(ALLOWED_TRANSITIONS.booked).toEqual(['expired']);
  });

  it('reaches an active state from a finished one only by recording a booking (the unique active index guards the date)', () => {
    for (const from of ALL.filter((state) => !ACTIVE_JOB_STATES.includes(state))) {
      for (const to of ACTIVE_JOB_STATES) expect(canTransition(from, to), `${from}->${to}`).toBe(to === 'booked' || to === 'needs_payment');
    }
  });

  it('lets only warming and firing step back to scheduled (re-arm before the window ends)', () => {
    for (const from of ALL) expect(canTransition(from, 'scheduled'), from).toBe(from === 'warming' || from === 'firing');
  });
});

describe('isJobState', () => {
  it('accepts the eight names only', () => {
    for (const state of ALL) expect(isJobState(state)).toBe(true);
    for (const value of ['', 'Scheduled', 'done', 'constructor', '__proto__', 'toString', null, undefined, 3, {}, ['scheduled']]) {
      expect(isJobState(value), String(value)).toBe(false);
    }
  });
});

describe('transitionSources', () => {
  it('returns a single legal source', () => {
    expect(transitionSources('scheduled', 'warming')).toEqual(['scheduled']);
  });

  it('keeps only the sources from which the target is reachable and drops duplicates', () => {
    expect(transitionSources(['scheduled', 'warming', 'scheduled'], 'cancelled')).toEqual(['scheduled', 'warming']);
    expect(transitionSources(['scheduled', 'booked'], 'warming')).toEqual(['scheduled']);
    expect(transitionSources(ACTIVE_JOB_STATES, 'expired')).toEqual([...ACTIVE_JOB_STATES]);
  });

  it('returns nothing when no source can reach the target (a lost race, not an error)', () => {
    expect(transitionSources('booked', 'failed')).toEqual([]);
    expect(transitionSources('failed', 'scheduled')).toEqual([]);
    expect(transitionSources(['firing', 'booked'], 'cancelled')).toEqual([]);
    expect(transitionSources('scheduled', 'scheduled')).toEqual([]);
  });

  it('accepts the sniper call patterns', () => {
    expect(transitionSources('firing', 'firing')).toEqual(['firing']);
    expect(transitionSources('firing', 'scheduled')).toEqual(['firing']);
    expect(transitionSources(['scheduled', 'warming', 'cancelled', 'failed', 'expired'], 'booked')).toEqual([
      'scheduled',
      'warming',
      'cancelled',
      'failed',
      'expired',
    ]);
  });

  it('throws InvalidTransitionError for an empty source list', () => {
    expect(() => transitionSources([], 'warming')).toThrow(InvalidTransitionError);
  });

  it('throws for unknown or non-string state names without echoing huge input', () => {
    expect(() => transitionSources('nope', 'warming')).toThrow(InvalidTransitionError);
    expect(() => transitionSources('scheduled', 'nope')).toThrow(InvalidTransitionError);
    expect(() => transitionSources(['scheduled', 7], 'warming')).toThrow(InvalidTransitionError);
    expect(() => transitionSources(undefined, 'warming')).toThrow(InvalidTransitionError);
    expect(() => transitionSources('constructor', 'warming')).toThrow(InvalidTransitionError);
    const thrown = ((): Error | undefined => {
      try {
        transitionSources('x'.repeat(10_000), 'warming');
        return undefined;
      } catch (error) {
        return error as Error;
      }
    })();
    expect(thrown?.message.length).toBeLessThan(200);
  });
});
