import { allowedCourtIds } from '../config/courts.js';
import { loadSiteEnv, type SiteEnv } from '../config/env.js';
import { gameDateStart, parseGameDate, type GameDate } from '../config/gameDate.js';
import type { ReservaplayApi } from '../contracts.js';
import { createSiteApi } from '../runtime/site.js';
import { bookingOpensAt } from '../sniper/openTime.js';
import { NOOP_LOGGER } from '../sniper/types.js';
import { siteFailureHint } from './failure.js';
import { formatClock, formatEuros, plainCell, renderTable } from './format.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CliDeps } from './types.js';

export interface Site {
  readonly env: SiteEnv;
  readonly api: ReservaplayApi;
}

/** Throws EnvError when the club account is not configured. The client logs nothing here: output stays clean. */
export const openSite = (deps: CliDeps): Site => {
  const env = loadSiteEnv(deps.env);
  const api = deps.createApi?.(env, deps.clock) ?? createSiteApi(env, deps.clock, NOOP_LOGGER);
  return { env, api };
};

export const fail = (deps: CliDeps, error: unknown): number => {
  deps.err(`${siteFailureHint(error)}\n`);
  return EXIT_FAILED;
};

/** Logs in and prints OK or FAIL on stdout, nothing else; the reason goes to stderr. */
export const loginCheck = async (deps: CliDeps): Promise<number> => {
  try {
    await openSite(deps).api.login();
  } catch (error) {
    deps.out('FAIL\n');
    deps.err(`${siteFailureHint(error)}\n`);
    return EXIT_FAILED;
  }
  deps.out('OK\n');
  return EXIT_OK;
};

export const wallet = async (deps: CliDeps): Promise<number> => {
  try {
    const { api } = openSite(deps);
    await api.login();
    const { balanceCents } = await api.getWallet();
    deps.out(`Wallet: ${formatEuros(balanceCents)} EUR\n`);
    return EXIT_OK;
  } catch (error) {
    return fail(deps, error);
  }
};

const SLOT_USAGE = 'Usage: slots <YYYY-MM-DD>, for example: slots 2026-10-20\n';

const windowLine = (gameDate: GameDate, nowMs: number): string => {
  const opens = bookingOpensAt(gameDate);
  const when = `${opens.toFormat('yyyy-MM-dd HH:mm')} Madrid`;
  return opens.toMillis() <= nowMs ? `Booking window: open since ${when}` : `Booking window: opens ${when} (not open yet)`;
};

/** Free slots of the courts the bot may book on that day, as a table. Courts the bot never books are not listed. */
export const slots = async (deps: CliDeps, args: readonly string[]): Promise<number> => {
  const [raw] = args;
  let gameDate: GameDate;
  try {
    if (args.length !== 1 || raw === undefined) throw new Error('arguments');
    gameDate = parseGameDate(raw);
  } catch {
    deps.err(SLOT_USAGE);
    return EXIT_USAGE;
  }

  try {
    const { env, api } = openSite(deps);
    await api.login();
    const day = await api.getDay(gameDate);
    const allowed = allowedCourtIds(gameDate, env.holidays);
    const rows = day.courts
      .filter((court) => allowed.includes(court.courtId))
      .flatMap((court) =>
        court.slots
          .filter((slot) => slot.free && !slot.ownBooking)
          .map((slot) => [
            String(court.courtId),
            plainCell(court.name),
            formatClock(slot.startMinutes),
            formatClock(slot.endMinutes),
            String(slot.durationMinutes),
          ]),
      );
    const weekday = gameDateStart(gameDate).toFormat('ccc');
    deps.out(`${gameDate} (${weekday}): courts the bot may book: ${allowed.join(', ')}\n`);
    deps.out(`${windowLine(gameDate, deps.clock.nowMs())}\n`);
    deps.out(rows.length === 0 ? 'No free slots on those courts.\n' : `${renderTable(['court id', 'court', 'start', 'end', 'min'], rows)}\n`);
    return EXIT_OK;
  } catch (error) {
    return fail(deps, error);
  }
};
