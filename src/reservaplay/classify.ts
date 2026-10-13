import { DateTime } from 'luxon';
import { CLUB_LUXON_OPTIONS } from '../config/timezone.js';

/** Real pages are ~90 KB; anything far beyond that is not a page we understand. */
const MAX_HTML_LENGTH = 2_000_000;
const MAX_BODY_LENGTH = 1_000_000;
const MAX_MESSAGE_CODE_POINTS = 160;

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

/** Linear: `[^<>]*` cannot run past the next angle bracket. */
const stripTags = (text: string): string => text.replace(/<[^<>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const truncateByCodePoints = (text: string, limit: number): string =>
  Array.from(text.slice(0, limit * 8))
    .slice(0, limit)
    .join('');

/** "Ya tienes 1 reserva/s para este dia." - digits are required so "¿Ya tienes cuenta?" never matches. */
const DAILY_LIMIT_MESSAGE = /ya tienes \d+ reserva/;

/**
 * Two wordings seen on the real site while the window is closed (both embed "Hora actual comprobación"):
 * "No se puede reservar a 8 o más dias vista" (8+ days ahead) and
 * "No puedes reservar hasta las 07:00" (7 days ahead, between midnight and the opening hour).
 */
const isNotOpenYetText = (text: string): boolean =>
  text.includes('dias vista') || text.includes('no puedes reservar hasta las');
const isDailyLimitText = (text: string): boolean => DAILY_LIMIT_MESSAGE.test(text);
const isTooShortText = (text: string): boolean => text.includes('tiempo de reserva minimo');

// ---------------------------------------------------------------------------------------------
// POST /sportssuite/manager.php (op=add_event)
// ---------------------------------------------------------------------------------------------

export type AddEventOutcome =
  | { readonly kind: 'ok'; readonly reservationId: number }
  | { readonly kind: 'not_open_yet' }
  | { readonly kind: 'daily_limit' }
  | { readonly kind: 'too_short' }
  | { readonly kind: 'auth_expired' }
  | { readonly kind: 'server_error'; readonly status: number }
  | { readonly kind: 'unknown'; readonly status: number; readonly message: string | null };

export interface HttpResponseSummary {
  readonly status: number;
  readonly location?: string | null;
  readonly body: string;
}

/** Anchored: `id=0`, `id=12abc` and ids beyond 2^53 are not reservation ids (leading zeros are harmless). */
const RESERVATION_ID_IN_REDIRECT = /cal_event\.php\?id=0*([1-9]\d*)(?:&|$)/;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const extractMessage = (payload: Record<string, unknown>): string | null => {
  const data = asRecord(payload['data']);
  const candidate = [data?.['msg'], payload['msg'], payload['message'], payload['error_msg']].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return candidate === undefined ? null : truncateByCodePoints(stripTags(candidate.slice(0, 5_000)), MAX_MESSAGE_CODE_POINTS);
};

const classifyKnownMessage = (message: string): AddEventOutcome | null => {
  const text = normalize(message);
  if (isNotOpenYetText(text)) return { kind: 'not_open_yet' };
  if (isDailyLimitText(text)) return { kind: 'daily_limit' };
  if (isTooShortText(text)) return { kind: 'too_short' };
  return null;
};

const reservationIdFrom = (payload: Record<string, unknown>): number | null => {
  const redirect = asRecord(asRecord(payload['data'])?.['redirect']);
  const url = redirect?.['url'];
  const id = typeof url === 'string' ? RESERVATION_ID_IN_REDIRECT.exec(url)?.[1] : undefined;
  if (id === undefined) return null;
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) ? numeric : null;
};

/**
 * Pure classification of a response that WAS received. Only outcomes whose wording was seen on the real
 * site (on the booking form page) are mapped; everything else is `unknown`, which callers must treat as
 * "stop, alert, never retry blindly". `ok` requires a 2xx status AND an explicit reservation id.
 */
export const classifyAddEventResponse = (response: HttpResponseSummary): AddEventOutcome => {
  const { status, location, body } = response;

  if (!Number.isInteger(status)) return { kind: 'unknown', status: 0, message: null };
  if (status === 401 || status === 419) return { kind: 'auth_expired' };
  if (status >= 300 && status < 400) {
    return location?.includes('/login') ? { kind: 'auth_expired' } : { kind: 'unknown', status, message: null };
  }
  if (status >= 500) return { kind: 'server_error', status };
  if (typeof body !== 'string' || body.length > MAX_BODY_LENGTH) return { kind: 'unknown', status, message: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: 'unknown', status, message: null };
  }
  const payload = asRecord(parsed);
  if (payload === null) return { kind: 'unknown', status, message: null };

  const message = extractMessage(payload);

  if (payload['status'] === 'ok' && status >= 200 && status < 300) {
    const reservationId = reservationIdFrom(payload);
    return reservationId === null ? { kind: 'unknown', status, message } : { kind: 'ok', reservationId };
  }

  return (message === null ? null : classifyKnownMessage(message)) ?? { kind: 'unknown', status, message };
};

/**
 * Transport failures (timeout, reset, 502/504 after the request left the machine) are NOT outcomes:
 * the booking may or may not exist. `ambiguous` forbids any re-send until the calendar has been
 * checked for an own booking on that date.
 */
