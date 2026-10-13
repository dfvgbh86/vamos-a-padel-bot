import { assertCourtAllowed, CourtNotAllowedError } from '../config/courts.js';
import type { BookRequest, BookResult, FormGate, Job, SlotChoice } from '../contracts.js';
import { AuthExpiredError } from '../reservaplay/errors.js';
import { MAX_SLEEP_CHUNK_MS, sleepFor } from './clock.js';
import { createFireContext, slotFor, sentAttempts, type FireContext, type FireDeps, type OpenGate } from './fireContext.js';
import { abortedResult, failJob, failUnexpected, finishBooked } from './fireFinish.js';
import { relogin } from './fireLogin.js';
import { reconcileAfterLimit, reconcileUnclear, resolveUnknown, resolveUnknownForm } from './fireReconcile.js';
import { resolveFireOptions, type FireResult } from './fireTypes.js';
import { describeError, InvariantError } from './types.js';

export type { FireDeps } from './fireContext.js';
export { UNKNOWN_RESERVATION_ID, type FireFailureReason, type FireOptions, type FireResult } from './fireTypes.js';

/** Keyed by api object, i.e. by account/session: at most ONE add_event in flight (PLAN 3a, item 2). */
const bookingInFlight = new WeakSet<object>();

type Probe =
  | { readonly kind: 'gate'; readonly gate: FormGate }
  | { readonly kind: 'retry' }
  | { readonly kind: 'result'; readonly result: FireResult };

type Sent = BookResult | { readonly kind: 'refused_locally' };

const checkHalt = (ctx: FireContext): FireResult | null => {
  if (ctx.deps.signal?.aborted === true) return abortedResult(ctx);
  if (ctx.deps.store.isStopped()) return failJob(ctx, 'stopped');
  if (ctx.deps.clock.nowMs() > ctx.deadlineMs) return failJob(ctx, 'window_timeout');
  return null;
};

const preChecks = (ctx: FireContext): FireResult | null => {
  const { job, deps } = ctx;
  if (job.payment === 'card' && deps.allowCardPayment !== true) return failJob(ctx, 'card_not_allowed');
  if (job.choices.length === 0) return failJob(ctx, 'no_choice_available');
  try {
    for (const choice of job.choices) assertCourtAllowed(choice.courtId, job.gameDate, deps.holidays);
  } catch (error) {
    if (error instanceof CourtNotAllowedError) return failJob(ctx, 'court_not_allowed');
    throw error;
  }
  return null;
};

const waitForFirstProbe = async (ctx: FireContext): Promise<FireResult | null> => {
  const firstProbeAtMs = ctx.job.opensAtMs - ctx.opts.leadMs;
  for (;;) {
    const halt = checkHalt(ctx);
    if (halt !== null) return halt;
    const remaining = firstProbeAtMs - ctx.deps.clock.nowMs();
    if (remaining <= 0) return null;
    await ctx.deps.clock.sleep(Math.min(Math.ceil(remaining), MAX_SLEEP_CHUNK_MS));
  }
};

const nextChoiceIndex = (ctx: FireContext): number | null => {
  const index = ctx.job.choices.findIndex((_, i) => !ctx.excluded.has(i));
  return index === -1 ? null : index;
};

const choiceAt = (ctx: FireContext, index: number): SlotChoice => {
  const choice = ctx.job.choices[index];
  if (choice === undefined) throw new InvariantError('choice index out of range');
  return choice;
};

/**
 * One probe. A failed probe (5xx, reset, timeout) is normal around the opening: it is answered with a short pause and
 * another probe, and the job only fails after a long stretch without a single answer from the site.
 */
