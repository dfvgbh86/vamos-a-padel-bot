import { describe, expect, it } from 'vitest';
import { errorPageTitle, MANAGER_POST_HEADERS, pageHeaders } from '../../src/reservaplay/client/headers.js';

describe('pageHeaders', () => {
  it('sends Origin and a calendar-page Referer like the site\'s own XHR', () => {
    expect(pageHeaders('https://club.example/base', '2026-10-20')).toEqual({
      Origin: 'https://club.example',
      Referer: 'https://club.example/base/reserves/cal_week.php?date=2026-10-20&resource=1',
    });
  });

  it('the booking POST asks in Spanish like a browser of the club', () => {
    expect(MANAGER_POST_HEADERS['Accept-Language']).toMatch(/^es/);
  });
});

describe('errorPageTitle', () => {
  it('returns only a short, single-line title', () => {
    expect(errorPageTitle('<html><head><title>\n Undefined   index  </title></head><body>SECRET=1</body></html>')).toBe('Undefined index');
    expect(errorPageTitle(`<title>${'x'.repeat(500)}</title>`)).toHaveLength(150);
  });

  it('returns null without a usable title and never the body', () => {
    expect(errorPageTitle('<body>SECRET=1</body>')).toBeNull();
    expect(errorPageTitle('<title></title>')).toBeNull();
    expect(errorPageTitle('<title>unterminated')).toBeNull();
  });
});
