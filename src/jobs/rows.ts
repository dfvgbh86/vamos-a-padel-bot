import { z } from 'zod';
import { parseGameDate, type GameDate } from '../config/gameDate.js';
import type { Job, NewJob, SlotChoice } from '../contracts.js';
import { CorruptJobStoreError, InvalidJobInputError } from './errors.js';
import { isJobState } from './transitions.js';

export const MAX_FAILURE_REASON_LENGTH = 500;
const MAX_STORED_DURATION_MINUTES = 24 * 60;
const MAX_ISSUE_FIELDS = 8;

const epochMs = z.number().int().nonnegative();

/** Timestamp from an injected clock: a fractional value is rounded, because bookkeeping must never veto a record. */
const clockMs = z
  .number()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .transform((value) => Math.round(value));

const gameDate = z.string().transform((value, ctx): GameDate => {
  try {
    return parseGameDate(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'not a game date' });
    return z.NEVER;
  }
});

const slotChoice = z.object({
  courtId: z.number().int().positive(),
  startMinutes: z.number().int().min(0).max(24 * 60 - 1),
});

const hasNoDuplicates = (choices: readonly SlotChoice[]): boolean =>
  new Set(choices.map((choice) => `${choice.courtId}:${choice.startMinutes}`)).size === choices.length;

const choices = z.array(slotChoice).min(1).refine(hasNoDuplicates, { message: 'duplicate choices' });
const durationMinutes = z.number().int().min(1).max(MAX_STORED_DURATION_MINUTES);
const payment = z.enum(['wallet', 'card']);

const jsonColumn = <T extends z.ZodType>(schema: T) =>
  z
    .string()
    .transform((text, ctx): unknown => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'not valid JSON' });
        return z.NEVER;
      }
    })
    .pipe(schema);

const jobRow = z
  .object({
    id: z.number().int().positive(),
    game_date: gameDate,
    choices: jsonColumn(choices),
    duration_minutes: durationMinutes,
    payment,
    state: z.custom<Job['state']>(isJobState),
    opens_at_ms: epochMs,
    reservation_id: z.number().int().positive().nullable(),
    booked_choice: jsonColumn(slotChoice).nullable(),
    failure_reason: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
    created_at_ms: epochMs,
    updated_at_ms: epochMs,
  })
  .transform(
    (row): Job => ({
      id: row.id,
      gameDate: row.game_date,
      choices: row.choices,
      durationMinutes: row.duration_minutes,
      payment: row.payment,
      state: row.state,
      opensAtMs: row.opens_at_ms,
      reservationId: row.reservation_id,
      bookedChoice: row.booked_choice,
      failureReason: row.failure_reason,
      attempts: row.attempts,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    }),
  );

const issueFields = (error: z.ZodError): readonly string[] => {
  const fields = error.issues.map((issue) => issue.path.map(String).join('.') || '(value)');
  return [...new Set(fields)].slice(0, MAX_ISSUE_FIELDS);
};

const rowLabel = (raw: unknown): string => {
  const id = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
  return typeof id === 'number' && Number.isSafeInteger(id) ? `jobs row ${id}` : 'jobs row';
};

/** Rows from node:sqlite have a null prototype and untyped columns: everything is re-validated here. */
export const parseJobRow = (raw: unknown): Job => {
  const parsed = jobRow.safeParse(typeof raw === 'object' && raw !== null ? { ...raw } : raw);
  if (!parsed.success) throw new CorruptJobStoreError(rowLabel(raw), issueFields(parsed.error));
  return parsed.data;
};

const metaStopped = z.enum(['0', '1']);

export const parseStoppedFlag = (raw: unknown): boolean => {
  if (raw === undefined) return false;
  const value = typeof raw === 'object' && raw !== null ? (raw as { value?: unknown }).value : undefined;
  const parsed = metaStopped.safeParse(value);
  if (!parsed.success) throw new CorruptJobStoreError('meta row stopped', ['value']);
  return parsed.data === '1';
};

const newJobInput = z.object({ gameDate, choices, durationMinutes, payment });

export interface ValidatedNewJob {
  readonly job: NewJob;
  readonly opensAtMs: number;
  readonly nowMs: number;
}

const inputError = (context: string, error: z.ZodError): InvalidJobInputError =>
  new InvalidJobInputError(issueFields(error), context);

export const validateNewJob = (job: unknown, opensAtMs: unknown, nowMs: unknown): ValidatedNewJob => {
  const parsed = z.object({ job: newJobInput, opensAtMs: epochMs, nowMs: clockMs }).safeParse({ job, opensAtMs, nowMs });
  if (!parsed.success) throw inputError('create', parsed.error);
  const value = parsed.data;
  return {
    job: {
      gameDate: value.job.gameDate,
      choices: value.job.choices.map((choice) => ({ courtId: choice.courtId, startMinutes: choice.startMinutes })),
      durationMinutes: value.job.durationMinutes,
      payment: value.job.payment,
    },
    opensAtMs: value.opensAtMs,
    nowMs: value.nowMs,
  };
};

const patchInput = z.object({
  reservationId: z.number().int().positive().optional(),
  bookedChoice: slotChoice.optional(),
  failureReason: z
    .string()
    .transform((reason) => reason.slice(0, MAX_FAILURE_REASON_LENGTH))
    .optional(),
  attemptsDelta: z.number().int().nonnegative().optional(),
});

/** Named bind parameters of the transition UPDATE: `null` leaves a column unchanged (COALESCE). */
export interface TransitionParams {
  readonly now_ms: number;
  readonly reservation_id: number | null;
  readonly booked_choice: string | null;
  readonly failure_reason: string | null;
  readonly attempts_delta: number;
}

export const validateTransitionArgs = (nowMs: unknown, patch: unknown): TransitionParams => {
  const parsed = z.object({ nowMs: clockMs, patch: patchInput }).safeParse({ nowMs, patch });
  if (!parsed.success) throw inputError('transition', parsed.error);
  const { patch: value } = parsed.data;
  return {
    now_ms: parsed.data.nowMs,
    reservation_id: value.reservationId ?? null,
    booked_choice: value.bookedChoice
      ? JSON.stringify({ courtId: value.bookedChoice.courtId, startMinutes: value.bookedChoice.startMinutes })
      : null,
    failure_reason: value.failureReason ?? null,
    attempts_delta: value.attemptsDelta ?? 0,
  };
};
