export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  /** Header names lower-cased. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  readonly redirect: string | undefined;
}

export type Handler = (call: RecordedCall, signal: AbortSignal | undefined) => Response | Promise<Response>;

export interface FakeFetch {
  readonly fetchImpl: typeof fetch;
  readonly calls: RecordedCall[];
}

export const createFakeFetch = (handler: Handler): FakeFetch => {
  const calls: RecordedCall[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : null,
      redirect: init?.redirect,
    };
    calls.push(call);
    try {
      return Promise.resolve(handler(call, init?.signal ?? undefined));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('handler failed'));
    }
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
};

/** The syscall Node reports for each code on a real socket: connect/DNS errors happen before the request is written, reads and writes after. */
const SYSCALL_OF_CODE: Readonly<Record<string, string>> = {
  ECONNREFUSED: 'connect',
  ENETUNREACH: 'connect',
  EHOSTUNREACH: 'connect',
  EADDRNOTAVAIL: 'connect',
  ENOTFOUND: 'getaddrinfo',
  EAI_AGAIN: 'getaddrinfo',
  EAI_FAIL: 'getaddrinfo',
  ECONNRESET: 'read',
  EPIPE: 'write',
  ETIMEDOUT: 'read',
};

/**
 * Like undici: the failure is `TypeError: fetch failed` and the real reason hangs off `cause.code` and `cause.syscall`.
 * `syscall` defaults to the usual one of the code; `null` leaves it out (undici's own errors and TLS errors have none).
 */
export const networkError = (code: string, syscall?: string | null): TypeError => {
  const resolved = syscall === undefined ? (SYSCALL_OF_CODE[code] ?? null) : syscall;
  const cause = Object.assign(new Error(`${code} (synthetic)`), { code, ...(resolved === null ? {} : { syscall: resolved }) });
  return Object.assign(new TypeError('fetch failed'), { cause });
};

/** Rejects like fetch when the signal fires; never resolves otherwise. */
export const hangUntilAborted = (signal: AbortSignal | undefined): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
  });

export const bodyParams = (call: RecordedCall): URLSearchParams => new URLSearchParams(call.body ?? '');
