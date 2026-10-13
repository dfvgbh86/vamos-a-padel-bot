import { describe, expect, it } from 'vitest';
import { describeError, fatalMessage, redactText } from '../../src/runtime/errors.js';

describe('redactText', () => {
  it('masks every configured secret wherever it occurs', () => {
    const text = redactText('login as test-player with synthetic-password-0001, again synthetic-password-0001', ['synthetic-password-0001', 'test-player']);
    expect(text).not.toContain('synthetic-password-0001');
    expect(text).not.toContain('test-player');
    expect(text.match(/\[hidden\]/g)).toHaveLength(3);
  });

  it('ignores empty secrets instead of masking everything', () => {
    expect(redactText('plain text', [''])).toBe('plain text');
  });

  it('masks bot tokens, also glued to a URL', () => {
    expect(redactText('Call to https://api.telegram.org/bot123456789:SYNTHETIC-TOKEN-PLACEHOLDER-0001/getMe failed')).not.toMatch(/\d{9}:[A-Za-z0-9_-]{20,}/);
  });

  it('masks 40-character hashes and session cookies', () => {
    const hash = 'a1'.repeat(20);
    const text = redactText(`hash ${hash} cookie laravel_session=abcdef123456; XSRF-TOKEN=zzz999`);
    expect(text).not.toContain(hash);
    expect(text).not.toContain('abcdef123456');
    expect(text).not.toContain('zzz999');
  });

  it('leaves ordinary words and short numbers alone', () => {
    expect(redactText('Call to getMe failed (401: Unauthorized) after 12 attempts')).toBe('Call to getMe failed (401: Unauthorized) after 12 attempts');
  });
});

describe('describeError', () => {
  it('gives the class name and a scrubbed, bounded message', () => {
    const error = Object.assign(new TypeError(`bad ${'x'.repeat(1000)} secret-1`), {});
    const { errorName, errorMessage } = describeError(error, ['secret-1']);
    expect(errorName).toBe('TypeError');
    expect(errorMessage.length).toBeLessThanOrEqual(300);
  });

  it('never includes a stack', () => {
    expect(JSON.stringify(describeError(new Error('boom')))).not.toContain(' at ');
  });

  it('copes with values that are not errors', () => {
    expect(describeError('text')).toEqual({ errorName: 'string', errorMessage: '' });
    expect(describeError(undefined)).toEqual({ errorName: 'undefined', errorMessage: '' });
    expect(describeError({ message: 'x' })).toEqual({ errorName: 'object', errorMessage: '' });
  });
});

describe('fatalMessage', () => {
  it('is the message only', () => {
    expect(fatalMessage(new Error('Telegram refused'))).toBe('Telegram refused');
  });

  it('falls back to the class name when there is no message', () => {
    expect(fatalMessage(new RangeError(''))).toBe('RangeError');
    expect(fatalMessage(42)).toBe('number');
  });

  it('hides the configured secrets', () => {
    expect(fatalMessage(new Error('rejected synthetic-password-0001'), ['synthetic-password-0001'])).toBe('rejected [hidden]');
  });
});