export type TransportOutcome = { readonly kind: 'ambiguous' } | { readonly kind: 'not_sent' };

export const classifyTransportFailure = (requestMayHaveReachedServer: boolean): TransportOutcome =>
  requestMayHaveReachedServer ? { kind: 'ambiguous' } : { kind: 'not_sent' };

// ---------------------------------------------------------------------------------------------
// GET /reserves/cal_event.php  (the slot form doubles as the "is the window open" gate)
// ---------------------------------------------------------------------------------------------

export type FormGate =
  | { readonly kind: 'open'; readonly hash: string }
  | { readonly kind: 'window_closed'; readonly serverCheckTime: DateTime | null }
  | { readonly kind: 'daily_limit' }
  | { readonly kind: 'too_short' }
  | { readonly kind: 'login_required' }
  | { readonly kind: 'unknown' };

const SERVER_CHECK_TIME = /Hora actual comprobaci[oó]n:\s*(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/i;

/** Server clock reading embedded in the "N or more days ahead" message (1 s resolution, club time). */
export const parseServerCheckTime = (html: string): DateTime | null => {
  const match = SERVER_CHECK_TIME.exec(html.slice(0, MAX_HTML_LENGTH));
  if (match === null) return null;
  const [, day, month, year, hour, minute, second] = match.map(Number);
  const moment = DateTime.fromObject({ day, month, year, hour, minute, second }, CLUB_LUXON_OPTIONS);
  return moment.isValid ? moment : null;
};

/**
 * Removes `open ... close` blocks (comments, scripts, styles) in linear time. An unterminated block
 * swallows the rest of the document, as a browser would. Returns null when lower-casing changed the
 * string length (indices would no longer line up), which callers treat as "not understood".
 */
const stripBlocks = (source: string, open: string, close: string): string | null => {
  const lower = source.toLowerCase();
  if (lower.length !== source.length) return null;
  const parts: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = lower.indexOf(open, cursor);
    if (start === -1) {
      parts.push(source.slice(cursor));
      break;
    }
    parts.push(source.slice(cursor, start));
    const end = lower.indexOf(close, start + open.length);
    if (end === -1) break;
    cursor = end + close.length;
  }
  return parts.join('');
};

const visibleMarkup = (html: string): string | null => {
  const withoutComments = stripBlocks(html, '<!--', '-->');
  const withoutScripts = withoutComments === null ? null : stripBlocks(withoutComments, '<script', '</script>');
  return withoutScripts === null ? null : stripBlocks(withoutScripts, '<style', '</style>');
};

const FORM_TAG = /<form\b[^<>]*>/gi;
const INPUT_TAG = /<input\b[^<>]*>/gi;
/** Attribute NAMES are case-insensitive in HTML, attribute VALUES (ids, hex digits) are matched exactly. */
const EVENT_FORM_ID = /\s[Ii][Dd]\s*=\s*(["'])event-form\1/;

const inputsIn = (markup: string): string[] => markup.match(INPUT_TAG) ?? [];

const hasNamedInput = (inputs: readonly string[], name: string): boolean =>
  inputs.some((tag) => new RegExp(`\\sname\\s*=\\s*(["'])${name}\\1`, 'i').test(tag));

/** Markup between the opening tag of `<form id="event-form">` and its closing tag, or null if absent. */
const eventFormBody = (markup: string): string | null => {
  const lower = markup.toLowerCase();
  if (lower.length !== markup.length) return null;
  for (const tag of markup.matchAll(FORM_TAG)) {
    if (!EVENT_FORM_ID.test(tag[0])) continue;
    const bodyStart = (tag.index ?? 0) + tag[0].length;
    const bodyEnd = lower.indexOf('</form', bodyStart);
    return markup.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd);
  }
  return null;
};

const HASH_NAME = /\s[Nn][Aa][Mm][Ee]\s*=\s*(["'])hash\1/;
const HASH_VALUE = /\s[Vv][Aa][Ll][Uu][Ee]\s*=\s*(["'])([0-9a-f]{40})\1/;

export const classifyFormPage = (html: string): FormGate => {
  if (typeof html !== 'string' || html.length > MAX_HTML_LENGTH) return { kind: 'unknown' };

  const markup = visibleMarkup(html);
  if (markup === null) return { kind: 'unknown' };

  const form = eventFormBody(markup);
  if (form !== null) {
    const hashInput = inputsIn(form).find((tag) => HASH_NAME.test(tag));
    const hash = hashInput === undefined ? undefined : HASH_VALUE.exec(hashInput)?.[2];
    return hash === undefined ? { kind: 'unknown' } : { kind: 'open', hash };
  }

  const inputs = inputsIn(markup);
  if (hasNamedInput(inputs, 'username') && hasNamedInput(inputs, 'password')) return { kind: 'login_required' };

  const text = normalize(stripTags(markup));
  if (isNotOpenYetText(text)) return { kind: 'window_closed', serverCheckTime: parseServerCheckTime(html) };
  if (isDailyLimitText(text)) return { kind: 'daily_limit' };
  if (isTooShortText(text)) return { kind: 'too_short' };
  return { kind: 'unknown' };
};
