import { runCli } from './cli/run.js';
import { fatalMessage } from './runtime/errors.js';
import { createSystemClock } from './sniper/clock.js';

const write = (stream: NodeJS.WriteStream) => (text: string) => {
  stream.write(text);
};

/** Exit only after both streams have flushed, so the answer is never cut off when stdout is a pipe. */
const exitAfterFlush = (code: number): void => {
  process.stdout.write('', () => {
    process.stderr.write('', () => process.exit(code));
  });
};

const out = write(process.stdout);
const err = write(process.stderr);

runCli(process.argv.slice(2), { env: process.env, out, err, clock: createSystemClock() }).then(exitAfterFlush, (error: unknown) => {
  err(`Fatal: ${fatalMessage(error)}\n`);
  exitAfterFlush(1);
});
