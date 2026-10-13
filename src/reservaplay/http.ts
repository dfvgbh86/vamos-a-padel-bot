import { CookieJar } from 'tough-cookie';
import { AuthExpiredError } from './errors.js';

export interface HttpLogger {
  debug(fields: object, message: string): void;
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** Raw `Location` header; redirects are never followed. */
  readonly location: string | null;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  /** Short static name used in logs instead of the URL (URLs carry ids and query values). */
  readonly label: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
  /** `throw` (default): 401/419 and a redirect to /login raise AuthExpiredError. `return`: hand the response to the caller. */
  readonly onAuthRejected?: 'throw' | 'return';
}

export type TransportReason = 'timeout' | 'network' | 'response_too_large';

/**
 * The request failed without a usable response. `mayHaveReachedServer` is false only when the failure is known to have
 * happened before the request was written (refused connection, DNS, TLS handshake, connect timeout, a route error raised by
 * the connect itself); every other failure leaves it true, because a POST may then have been processed.
 */
export class TransportError extends Error {
  constructor(
    readonly label: string,
    readonly reason: TransportReason,
    readonly mayHaveReachedServer: boolean,
    readonly code: string | null,
  ) {
    super(`Transport failure on ${label}: ${reason}${code === null ? '' : ` (${code})`}`);
    this.name = 'TransportError';
  }
}

export interface HttpSession {
  request(spec: HttpRequest): Promise<HttpResponse>;
  /** Forgets every cookie (a fresh login always starts from an empty jar). */
  clearCookies(): Promise<void>;
}

