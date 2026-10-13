export const REDACTED = '[скрыто]';

/** C0/C1 controls (except \n and \t), zero-width and bidi-override characters: hostile text must not reshape the message. */
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
/** Account `hash` values and similar long hex secrets, also glued to letters, underscores or digits (no `\b`: those are word characters). */
const LONG_HEX = /(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/gi;
/** Telegram bot tokens, also when glued to a URL path (`/bot123456:AAA.../sendMessage`). */
const BOT_TOKEN = /(?:bot)?\d{5,}:[A-Za-z0-9_-]{20,}/gi;

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Back to readable plain text, for the fallback send when Telegram rejects the HTML. */
export const htmlToPlain = (html: string): string =>
  html
    .replace(/<[^<>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

/** At most `limit` code points (ellipsis included); never cuts a surrogate pair. */
export const truncateByCodePoints = (text: string, limit: number): string => {
  if (limit <= 0) return '';
  const points = Array.from(text.length > limit * 2 + 2 ? text.slice(0, limit * 2 + 2) : text);
  if (points.length <= limit) return points.join('');
  return limit === 1 ? '…' : `${points.slice(0, limit - 1).join('')}…`;
};

export const redactSecrets = (text: string, extraSecrets: readonly string[] = []): string => {
  let result = text;
  for (const secret of extraSecrets) {
    if (secret.length > 0) result = result.split(secret).join(REDACTED);
  }
  return result.replace(BOT_TOKEN, REDACTED).replace(LONG_HEX, REDACTED);
};

/** Plain text that is safe to log or to show: invisible characters removed, secrets masked, length bounded. */
export const sanitizeText = (text: unknown, limit = 300): string => {
  if (typeof text !== 'string') return '';
  const bounded = text.slice(0, limit * 8).replace(/\s+/g, ' ').replace(INVISIBLE, '').trim();
  return truncateByCodePoints(redactSecrets(bounded), limit);
};

/** Dynamic text for an HTML message: sanitised, bounded by code points, then escaped (never the other way round). */
export const safeText = (text: unknown, limit = 300): string => escapeHtml(sanitizeText(text, limit));

export interface ErrorSummary {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly errorCode?: number;
}

/** Log-safe error description: no stack, no `payload` (a GrammyError carries the sent message text), no token. */
export const describeError = (error: unknown, secrets: readonly string[] = []): ErrorSummary => {
  if (!(error instanceof Error)) return { errorName: typeof error, errorMessage: '' };
  const code = (error as { error_code?: unknown }).error_code;
  return {
    errorName: error.name,
    errorMessage: truncateByCodePoints(redactSecrets(error.message.slice(0, 1000).replace(INVISIBLE, ''), secrets), 200),
    ...(typeof code === 'number' ? { errorCode: code } : {}),
  };
};
