export const XHR = { 'X-Requested-With': 'XMLHttpRequest' } as const;
export const ACCEPT_JSON = { Accept: 'application/json, text/javascript, */*; q=0.01' } as const;
export const ACCEPT_HTML = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } as const;
export const FORM_ENCODED = 'application/x-www-form-urlencoded';

/** Headers of the XHR the site's own booking and cancel forms send to manager.php. */
export const MANAGER_POST_HEADERS = {
  ...XHR,
  ...ACCEPT_JSON,
  'Content-Type': `${FORM_ENCODED}; charset=UTF-8`,
} as const;