const probeSlot = async (ctx: FireContext, index: number): Promise<Probe> => {
  const { api, clock, logger } = ctx.deps;
  await ctx.pace();
  ctx.openGate = null;
  const startedMs = clock.monotonicMs();
  try {
    const gate = await api.probeForm(slotFor(ctx.job, choiceAt(ctx, index)));
    ctx.probeOutageStartedMs = null;
    if (gate.kind !== 'unknown') ctx.unknownFormStreak = 0;
    if (gate.kind === 'open') ctx.openGate = { hash: gate.hash, choiceIndex: index };
    return { kind: 'gate', gate };
  } catch (error) {
    if (error instanceof AuthExpiredError) {
      ctx.probeOutageStartedMs = null;
      return { kind: 'gate', gate: { kind: 'login_required' } };
    }
    ctx.probeOutageStartedMs ??= startedMs;
    const outageMs = clock.monotonicMs() - ctx.probeOutageStartedMs;
    logger.warn({ jobId: ctx.job.id, outageMs, ...describeError(error) }, 'slot probe failed');
    if (outageMs > ctx.opts.maxProbeOutageMs) return { kind: 'result', result: failJob(ctx, 'probe_failed') };
    await sleepFor(clock, ctx.opts.probeErrorBackoffMs);
    return { kind: 'retry' };
  }
};

/** The ONLY way to obtain the permission to send a booking: the latest probe must have been `open`, and it is used up. */
const takeOpenGate = (ctx: FireContext, index: number): OpenGate => {
  const gate = ctx.openGate;
  ctx.openGate = null;
  if (gate === null || gate.choiceIndex !== index) {
    throw new InvariantError('a booking request needs the latest probe of that slot to be open');
  }
  return gate;
};

const sendBook = async (ctx: FireContext, choice: SlotChoice, gate: OpenGate): Promise<Sent> => {
  const { api, holidays, logger } = ctx.deps;
  const request: BookRequest = {
    slot: slotFor(ctx.job, choice),
    account: { accountId: ctx.deps.account.accountId, hash: gate.hash },
    payment: ctx.job.payment,
    holidays,
  };
  ctx.pace.mark();
  bookingInFlight.add(api);
  try {
    return await api.book(request);
  } catch (error) {
    if (error instanceof AuthExpiredError) return { kind: 'rejected', outcome: { kind: 'auth_expired' } };
    if (error instanceof CourtNotAllowedError) return { kind: 'refused_locally' };
    logger.error({ jobId: ctx.job.id, ...describeError(error) }, 'book() threw; treating the outcome as unclear');
    return { kind: 'ambiguous' };
  } finally {
    bookingInFlight.delete(api);
  }
};

const handleNotSent = async (ctx: FireContext): Promise<FireResult | null> => {
  ctx.notSent++;
  if (ctx.notSent > ctx.opts.maxNotSentRetries) return failJob(ctx, 'not_sent_exhausted');
  ctx.deps.logger.warn({ jobId: ctx.job.id, notSent: ctx.notSent }, 'booking request did not leave the machine; probing again');
  await sleepFor(ctx.deps.clock, ctx.opts.notSentDelayMs);
  return null;
};

/**
 * Answers of a gateway or rate limiter in front of the site: the request was refused before it was processed. They are
 * still checked against the calendar (briefly) and only a fresh open gate allows another request, bounded by maxAttempts.
 */
const NOT_PROCESSED_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);
const NOT_PROCESSED_POLLS = 2;

type Rejected = Extract<BookResult, { kind: 'rejected' }>['outcome'];

const handleRejected = async (ctx: FireContext, index: number, outcome: Rejected): Promise<FireResult | null> => {
  switch (outcome.kind) {
    case 'not_open_yet':
      return null;
    case 'daily_limit':
      return reconcileAfterLimit(ctx);
    case 'too_short':
      ctx.excluded.add(index);
      return null;
    case 'auth_expired':
      return relogin(ctx);
    case 'server_error':
      return reconcileUnclear(ctx, `server error ${String(outcome.status)}`);
    case 'unknown':
      if (NOT_PROCESSED_STATUSES.has(outcome.status)) return reconcileUnclear(ctx, `HTTP ${String(outcome.status)}`, NOT_PROCESSED_POLLS);
      ctx.deps.logger.error({ jobId: ctx.job.id, status: outcome.status }, 'booking answer not understood; stopping');
      return resolveUnknown(ctx, index, choiceAt(ctx, index));
  }
};

