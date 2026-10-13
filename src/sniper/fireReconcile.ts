import type { DaySchedule, SlotChoice } from '../contracts.js';
import { AuthExpiredError } from '../reservaplay/errors.js';
import { sleepFor } from './clock.js';
import { sentAttempts, type FireContext } from './fireContext.js';
import { abortedResult, failJob, finishBooked } from './fireFinish.js';
import { loginPersistently } from './fireLogin.js';
import type { FireFailureReason, FireResult } from './fireTypes.js';
import { findOwnBooking, hasOwnBooking, slotTakenByOthers, type OwnBookingMatch } from './ownBooking.js';
import { describeError } from './types.js';

type Looked =
  | { readonly kind: 'found'; readonly match: OwnBookingMatch }
  /** Nothing of ours on that day; `lastDay` is the latest calendar that could be read. */
  | { readonly kind: 'none'; readonly lastDay: DaySchedule | null }
  | { readonly kind: 'aborted' };

interface Session {
  reloggedIn: boolean;
}

/** One paced calendar read; a dead session is replaced by ONE login per lookup. Null when the read failed. */
const readDay = async (ctx: FireContext, session: Session, poll: number): Promise<DaySchedule | null> => {
  const { api, logger } = ctx.deps;
  await ctx.pace();
  try {
    return await api.getDay(ctx.job.gameDate);
  } catch (error) {
    logger.warn({ jobId: ctx.job.id, poll, ...describeError(error) }, 'calendar check failed');
    if (error instanceof AuthExpiredError && !session.reloggedIn) {
      session.reloggedIn = true;
      await loginPersistently(ctx);
    }
    return null;
  }
};

/** Looks `polls` times (spaced) for an own booking on the job's date. Read-only, so the stop flag is ignored on purpose. */
const pollOwnBooking = async (ctx: FireContext, polls: number): Promise<Looked> => {
  const session: Session = { reloggedIn: false };
  let lastDay: DaySchedule | null = null;
  for (let poll = 0; poll < polls; poll++) {
    if (poll > 0) await sleepFor(ctx.deps.clock, ctx.opts.reconcileIntervalMs);
    if (ctx.deps.signal?.aborted === true) return { kind: 'aborted' };
    const day = await readDay(ctx, session, poll);
    if (day === null) continue;
    lastDay = day;
    const match = findOwnBooking(day, ctx.job.choices);
    if (match !== null) return { kind: 'found', match };
  }
  return { kind: 'none', lastDay };
};

/** A booking exists but on no wished slot: it may be the owner's own, so it is not claimed as a success. */
const bookingElsewhere = (ctx: FireContext): FireResult => {
  ctx.deps.events.emit({
    kind: 'ambiguous',
    job: ctx.job,
    detail: 'a booking exists on that day but not on a wished slot: check the club site; nothing more will be sent',
  });
  return failJob(ctx, 'own_booking_elsewhere');
};

/**
 * A read that proves nothing: every poll failed, or the calendar listed no slots at all. Only a calendar that was
 * read and showed slots lets "nothing of ours there" count as "nothing was booked".
 */
const calendarProvesNothing = (lastDay: DaySchedule | null): boolean =>
  lastDay === null || lastDay.courts.every((court) => court.slots.length === 0);

const settle = (ctx: FireContext, looked: Looked, otherwise: FireFailureReason): FireResult => {
  if (looked.kind === 'aborted') return abortedResult(ctx);
  if (looked.kind === 'none') return failJob(ctx, otherwise);
  return looked.match.choice === null ? bookingElsewhere(ctx) : finishBooked(ctx, looked.match.choice, null);
};

/**
 * The request may have been processed (timeout, reset, 5xx): look for the booking before anything else.
 * Null = nothing was found in a calendar that was actually read, and attempts and time remain: the gate loop goes
 * on, and sending again needs a fresh open probe (which shows `daily_limit` if a booking exists after all). A
 * calendar that could not be read leaves the outcome unresolved: nothing is sent again (PLAN 3a, item 3).
 */
