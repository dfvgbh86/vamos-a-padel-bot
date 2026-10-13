import { loginCheck, slots, wallet } from './siteCommands.js';
import { status } from './statusCommand.js';
import { EXIT_OK, EXIT_USAGE, type CliDeps } from './types.js';
import { whoamiTelegram } from './whoami.js';

export const USAGE = [
  'Live checks for the owner of the bot. Usage: npm run cli -- <command>',
  '',
  '  login-check          log in to the club site; prints OK or FAIL',
  '  slots <YYYY-MM-DD>   free slots on the courts the bot may book that day',
  '  wallet               wallet balance',
  '  status               emergency stop, session, wallet, next window and jobs',
  '  whoami-telegram      prints your Telegram user id (send any message to the bot; it does not reply)',
  '',
  'Reads the same .env as the bot. Do not run it in the minutes before a booking window opens.',
  '',
].join('\n');

const noArguments = (deps: CliDeps, command: string, args: readonly string[]): boolean => {
  if (args.length === 0) return true;
  deps.err(`${command} takes no arguments.\n`);
  return false;
};

/** Runs one command; returns the process exit code (0 done, 1 failed, 2 wrong usage). */
export const runCli = async (argv: readonly string[], deps: CliDeps): Promise<number> => {
  const [command, ...args] = argv;
  switch (command) {
    case 'login-check':
      return noArguments(deps, command, args) ? loginCheck(deps) : EXIT_USAGE;
    case 'slots':
      return slots(deps, args);
    case 'wallet':
      return noArguments(deps, command, args) ? wallet(deps) : EXIT_USAGE;
    case 'status':
      return noArguments(deps, command, args) ? status(deps) : EXIT_USAGE;
    case 'whoami-telegram':
      return noArguments(deps, command, args) ? whoamiTelegram(deps) : EXIT_USAGE;
    case '--help':
    case '-h':
    case 'help':
      deps.out(USAGE);
      return EXIT_OK;
    default:
      deps.err(command === undefined ? USAGE : `Unknown command: ${command.slice(0, 40)}\n\n${USAGE}`);
      return EXIT_USAGE;
  }
};
