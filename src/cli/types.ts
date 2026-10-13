import type { Transformer } from 'grammy';
import type { EnvSource, SiteEnv } from '../config/env.js';
import type { Clock, JobStore, ReservaplayApi } from '../contracts.js';

/** Everything the commands touch outside the process, so tests can run them without a network or a terminal. */
export interface CliDeps {
  readonly env: EnvSource;
  /** stdout: the result of a command and nothing else. */
  readonly out: (text: string) => void;
  /** stderr: usage and the reason of a failure (never a secret). */
  readonly err: (text: string) => void;
  readonly clock: Clock;
  readonly createApi?: (env: SiteEnv, clock: Clock) => ReservaplayApi;
  readonly openStore?: (location: string) => JobStore & { close(): void };
  readonly telegramTransformer?: Transformer;
  /** How long whoami-telegram waits for a message (default two minutes). */
  readonly whoamiTimeoutMs?: number;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