const handleSent = async (ctx: FireContext, index: number, choice: SlotChoice, sent: Sent): Promise<FireResult | null> => {
  switch (sent.kind) {
    case 'booked':
      return finishBooked(ctx, choice, sent.reservationId);
    case 'rejected':
      return handleRejected(ctx, index, sent.outcome);
    case 'ambiguous':
      return reconcileUnclear(ctx, 'no clear answer');
    case 'not_sent':
      return handleNotSent(ctx);
    case 'refused_locally':
      return failJob(ctx, 'court_not_allowed');
  }
};

const announceWindowOpen = (ctx: FireContext): void => {
  if (ctx.windowAnnounced) return;
  ctx.windowAnnounced = true;
  ctx.deps.events.emit({ kind: 'window_open', job: ctx.job });
};

const attemptBooking = async (ctx: FireContext, index: number): Promise<FireResult | null> => {
  const { api, store, clock, logger } = ctx.deps;
  const choice = choiceAt(ctx, index);
  announceWindowOpen(ctx);
  if (sentAttempts(ctx) >= ctx.opts.maxAttempts) return failJob(ctx, 'max_attempts');
  const halt = checkHalt(ctx);
  if (halt !== null) return halt;
  if (bookingInFlight.has(api)) {
    logger.warn({ jobId: ctx.job.id }, 'another booking request is in flight; waiting for it before sending');
    return null;
  }
  // Nothing below awaits until api.book() has been invoked: the checks above cannot go stale.
  const gate = takeOpenGate(ctx, index);
  const counted = store.transition(ctx.job.id, 'firing', 'firing', clock.nowMs(), { attemptsDelta: 1 });
  if (counted === undefined) {
    logger.warn({ jobId: ctx.job.id }, 'job is no longer firing; no booking request sent');
    return { kind: 'job_changed' };
  }
  ctx.job = counted;
  ctx.booksStarted++;
  return handleSent(ctx, index, choice, await sendBook(ctx, choice, gate));
};

/** Nothing was sent, so a page nobody understands is cheap to look at again: it is often a truncated or interstitial page. */
const handleUnknownForm = async (ctx: FireContext, index: number): Promise<FireResult | null> => {
  ctx.unknownFormStreak++;
  if (ctx.unknownFormStreak < ctx.opts.maxUnknownFormProbes) {
    ctx.deps.logger.warn({ jobId: ctx.job.id, streak: ctx.unknownFormStreak }, 'slot page not understood; probing again');
    return null;
  }
  ctx.unknownFormStreak = 0;
  return resolveUnknownForm(ctx, index, choiceAt(ctx, index));
};

const handleGate = async (ctx: FireContext, index: number, gate: FormGate): Promise<FireResult | null> => {
  switch (gate.kind) {
    case 'window_closed':
      return null;
    case 'open':
      return attemptBooking(ctx, index);
    case 'daily_limit':
      return reconcileAfterLimit(ctx);
    case 'too_short':
      ctx.excluded.add(index);
      return null;
    case 'login_required':
      return relogin(ctx);
    case 'unknown':
      return handleUnknownForm(ctx, index);
  }
};

const step = async (ctx: FireContext): Promise<FireResult | null> => {
  const halt = checkHalt(ctx);
  if (halt !== null) return halt;
  const index = nextChoiceIndex(ctx);
  if (index === null) return failJob(ctx, 'no_choice_available');
  const probe = await probeSlot(ctx, index);
  if (probe.kind === 'result') return probe.result;
  if (probe.kind === 'retry') return null;
  return handleGate(ctx, index, probe.gate);
};

/**
 * The firing loop (PLAN 3a / 4). The window is never bypassed: a booking request is built only after the server
 * itself rendered an open form for that very slot, one request at a time, and an unclear outcome is reconciled
 * against the calendar first (a 5xx or a lost answer may go back to the gate when nothing was found, an answer nobody
 * understood never does for the same slot). The job must already be in the `firing` state.
 */
export const runFiring = async (job: Job, deps: FireDeps): Promise<FireResult> => {
  const ctx = createFireContext(job, deps, resolveFireOptions(deps.options));
  try {
    const early = preChecks(ctx) ?? (await waitForFirstProbe(ctx));
    if (early !== null) return early;
    for (;;) {
      const result = await step(ctx);
      if (result !== null) return result;
    }
  } catch (error) {
    return failUnexpected(ctx, error);
  }
};
