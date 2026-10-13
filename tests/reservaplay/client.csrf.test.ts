import { describe, expect, it } from 'vitest';
import { PAGE_CSRF_TOKEN } from '../fixtures/reservaplay/constants.js';
import { createFakeSite } from '../fixtures/reservaplay/fakeSite.js';
import { parseCsrfMeta } from '../../src/reservaplay/parsers/index.js';
import { posts, ready } from './bookHelpers.js';
import { bookRequest, makeClient, slotRef } from './helpers.js';

describe('X-CSRF-Token of the site\'s own ajax calls', () => {
  it('book() sends the token of the logged-in pages, not the login form token', async () => {
    const { site, client } = await ready();
    await client.book(bookRequest());
    expect(posts(site)[0]?.headers['x-csrf-token']).toBe(PAGE_CSRF_TOKEN);
  });

  it('cancel() sends it too', async () => {
    const site = createFakeSite();
    const client = makeClient(site);
    await client.login();
    await client.getAccountContext(slotRef());
    site.calls.length = 0;
    await client.cancel(100002);
    expect(site.callsTo('manager.php')[0]?.headers['x-csrf-token']).toBe(PAGE_CSRF_TOKEN);
  });
});

describe('parseCsrfMeta', () => {
  it('reads only the meta tag', () => {
    expect(parseCsrfMeta('<head><meta name="csrf_token" content="abcdefgh12345"></head>')).toBe('abcdefgh12345');
    expect(parseCsrfMeta('<input name="_token" value="abcdefgh12345">')).toBeNull();
    expect(parseCsrfMeta('<meta name="csrf_token" content="x y">')).toBeNull();
    expect(parseCsrfMeta(undefined)).toBeNull();
  });
});
