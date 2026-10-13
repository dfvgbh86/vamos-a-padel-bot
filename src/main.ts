import { createApp, type App, type AppOverrides } from './app.js';
import { loadEnv, type Env, type EnvSource } from './config/env.js';
import { fatalMessage } from './runtime/errors.js';
import { registerProcessGuards, registerShutdown, type ProcessLike } from './runtime/shutdown.js';

export interface MainDeps {
  /** The variables to read (the process passes its own: `node --env-file=.env` has loaded the file already). */
  readonly env: EnvSource;
  readonly target: ProcessLike;
  /** Writes to stderr and calls back once the text is out, so an exit right after cannot cut the message. */
  readonly writeError: (text: string, done: () => void) => void;
  readonly exit: (code: number) => void;
  readonly createApp?: (env: Env, overrides?: AppOverrides) => App;
  readonly overrides?: AppOverrides;
}

/**
 * Loads the configuration, builds the app and starts it. Whatever cannot be done ends in ONE line on stderr
 * (the message only: no stack, no configured value) and exit code 1; on success the process keeps running until
 * a shutdown signal arrives.
 */
export const main = async (deps: MainDeps): Promise<void> => {
  let secrets: readonly string[] = [];
  const fail = (error: unknown): void => deps.writeError(`Fatal: ${fatalMessage(error, secrets)}\n`, () => deps.exit(1));

  let env: Env;
  try {
    env = loadEnv(deps.env);
  } catch (error) {
    fail(error);
    return;
  }
  secrets = [env.telegramBotToken, env.password, env.username];

  let app: App;
  try {
    app = (deps.createApp ?? createApp)(env, deps.overrides);
  } catch (error) {
    fail(error);
    return;
  }

  const guards = { app, logger: app.logger, target: deps.target, exit: deps.exit, secrets };
  registerShutdown(guards);
  registerProcessGuards(guards);
  try {
    await app.start();
  } catch (error) {
    fail(error);
  }
};

/** The real process: used by src/index.ts only. */
export const runMain = (): void => {
  const writeError = (text: string, done: () => void): void => {
    process.stderr.write(text, () => done());
  };
  const exit = (code: number): void => process.exit(code);
  main({ env: process.env, target: process, writeError, exit }).catch((error: unknown) => {
    writeError(`Fatal: ${fatalMessage(error)}\n`, () => exit(1));
  });
};
