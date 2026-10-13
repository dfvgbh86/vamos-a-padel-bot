export const XHR = { 'X-Requested-With': 'XMLHttpRequest' } as const;
export const ACCEPT_JSON = { Accept: 'application/json, text/javascript, */*; q=0.01' } as const;
export const ACCEPT_HTML = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } as const;
export const ACCEPT_LANGUAGE = { 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' } as const;
export const FORM_ENCODED = 'application/x-www-form-urlencoded';

/** Headers of the XHR the site's own booking and cancel forms send to manager.php. */
export const MANAGER_POST_HEADERS = {
  ...XHR,
  ...ACCEPT_JSON,
  ...ACCEPT_LANGUAGE,
  'Content-Type': `${FORM_ENCODED}; charset=UTF-8`,
} as const;

/**
 * The site's own pages send Origin and Referer with every XHR (the booking form lives on the week calendar page); the
 * server-side PHP of manager.php answered HTTP 500 when they were missing. Page-like headers for a given slot date.
 */
export const pageHeaders = (baseUrl: string, gameDate: string): Readonly<Record<string, string>> => ({
  Origin: new URL(baseUrl).origin,
  Referer: `${baseUrl}/reserves/cal_week.php?date=${gameDate}&resource=1`,
});

/** Only the page title of an HTML error page, short; never the body (a debug page can carry secrets). */
export const errorPageTitle = (html: string): string | null => {
  const head = html.slice(0, 20_000);
  const start = head.search(/<title[^>]*>/i);
  if (start === -1) return null;
  const from = head.indexOf('>', start) + 1;
  const end = head.indexOf('<', from);
  if (end === -1) return null;
  const title = head.slice(from, end).replace(/\s+/g, ' ').trim().slice(0, 150);
  return title === '' ? null : title;
};