export const reconcileUnclear = async (
  ctx: FireContext,
  cause: string,
  polls: number = ctx.opts.reconcilePolls,
): Promise<FireResult | null> => {
  ctx.deps.events.emit({
    kind: 'ambiguous',
    job: ctx.job,
    detail: `${cause}: the request may have been processed; checking the calendar before anything is sent again`,
  });
  const looked = await pollOwnBooking(ctx, polls);
  if (looked.kind !== 'none') return settle(ctx, looked, 'ambiguous_unresolved');
  if (calendarProvesNothing(looked.lastDay)) {
    ctx.deps.logger.warn({ jobId: ctx.job.id }, 'the calendar could not be read after an unclear answer; nothing more is sent');
    return failJob(ctx, 'ambiguous_unresolved');
  }
  if (sentAttempts(ctx) >= ctx.opts.maxAttempts || ctx.deps.clock.nowMs() > ctx.deadlineMs) {
    return failJob(ctx, 'ambiguous_unresolved');
  }
  ctx.deps.logger.info({ jobId: ctx.job.id }, 'no booking found after an unclear answer; back to the gate');
  return null;
};

/**
 * An answer nobody understood. The request certainly reached the server, so a booking may exist: look for it for
 * as long as for any unclear outcome, never re-send for that slot. Only a calendar that shows the slot taken by
 * somebody else lets the loop move on to the next choice; any other unknown answer ends the job.
 */
export const resolveUnknown = async (ctx: FireContext, index: number, choice: SlotChoice): Promise<FireResult | null> => {
  ctx.deps.events.emit({
    kind: 'ambiguous',
    job: ctx.job,
    detail: 'the booking answer was not understood and a booking may exist: checking the calendar, nothing will be re-sent for this slot',
  });
  const looked = await pollOwnBooking(ctx, ctx.opts.reconcilePolls);
  if (looked.kind === 'none' && looked.lastDay !== null && slotTakenByOthers(looked.lastDay, choice)) {
    ctx.deps.logger.info({ jobId: ctx.job.id, courtId: choice.courtId }, 'the slot was taken by somebody else; trying the next choice');
    ctx.excluded.add(index);
    return null;
  }
  return settle(ctx, looked, 'unknown_response');
};

/**
 * A slot page nobody understands (nothing was sent). The calendar tells the one case that is not a mystery: the
 * slot was taken by somebody else, so the next choice is tried. Anything else stops the job.
 */
export const resolveUnknownForm = async (ctx: FireContext, index: number, choice: SlotChoice): Promise<FireResult | null> => {
  const day = await readDay(ctx, { reloggedIn: false }, 0);
  if (day !== null && !hasOwnBooking(day) && slotTakenByOthers(day, choice)) {
    ctx.deps.logger.info({ jobId: ctx.job.id, courtId: choice.courtId }, 'the slot page is gone, somebody else took the slot; trying the next choice');
    ctx.excluded.add(index);
    return null;
  }
  return failJob(ctx, 'unknown_form');
};

/**
 * "You already have a booking that day". Only a booking WE tried to make counts as success; one that predates
 * this job's first add_event is the owner's own and must not be reported as booked by the bot. When a request of this
 * job did go out, that booking is most likely ours: the calendar is watched as long as after any unclear answer, and a
 * calendar that never shows it ends in an alert, not in a plain "limit reached".
 */
export const reconcileAfterLimit = async (ctx: FireContext): Promise<FireResult> => {
  const sent = sentAttempts(ctx) > 0;
  const looked = await pollOwnBooking(ctx, sent ? ctx.opts.reconcilePolls : 1);
  if (looked.kind === 'found' && !sent) {
    ctx.deps.logger.info({ jobId: ctx.job.id }, 'own booking exists but no booking request was sent by this job');
    return failJob(ctx, 'daily_limit');
  }
  if (looked.kind === 'none' && sent) {
    ctx.deps.events.emit({
      kind: 'ambiguous',
      job: ctx.job,
      detail: 'the site reports a booking after our request but the calendar does not show it: it is probably ours, check the club site',
    });
    return failJob(ctx, 'ambiguous_unresolved');
  }
  return settle(ctx, looked, 'daily_limit');
};
