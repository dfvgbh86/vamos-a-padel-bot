/**
 * The built bot as a real child process, started the way `npm start` starts it: `node --env-file=<file> ... dist/src/index.js`.
 * The child gets a minimal environment (nothing of the developer's own variables), a throw-away working directory and
 * the connection guard of netGuard.cjs preloaded.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, waitFor } from './_wait.js';

export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const ENTRY = join(ROOT, 'dist', 'src', 'index.js');
const GUARD = join(ROOT, 'tests', 'smoke', 'netGuard.cjs');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/** Windows cannot deliver SIGINT/SIGTERM to a child (kill() ends it with no handler run): there the signal is passed over an IPC channel. */
const SIGNAL_VIA_IPC = process.platform === 'win32';

/** `npm run build` (tsc -p tsconfig.build.json), run with the same node: the smoke test always runs the code of src/. */
export const buildBot = (): void => {
  const built = spawnSync(process.execPath, [TSC, '-p', 'tsconfig.build.json'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  if (built.status !== 0) throw new Error(`npm run build failed (exit ${String(built.status)}):\n${built.stdout}${built.stderr}`);
  if (!existsSync(ENTRY)) throw new Error(`the build did not produce ${ENTRY}`);
};

export interface LogLine {
  readonly raw: string;
  readonly level: number;
  readonly msg: string;
  readonly module: string | undefined;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface BotProcess {
  readonly pid: number;
  readonly stdoutLines: readonly string[];
  stderr(): string;
  /** Every stdout line parsed as a JSON log line; a line that is not JSON is an error of the test. */
  logs(): LogLine[];
  waitForLog(msg: string, timeoutMs: number): Promise<LogLine>;
  exited(): ExitInfo | undefined;
  /** An orderly shutdown request (SIGINT or SIGTERM) and the exit it leads to. */
  shutdown(signal: 'SIGINT' | 'SIGTERM', timeoutMs?: number): Promise<ExitInfo>;
  /** The process is ended at once, with no chance to clean up. */
  kill(): Promise<ExitInfo>;
}

export interface StartOptions {
  /** Content of the --env-file. */
  readonly envFile: Readonly<Record<string, string>>;
  /** Without --env-file: the variables go straight into the child's environment. */
  readonly noEnvFile?: boolean;
  readonly dir: string;
  readonly tag: string;
}

const quoted = (value: string): string => (/^[A-Za-z0-9_./:@-]*$/.test(value) ? value : `"${value}"`);

export const writeEnvFile = (file: string, values: Readonly<Record<string, string>>): void => {
  writeFileSync(file, `${Object.entries(values).map(([key, value]) => `${key}=${quoted(value)}`).join('\n')}\n`);
};

const baseEnv = (netLog: string): Record<string, string> => {
  const keep = ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP'];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, SMOKE_NET_LOG: netLog, ...(SIGNAL_VIA_IPC ? { SMOKE_SIGNAL_VIA_IPC: '1' } : {}) };
};

export const netLogOf = (dir: string, tag: string): string => join(dir, `net-${tag}.log`);

export const readNetLog = (dir: string, tag: string): string[] => {
  const file = netLogOf(dir, tag);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '') : [];
};

const parseLine = (raw: string): LogLine => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('a stdout line of the bot is not a JSON object');
  const fields = parsed as Record<string, unknown>;
  const moduleName = fields['module'];
  return {
    raw,
    level: Number(fields['level']),
    msg: String(fields['msg'] ?? ''),
    module: typeof moduleName === 'string' ? moduleName : undefined,
    fields,
  };
};

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const alive = new Set<ChildProcess>();

/** Ends every child that is still running (test teardown). */
export const killAll = async (): Promise<void> => {
  for (const child of alive) child.kill('SIGKILL');
  await sleep(200);
  alive.clear();
};

export const startBot = (options: StartOptions): BotProcess => {
  const envFile = join(options.dir, `${options.tag}.env`);
  const nodeArgs = ['--disable-warning=ExperimentalWarning', `--require=${GUARD}`];
  const env = baseEnv(netLogOf(options.dir, options.tag));
  if (options.noEnvFile === true) Object.assign(env, options.envFile);
  else {
    writeEnvFile(envFile, options.envFile);
    nodeArgs.unshift(`--env-file=${envFile}`);
  }
  const child = spawn(process.execPath, [...nodeArgs, ENTRY], {
    cwd: options.dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe', ...(SIGNAL_VIA_IPC ? (['ipc'] as const) : [])],
    windowsHide: true,
  });
  alive.add(child);

  const stdoutLines: string[] = [];
  let partial = '';
  let stderrText = '';
  let exit: ExitInfo | undefined;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop() ?? '';
    stdoutLines.push(...lines.filter((line) => line.trim() !== ''));
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrText += chunk;
  });
  child.on('exit', (code, signal) => {
    exit = { code, signal };
    if (partial.trim() !== '') stdoutLines.push(partial);
    partial = '';
    alive.delete(child);
  });

  const logs = (): LogLine[] => stdoutLines.map(parseLine);
  const waitForExit = (timeoutMs: number): Promise<ExitInfo> =>
    waitFor(`the bot process (${options.tag}) to exit`, () => exit, timeoutMs);

  const signalChild = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (SIGNAL_VIA_IPC) child.send(signal);
    else child.kill(signal);
  };

  return {
    pid: child.pid ?? -1,
    stdoutLines,
    stderr: () => stderrText,
    logs,
    waitForLog: (msg, timeoutMs) =>
      waitFor(
        `the bot log line "${msg}" (stderr so far: ${stderrText.slice(0, 500)})`,
        () => {
          const line = stdoutLines.map(parseLine).find((candidate) => candidate.msg === msg);
          if (line === undefined && exit !== undefined) throw new Error(`the bot exited (${JSON.stringify(exit)}) before logging "${msg}": ${stderrText}`);
          return line;
        },
        timeoutMs,
      ),
    exited: () => exit,
    shutdown: async (signal, timeoutMs = 25_000) => {
      signalChild(signal);
      return waitForExit(timeoutMs);
    },
    kill: async () => {
      child.kill('SIGKILL');
      return waitForExit(10_000);
    },
  };
};

/** A throw-away node process that tries to fetch an address outside this machine, with the connection guard preloaded. */
export const probeGuard = (dir: string, tag: string): { stdout: string; log: string[] } => {
  const code =
    "fetch('http://203.0.113.9:81/').then(() => process.stdout.write('reached'), (error) => process.stdout.write(String(error.cause ? error.cause.message : error.message)))";
  const probe = spawnSync(process.execPath, [`--require=${GUARD}`, '-e', code], {
    cwd: dir,
    env: baseEnv(netLogOf(dir, tag)),
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { stdout: probe.stdout, log: readNetLog(dir, tag) };
};

/** Runs the bot to its end (a configuration error ends it at once) and returns what it said. */
export const runToExit = async (options: StartOptions, timeoutMs = 20_000): Promise<{ exit: ExitInfo; stdout: string; stderr: string }> => {
  const bot = startBot(options);
  const exit = await waitFor(`the bot (${options.tag}) to exit`, () => bot.exited(), timeoutMs);
  return { exit, stdout: bot.stdoutLines.join('\n'), stderr: bot.stderr() };
};
