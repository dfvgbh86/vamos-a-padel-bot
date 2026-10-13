/** Logger the sniper modules take by injection (a pino logger satisfies it). Nothing secret may ever be passed in. */
export interface SniperLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const ignore = (): void => undefined;

export const NOOP_LOGGER: SniperLogger = { debug: ignore, info: ignore, warn: ignore, error: ignore };

const MAX_ERROR_MESSAGE_LENGTH = 200;

/** Defence in depth: whatever an error message says, hashes and session cookies never reach a log. */
const redact = (text: string): string =>
  text
    .replace(/\b[0-9a-f]{40}\b/gi, '[redacted]')
    .replace(/(laravel_session|XSRF-TOKEN|AWSALB\w*)\s*=\s*[^\s;,]+/gi, '$1=[redacted]');

/** Loggable summary of a thrown value: name and a short message, never a stack, never a response body. */
export const describeError = (error: unknown): { readonly errorName: string; readonly errorMessage: string } => {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: redact(error.message).slice(0, MAX_ERROR_MESSAGE_LENGTH) };
  }
  return { errorName: typeof error, errorMessage: '' };
};

/** A sniper invariant was about to be broken; the guarded action was NOT performed. */
export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantError';
  }
}
