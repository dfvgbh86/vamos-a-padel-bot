import type { CancelResult } from '../../contracts.js';
import { classifyFormPage, type FormGate } from '../classify.js';
import { AuthExpiredError, UnexpectedResponseError } from '../errors.js';
import { isAuthRejection, type HttpResponse } from '../http.js';
import { htmlToText } from '../parsers/html.js';
import { isPlainObject } from '../parsers/values.js';

const MAX_MESSAGE_CODE_POINTS = 120;

/** JSON.parse without its error: V8 puts a snippet of the input into the message, and bodies must never be echoed. */
export const decodeJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** Short, tag-free text of the site's own message (`data.msg`, `msg`, `message`, `error_msg`), or null. */
export const serverMessage = (payload: unknown): string | null => {
  if (!isPlainObject(payload)) return null;
  const data = payload['data'];
  const candidates = [isPlainObject(data) ? data['msg'] : undefined, payload['msg'], payload['message'], payload['error_msg']];
  const raw = candidates.find((value): value is string => typeof value === 'string' && value.length > 0);
  const text = raw === undefined ? null : htmlToText(raw.slice(0, 5_000));
  return text === null || text === '' ? null : Array.from(text).slice(0, MAX_MESSAGE_CODE_POINTS).join('');
};

export const expectStatus200 = (response: HttpResponse, what: string): void => {
  if (response.status !== 200) throw new UnexpectedResponseError(`${what} answered HTTP ${response.status}`, response.status);
};

/** A 200 that is really the login page means the session is gone. */
export const rejectLoginPage = (text: string): void => {
  if (classifyFormPage(text).kind === 'login_required') throw new AuthExpiredError();
};

/** Statuses that say "try again later": a page behind one of them is a failed request, never a verdict on the form. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/** Only a 2xx answer may open the gate or stay unrecognised; a 4xx page counts when it is a known notice (limit, too short, window closed). */
export const isAnswerToTrust = (gate: FormGate, status: number): boolean => {
  if (status >= 200 && status < 300) return true;
  if (gate.kind === 'open' || gate.kind === 'unknown') return false;
  return gate.kind !== 'login_required' || !TRANSIENT_STATUSES.has(status);
};

const failedCancel = (reason: string): CancelResult => ({ kind: 'failed', reason });

/** Only `{"status":"ok","data":{"msg":"Su reserva ha sido cancelada."}}` on a 2xx answer counts as cancelled. */
export const interpretCancel = (response: HttpResponse): CancelResult => {
  if (isAuthRejection(response.status, response.location)) return failedCancel('the session expired');
  if (response.status >= 500) return failedCancel(`the site answered with a server error (HTTP ${response.status})`);
  const payload = decodeJson(response.text);
  const message = serverMessage(payload);
  const confirmed = isPlainObject(payload) && payload['status'] === 'ok' && message !== null && /cancelad/i.test(message);
  if (confirmed && response.status >= 200 && response.status < 300) return { kind: 'cancelled' };
  return failedCancel(message ?? `unrecognised response (HTTP ${response.status})`);
};

export const transportFailedCancel = (mayHaveReachedServer: boolean): CancelResult =>
  failedCancel(mayHaveReachedServer ? 'no usable answer, the cancellation may or may not have happened' : 'the request was not sent');
