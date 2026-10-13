/** Structural subset of a pino logger. Callers pass identifiers and counts only, never secrets or response bodies. */
export interface JobsLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Error class name only: messages of lower layers are not guaranteed to be free of account data. */
export const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);
