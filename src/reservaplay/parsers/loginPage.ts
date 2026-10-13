import { findTags, visibleMarkup } from './html.js';

const TOKEN = /^[A-Za-z0-9_\-+/=.]{8,512}$/;

const validToken = (value: string | undefined): string | null =>
  value !== undefined && TOKEN.test(value) ? value : null;

/**
 * The token every page of the logged-in site carries in `<meta name="csrf_token">`; the site's own scripts send it as the
 * `X-CSRF-Token` header of every ajax request (including the booking and cancel POSTs, which answer 500 without it).
 */
export const parseCsrfMeta = (html: unknown): string | null => {
  const markup = visibleMarkup(html);
  if (markup === null) return null;
  for (const meta of findTags(markup, 'meta')) {
    if (meta.attributes.get('name') !== 'csrf_token') continue;
    const token = validToken(meta.attributes.get('content'));
    if (token !== null) return token;
  }
  return null;
};

/** CSRF token of the login page: `<input name="_token" value="...">` (any attribute order) or `<meta name="csrf_token">`. */
export const parseCsrfToken = (html: unknown): string | null => {
  const markup = visibleMarkup(html);
  if (markup === null) return null;

  for (const input of findTags(markup, 'input')) {
    if (input.attributes.get('name') !== '_token') continue;
    const token = validToken(input.attributes.get('value'));
    if (token !== null) return token;
  }
  for (const meta of findTags(markup, 'meta')) {
    const name = meta.attributes.get('name');
    if (name !== 'csrf_token' && name !== 'csrf-token') continue;
    const token = validToken(meta.attributes.get('content'));
    if (token !== null) return token;
  }
  return null;
};
