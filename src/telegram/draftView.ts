import { DEFAULT_DURATION_MINUTES } from '../reservaplay/bookingBody.js';
import { bookingOpensAt } from '../sniper/openTime.js';
import type { Clock, JobService } from '../contracts.js';
import type { OpenRule } from '../sniper/openTime.js';
import { courtOptions, hasOwnBooking, offeredDates, startsForCourt } from './schedule.js';
import type { Draft } from './sessions.js';
import { confirmView, courtsView, datesView, timesView, type View } from './views.js';

export const DURATION_MINUTES = DEFAULT_DURATION_MINUTES;

export interface DraftViewDeps {
  readonly service: JobService;
  readonly clock: Clock;
  readonly openRule?: OpenRule;
}

/** Renders the screen the conversation is currently on; courts are always re-read from the service. */
export const draftView = (deps: DraftViewDeps, draft: Draft, notice?: string): View => {
  const nowMs = deps.clock.nowMs();
  const { gameDate, mode } = draft;
  if (gameDate === null || mode === null || draft.view.kind === 'dates') {
    return datesView(offeredDates(nowMs, deps.openRule), draft.sid, notice);
  }
  const opensAtMs = bookingOpensAt(gameDate, deps.openRule).toMillis();
  const open = opensAtMs <= nowMs;
  const common = { sid: draft.sid, gameDate, choices: draft.choices, notice };

  switch (draft.view.kind) {
    case 'courts':
      return courtsView({
        ...common,
        open,
        opensAtMs,
        mode,
        options: courtOptions(deps.service.allowedCourts(gameDate), mode, DURATION_MINUTES),
        hasOwnBooking: mode.kind === 'schedule' && hasOwnBooking(mode.schedule),
      });
    case 'times':
      return timesView({
        ...common,
        courtId: draft.view.courtId,
        starts: startsForCourt(mode, draft.view.courtId, DURATION_MINUTES),
      });
    case 'confirm':
      return confirmView({ ...common, open, opensAtMs, durationMinutes: DURATION_MINUTES });
  }
};
