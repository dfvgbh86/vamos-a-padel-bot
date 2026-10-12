import { DateTime } from 'luxon';
import { CLUB_TIME_ZONE } from '../config/timezone.js';

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

const stripTags = (text: string): string => text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

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

const RESERVATION_ID_IN_REDIRECT = /cal_event\.php\?id=(\d+)/;

const extractMessage = (payload: unknown): string | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const data = record['data'];
  const nested = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['msg'] : undefined;
  const candidate = [nested, record['msg'], record['message'], record['error_msg']].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return candidate === undefined ? null : stripTags(candidate).slice(0, 160);
};

const classifyKnownMessage = (message: string): AddEventOutcome | null => {
  const text = normalize(message);
  if (text.includes('dias vista')) return { kind: 'not_open_yet' };
  if (text.includes('ya tienes') && text.includes('reserva')) return { kind: 'daily_limit' };
  if (text.includes('tiempo de reserva minimo')) return { kind: 'too_short' };
  return null;
};

/**
 * Pure classification of a response that WAS received. Only outcomes observed on the real site are
 * mapped; everything else is `unknown`, which callers must treat as "stop, alert, never retry blindly".
 * `ok` requires an explicit reservation id.
 */
export const classifyAddEventResponse = (response: HttpResponseSummary): AddEventOutcome => {
  const { status, location, body } = response;

  if (status === 401 || status === 419) return { kind: 'auth_expired' };
  if (status >= 300 && status < 400) {
    return location?.includes('/login') ? { kind: 'auth_expired' } : { kind: 'unknown', status, message: null };
  }
  if (status >= 500) return { kind: 'server_error', status };

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { kind: 'unknown', status, message: null };
  }

  const message = extractMessage(payload);
  const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};

  if (record['status'] === 'ok') {
    const data = record['data'];
    const redirect =
      typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['redirect'] : undefined;
    const url =
      typeof redirect === 'object' && redirect !== null ? (redirect as Record<string, unknown>)['url'] : undefined;
    const id = typeof url === 'string' ? RESERVATION_ID_IN_REDIRECT.exec(url)?.[1] : undefined;
    return id === undefined ? { kind: 'unknown', status, message } : { kind: 'ok', reservationId: Number(id) };
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

const HASH_INPUT_NAME_FIRST = /name=["']hash["'][^>]*value=["']([0-9a-f]{40})["']/i;
const HASH_INPUT_VALUE_FIRST = /value=["']([0-9a-f]{40})["'][^>]*name=["']hash["']/i;
const SERVER_CHECK_TIME = /Hora actual comprobaci[oó]n:\s*(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/i;

/** Server clock reading embedded in the "N or more days ahead" message (1 s resolution, club time). */
export const parseServerCheckTime = (html: string): DateTime | null => {
  const match = SERVER_CHECK_TIME.exec(html);
  if (match === null) return null;
  const [, day, month, year, hour, minute, second] = match.map(Number);
  const moment = DateTime.fromObject(
    { day, month, year, hour, minute, second },
    { zone: CLUB_TIME_ZONE },
  );
  return moment.isValid ? moment : null;
};

export const classifyFormPage = (html: string): FormGate => {
  if (html.includes('id="event-form"')) {
    const hash = (HASH_INPUT_NAME_FIRST.exec(html) ?? HASH_INPUT_VALUE_FIRST.exec(html))?.[1];
    return hash === undefined ? { kind: 'unknown' } : { kind: 'open', hash };
  }

  const text = normalize(stripTags(html));
  if (text.includes('dias vista')) return { kind: 'window_closed', serverCheckTime: parseServerCheckTime(html) };
  if (text.includes('ya tienes') && text.includes('reserva')) return { kind: 'daily_limit' };
  if (text.includes('tiempo de reserva minimo')) return { kind: 'too_short' };
  if (/name=["']username["']/.test(html) && /name=["']password["']/.test(html)) return { kind: 'login_required' };
  return { kind: 'unknown' };
};
