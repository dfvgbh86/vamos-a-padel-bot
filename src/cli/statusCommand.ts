import { DateTime } from 'luxon';
import { CLUB_LUXON_OPTIONS } from '../config/timezone.js';
import { ACTIVE_JOB_STATES, type Job, type JobStore, type StatusReport } from '../contracts.js';
import { createJobService } from '../jobs/service.js';
import { openJobStore } from '../jobs/store.js';
import { resolveDbLocation } from '../runtime/dbPath.js';
import { NOOP_LOGGER } from '../sniper/types.js';
import { siteFailureHint } from './failure.js';
import { courtLabel, formatClock, formatEuros } from './format.js';
import { openSite, fail } from './siteCommands.js';
import { EXIT_OK, type CliDeps } from './types.js';

const RECENT_FINISHED_JOBS = 5;

const madrid = (epochMs: number): string => `${DateTime.fromMillis(epochMs, CLUB_LUXON_OPTIONS).toFormat('yyyy-MM-dd HH:mm')} Madrid`;

const sessionLine = (alive: boolean | null): string => {
  if (alive === null) return 'could not be checked';
  return alive ? 'alive' : 'not active';
};

const jobLine = (job: Job): string => {
  const choices = job.choices.map((choice) => `${courtLabel(choice.courtId)} ${formatClock(choice.startMinutes)}`).join(', ');
  const booked = job.bookedChoice === null ? '' : ` -> booked ${courtLabel(job.bookedChoice.courtId)} ${formatClock(job.bookedChoice.startMinutes)}`;
  const id = job.reservationId === null ? '' : ` (reservation ${job.reservationId})`;
  const why = job.failureReason === null ? '' : ` [${job.failureReason}]`;
  return `  #${job.id}  ${job.gameDate}  ${job.state}  ${job.durationMinutes} min  ${job.payment}  ${choices}${booked}${id}${why}`;
};

const recentFinished = (store: JobStore): Job[] =>
  store
    .list()
    .filter((job) => !ACTIVE_JOB_STATES.includes(job.state))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, RECENT_FINISHED_JOBS);

const report = (deps: CliDeps, status: StatusReport, finished: readonly Job[]): void => {
  deps.out(`Emergency stop: ${status.stopped ? 'ON (no booking requests are sent; /resume in Telegram lifts it)' : 'off'}\n`);
  deps.out(`Session: ${sessionLine(status.sessionAlive)}\n`);
  deps.out(`Wallet: ${status.walletCents === null ? 'could not be read' : `${formatEuros(status.walletCents)} EUR`}\n`);
  deps.out(`Next window opens: ${status.nextWindowOpensAtMs === null ? 'no armed jobs' : madrid(status.nextWindowOpensAtMs)}\n`);
  deps.out(`Holidays in the next 30 days: ${status.upcomingHolidays.length === 0 ? 'none' : status.upcomingHolidays.join(', ')}\n`);
  deps.out(`Active jobs: ${status.activeJobs.length}\n`);
  for (const job of status.activeJobs) deps.out(`${jobLine(job)}\n`);
  if (finished.length > 0) {
    deps.out('Recent finished jobs:\n');
    for (const job of finished) deps.out(`${jobLine(job)}\n`);
  }
};

/** The same picture /status gives in Telegram, read from the database and the site. Opens its own login. */
export const status = async (deps: CliDeps): Promise<number> => {
  let store: (JobStore & { close(): void }) | undefined;
  try {
    const { env, api } = openSite(deps);
    store = (deps.openStore ?? openJobStore)(resolveDbLocation(env.dbPath));
    try {
      await api.login();
    } catch (error) {
      deps.err(`Could not log in: ${siteFailureHint(error)}\n`);
    }
    const service = createJobService({ store, api, clock: deps.clock, holidays: env.holidays, logger: NOOP_LOGGER });
    report(deps, await service.status(), recentFinished(store));
    return EXIT_OK;
  } catch (error) {
    return fail(deps, error);
  } finally {
    store?.close();
  }
};
