import { allowedCourtIds } from '../config/courts.js';
import { parseGameDate, type GameDate } from '../config/gameDate.js';
import type { CreateJobResult, SlotChoice } from '../contracts.js';
import {
  DEFAULT_DURATION_MINUTES,
  MAX_DURATION_MINUTES,
  MIN_DURATION_MINUTES,
  type PaymentMode,
} from '../reservaplay/bookingBody.js';
import { addDays } from './clubTime.js';

export const MAX_DAYS_AHEAD = 20;

export type Rejected = Extract<CreateJobResult, { readonly kind: 'rejected' }>;

export const rejected = (reason: Rejected['reason'], detail: string): Rejected => ({ kind: 'rejected', reason, detail });

export type NonEmptyChoices = readonly [SlotChoice, ...SlotChoice[]];

export interface ValidInput {
  readonly gameDate: GameDate;
  readonly choices: NonEmptyChoices;
  readonly durationMinutes: number;
  readonly payment: PaymentMode;
}

export type InputCheck = { readonly kind: 'valid'; readonly value: ValidInput } | Rejected;

const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

const readChoice = (raw: unknown): SlotChoice | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { courtId, startMinutes } = raw as { courtId?: unknown; startMinutes?: unknown };
  if (!isIntegerIn(courtId, 1, Number.MAX_SAFE_INTEGER)) return undefined;
  if (!isIntegerIn(startMinutes, 0, 24 * 60 - 1)) return undefined;
  return { courtId, startMinutes };
};

const readGameDate = (raw: unknown): GameDate | undefined => {
  try {
    return parseGameDate(raw);
  } catch {
    return undefined;
  }
};

const readChoices = (raw: unknown): NonEmptyChoices | string => {
  if (!Array.isArray(raw)) return 'choices must be a non-empty list';
  const choices: SlotChoice[] = [];
  for (const entry of raw as readonly unknown[]) {
    const choice = readChoice(entry);
    if (choice === undefined) return 'every choice needs an integer courtId and startMinutes within 0..1439';
    choices.push(choice);
  }
  const [first, ...rest] = choices;
  if (first === undefined) return 'choices must be a non-empty list';
  const keys = new Set(choices.map((choice) => `${choice.courtId}:${choice.startMinutes}`));
  return keys.size === choices.length ? [first, ...rest] : 'choices must not repeat the same court and start time';
};

/** Snapshot of the caller's input: every field is read exactly once, extra properties are dropped. */
export const checkCreateInput = (input: unknown): InputCheck => {
  if (typeof input !== 'object' || input === null) return rejected('invalid_input', 'input must be an object');
  const raw = input as Record<string, unknown>;
  const gameDate = readGameDate(raw['gameDate']);
  if (gameDate === undefined) return rejected('invalid_input', 'gameDate must be a real date as YYYY-MM-DD');
  const choices = readChoices(raw['choices']);
  if (typeof choices === 'string') return rejected('invalid_input', choices);
  const durationMinutes = raw['durationMinutes'] === undefined ? DEFAULT_DURATION_MINUTES : raw['durationMinutes'];
  if (!isIntegerIn(durationMinutes, MIN_DURATION_MINUTES, MAX_DURATION_MINUTES)) {
    return rejected('invalid_input', `durationMinutes must be an integer within ${MIN_DURATION_MINUTES}..${MAX_DURATION_MINUTES}`);
  }
  const payment = raw['payment'] === undefined ? 'wallet' : raw['payment'];
  if (payment !== 'wallet' && payment !== 'card') return rejected('invalid_input', `payment must be 'wallet' or 'card'`);
  return { kind: 'valid', value: { gameDate, choices, durationMinutes, payment } };
};

/** `today` is the club-time date of the injected clock. Today itself is allowed. */
export const checkDateRange = (gameDate: GameDate, today: GameDate): Rejected | undefined => {
  if (gameDate < today) return rejected('date_in_past', `${gameDate} is before today (${today}) in club time`);
  if (gameDate > addDays(today, MAX_DAYS_AHEAD)) {
    return rejected('date_too_far', `${gameDate} is more than ${MAX_DAYS_AHEAD} days ahead`);
  }
  return undefined;
};

const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * A job for today whose slot has already started would fire at once for a slot in the past: the window for today
 * opened a week ago. `minuteOfDay` is the club clock now; a start in the current minute counts as begun.
 */
export const checkStartsNotPassed = (
  gameDate: GameDate,
  choices: readonly SlotChoice[],
  today: GameDate,
  minuteOfDay: number,
): Rejected | undefined => {
  if (gameDate !== today) return undefined;
  const begun = choices.find((choice) => choice.startMinutes <= minuteOfDay);
  if (begun === undefined) return undefined;
  return rejected('invalid_input', `a start at ${clock(begun.startMinutes)} has already passed today (now ${clock(minuteOfDay)} club time)`);
};

export const checkCourts = (
  gameDate: GameDate,
  choices: readonly SlotChoice[],
  holidays: ReadonlySet<GameDate>,
): Rejected | undefined => {
  const allowed = allowedCourtIds(gameDate, holidays);
  const forbidden = [...new Set(choices.map((choice) => choice.courtId))].filter((courtId) => !allowed.includes(courtId));
  if (forbidden.length === 0) return undefined;
  return rejected('court_not_allowed', `court id ${forbidden.join(', ')} not allowed on ${gameDate}`);
};