export interface HttpSessionOptions {
  readonly baseUrl: string;
  readonly logger: HttpLogger;
  readonly fetchImpl?: typeof fetch;
  readonly defaultTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 4_000_000;
export const USER_AGENT = 'vamos-a-padel-bot/0.1 (personal booking assistant for one account)';

/** setTimeout fires after about 1 ms when the delay is NaN, Infinity or above this value (2^31-1). */
export const MAX_TIMER_MS = 2_147_483_647;

/** The value itself when it is a usable timer delay; otherwise throws, so that a bad setting can never shorten a timeout. */
export const checkedTimeoutMs = (name: string, value: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new Error(`${name} must be an integer between 1 and ${MAX_TIMER_MS} ms`);
  }
  return value;
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Origin (plus optional path prefix) without a trailing slash. Credentials travel in requests, so https is mandatory except on loopback. */
export const normalizeBaseUrl = (raw: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('baseUrl is not a valid URL');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('baseUrl must use https');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('baseUrl must not contain credentials, a query or a fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
};

/** Mirrors the classifier: the session is gone when the site answers 401/419 or bounces to the login page. */
export const isAuthRejection = (status: number, location: string | null): boolean =>
  status === 401 || status === 419 || (status >= 300 && status < 400 && (location?.includes('/login') ?? false));

/** Failures that provably happened before the request was written. Anything not listed counts as "may have reached the server". */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_INVALID_URL',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Route errors that also surface on an established socket (Wi-Fi lost while the POST was in flight). They prove "not sent"
 * only when the failing syscall is the connect or the DNS lookup; on a read or write the request may already be out.
 */
const CONNECT_PHASE_CODES: ReadonlySet<string> = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL']);
const CONNECT_PHASE_SYSCALLS: ReadonlySet<string> = new Set(['connect', 'getaddrinfo']);

const MAX_CAUSE_DEPTH = 6;

interface FailureCause {
  readonly code: string;
  readonly syscall: string | null;
}

/**
 * Every error code of the cause chain with the syscall that raised it. An AggregateError (dual-stack connect) carries only
 * the code of its first member and no syscall, so a wrapper with members is represented by those members alone.
 */
const causesOf = (error: unknown, depth = 0): FailureCause[] => {
  if (typeof error !== 'object' || error === null || depth > MAX_CAUSE_DEPTH) return [];
  const record = error as { code?: unknown; syscall?: unknown; cause?: unknown; errors?: unknown };
  const nested = Array.isArray(record.errors) ? (record.errors as unknown[]).flatMap((item) => causesOf(item, depth + 1)) : [];
  const own =
    typeof record.code === 'string' && nested.length === 0
      ? [{ code: record.code, syscall: typeof record.syscall === 'string' ? record.syscall : null }]
      : [];
  return [...own, ...nested, ...causesOf(record.cause, depth + 1)];
};

const happenedBeforeSending = ({ code, syscall }: FailureCause): boolean =>
  NOT_SENT_CODES.has(code) || (CONNECT_PHASE_CODES.has(code) && syscall !== null && CONNECT_PHASE_SYSCALLS.has(syscall));

export const describeFetchFailure = (error: unknown): { readonly mayHaveReachedServer: boolean; readonly code: string | null } => {
  const causes = causesOf(error);
  const provablyNotSent = causes.length > 0 && causes.every(happenedBeforeSending);
  return { mayHaveReachedServer: !provablyNotSent, code: causes[0]?.code ?? null };
};

const noop = (): void => undefined;

const CHARSET = /;\s*charset\s*=\s*(?:"([^"]*)"|([^\s;]*))/i;

const decoderFor = (label: string): TextDecoder | null => {
  if (label === '') return null;
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
};

/** The classifiers match accent-folded Spanish text, which only works when the bytes are decoded with the charset the site declares. */
const decoderOf = (headers: Headers): TextDecoder => {
  const match = CHARSET.exec(headers.get('content-type') ?? '');
  return decoderFor((match?.[1] ?? match?.[2] ?? '').trim()) ?? new TextDecoder('utf-8');
};

const readBoundedText = async (response: Response, maxBytes: number): Promise<string | null> => {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = decoderOf(response.headers);
  let total = 0;
  let text = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text + decoder.decode();
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(noop);
      return null;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
};

class RequestTimeout extends Error {}

export const createHttpSession = (options: HttpSessionOptions): HttpSession => {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const origin = new URL(baseUrl).origin;
  const { logger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const defaultTimeoutMs = checkedTimeoutMs('defaultTimeoutMs', options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  // Secure cookies are honoured strictly: never stored from or sent over plain http, loopback included.
  const jar = new CookieJar(undefined, { allowSecureOnLocal: false });

  const storeCookies = async (url: string, headers: Headers): Promise<void> => {
    for (const cookie of headers.getSetCookie()) {
      try {
        await jar.setCookie(cookie, url, { ignoreError: true });
      } catch {
        logger.warn({}, 'a Set-Cookie header was rejected');
      }
    }
  };

  const exchange = async (spec: HttpRequest, signal: AbortSignal, headers: Record<string, string>): Promise<HttpResponse> => {
    let response: Response;
    try {
      response = await fetchImpl(spec.url, {
        method: spec.method,
        headers,
        ...(spec.body === undefined ? {} : { body: spec.body }),
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      const failure = describeFetchFailure(error);
      throw new TransportError(spec.label, 'network', failure.mayHaveReachedServer, failure.code);
    }

    let text: string | null;
    try {
      text = await readBoundedText(response, maxResponseBytes);
    } catch (error) {
      throw new TransportError(spec.label, 'network', true, describeFetchFailure(error).code);
    }
    if (text === null) throw new TransportError(spec.label, 'response_too_large', true, null);
    return { status: response.status, headers: response.headers, text, location: response.headers.get('location') };
  };

  const request = async (spec: HttpRequest): Promise<HttpResponse> => {
    if (new URL(spec.url).origin !== origin) throw new Error('Refusing to send a request outside the configured origin');
    const timeoutMs = spec.timeoutMs === undefined ? defaultTimeoutMs : checkedTimeoutMs('timeoutMs', spec.timeoutMs);

    const headers: Record<string, string> = { ...spec.headers, 'User-Agent': USER_AGENT };
    const cookies = await jar.getCookieString(spec.url);
    if (cookies !== '') headers['Cookie'] = cookies;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new RequestTimeout());
      }, timeoutMs);
    });
    timeout.catch(noop);
    const pending = exchange(spec, controller.signal, headers);
    pending.catch(noop);

    const startedAt = performance.now();
    let response: HttpResponse;
    try {
      response = await Promise.race([pending, timeout]);
    } catch (error) {
      if (error instanceof RequestTimeout) {
        logger.warn({ label: spec.label, timeoutMs }, 'request timed out');
        throw new TransportError(spec.label, 'timeout', true, null);
      }
      if (error instanceof TransportError) logger.warn({ label: spec.label, reason: error.reason, code: error.code }, 'request failed');
      throw error;
    } finally {
      clearTimeout(timer);
    }

    await storeCookies(spec.url, response.headers);
    logger.debug({ label: spec.label, status: response.status, ms: Math.round(performance.now() - startedAt) }, 'response received');

    if ((spec.onAuthRejected ?? 'throw') === 'throw' && isAuthRejection(response.status, response.location)) {
      throw new AuthExpiredError();
    }
    return response;
  };

  return { request, clearCookies: () => jar.removeAllCookies() };
};
