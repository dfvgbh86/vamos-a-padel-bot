import { pino, type DestinationStream } from 'pino';
import type { LogLevel } from '../config/env.js';

/** The structural logger every module takes; a pino logger satisfies it. */
export interface AppLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Keys whose value must never reach a log line, wherever in an object they sit. Both spellings of the HTTP headers. */
export const SECRET_KEYS: readonly string[] = [
  'password',
  'token',
  'authorization',
  'cookie',
  'set-cookie',
  'hash',
  '_token',
  'laravel_session',
  'XSRF-TOKEN',
  'Authorization',
  'Cookie',
  'Set-Cookie',
  'botToken',
  'telegramBotToken',
];

/** How many object levels below the top a secret key is still found (`a.b.c.password`). */
const NESTING_DEPTH = 3;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const keyPath = (key: string): string => (IDENTIFIER.test(key) ? key : `["${key}"]`);

export const redactPaths = (): string[] => {
  const paths: string[] = [];
  for (let depth = 0; depth <= NESTING_DEPTH; depth++) {
    const prefix = '*.'.repeat(depth);
    for (const key of SECRET_KEYS) paths.push(`${prefix}${keyPath(key)}`);
  }
  return paths;
};

export const REDACTED = '[redacted]';

/** JSON lines on stdout (or `destination`), secrets censored by key, no host name or process id. */
export const createLogger = (level: LogLevel, destination?: DestinationStream): AppLogger =>
  pino(
    {
      level,
      base: { app: 'vamos-a-padel-bot' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: redactPaths(), censor: REDACTED },
    },
    destination,
  );

/** Adds a `module` field to every line, so a mixed log says which part of the bot spoke. */
export const scoped = (logger: AppLogger, module: string): AppLogger => ({
  debug: (obj, msg) => logger.debug({ module, ...obj }, msg),
  info: (obj, msg) => logger.info({ module, ...obj }, msg),
  warn: (obj, msg) => logger.warn({ module, ...obj }, msg),
  error: (obj, msg) => logger.error({ module, ...obj }, msg),
});
