import { describe, expect, it } from 'vitest';
import { describeFetchFailure } from '../../src/reservaplay/http.js';
import { BASE_URL } from '../fixtures/reservaplay/constants.js';
import { networkError } from '../fixtures/reservaplay/fakeFetch.js';
import { failureOf, open } from './httpHelpers.js';

describe('route errors depend on the phase that raised them', () => {
  const ROUTE_CODES = ['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL'] as const;

  it.each(ROUTE_CODES.flatMap((code) => (['connect', 'getaddrinfo'] as const).map((syscall) => [code, syscall] as const)))(
    '%s from the %s syscall: the request was NOT sent',
    (code, syscall) => {
      expect(describeFetchFailure(networkError(code, syscall))).toEqual({ mayHaveReachedServer: false, code });
    },
  );

  it.each(ROUTE_CODES.flatMap((code) => (['read', 'write', 'send', 'recv'] as const).map((syscall) => [code, syscall] as const)))(
    '%s from the %s syscall (an established socket): the request MAY have reached the server',
    (code, syscall) => {
      expect(describeFetchFailure(networkError(code, syscall))).toEqual({ mayHaveReachedServer: true, code });
    },
  );

  it.each(ROUTE_CODES)('%s without any syscall information is ambiguous, not "not sent"', (code) => {
    expect(describeFetchFailure(networkError(code, null))).toEqual({ mayHaveReachedServer: true, code });
  });

  it('turns a lost route after the POST was written into an ambiguous failure, end to end', async () => {
    const { session, calls } = open(() => {
      throw networkError('EHOSTUNREACH', 'read');
    });
    const error = await failureOf(session.request({ method: 'POST', url: `${BASE_URL}/sportssuite/manager.php`, label: 'test', body: 'a=1' }));
    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({ name: 'TransportError', reason: 'network', mayHaveReachedServer: true, code: 'EHOSTUNREACH' });
  });

  it('reads the syscall of the members of a dual-stack AggregateError, which has none of its own', () => {
    const member = (code: string, syscall: string): Error => Object.assign(new Error(code), { code, syscall });
    const aggregate = (...members: Error[]): TypeError =>
      new TypeError('fetch failed', { cause: Object.assign(new AggregateError(members, 'x'), { code: members[0]?.message }) });

    const unreachableWhileConnecting = aggregate(member('ENETUNREACH', 'connect'), member('EHOSTUNREACH', 'connect'));
    expect(describeFetchFailure(unreachableWhileConnecting)).toEqual({ mayHaveReachedServer: false, code: 'ENETUNREACH' });

    const lostWhileReading = aggregate(member('ENETUNREACH', 'read'), member('EHOSTUNREACH', 'connect'));
    expect(describeFetchFailure(lostWhileReading).mayHaveReachedServer).toBe(true);
  });

  it('does not let the code of an AggregateError stand in for its members', () => {
    const wrapper = Object.assign(new AggregateError([Object.assign(new Error('m'), { code: 'ECONNRESET', syscall: 'read' })], 'x'), {
      code: 'ECONNREFUSED',
    });
    expect(describeFetchFailure(new TypeError('fetch failed', { cause: wrapper }))).toEqual({ mayHaveReachedServer: true, code: 'ECONNRESET' });
  });
});
