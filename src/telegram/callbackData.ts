import { parseGameDate, type GameDate } from '../config/gameDate.js';

/**
 * callback_data is attacker-controllable input (a modified client can send anything), so it is parsed
 * strictly and every value is checked again against the service at the moment of use.
 * Layout: `<flow>:<action>:<sid>[:args]`, at most 64 bytes (Telegram limit); `sid` identifies the
 * in-memory conversation, so buttons of a previous conversation or of a restarted bot are recognised as stale.
 */
export type CallbackAction =
  | { readonly type: 'pickDate'; readonly sid: string; readonly date: GameDate }
  | { readonly type: 'pickCourt'; readonly sid: string; readonly courtId: number }
  | { readonly type: 'pickTime'; readonly sid: string; readonly courtId: number; readonly startMinutes: number }
  | { readonly type: 'setDuration'; readonly sid: string; readonly minutes: number }
  | { readonly type: 'undo'; readonly sid: string }
  | { readonly type: 'toCourts'; readonly sid: string }
  | { readonly type: 'toDates'; readonly sid: string }
  | { readonly type: 'review'; readonly sid: string }
  | { readonly type: 'confirm'; readonly sid: string }
  | { readonly type: 'abort'; readonly sid: string }
  | { readonly type: 'cancelYes'; readonly sid: string }
  | { readonly type: 'cancelNo'; readonly sid: string };

export const MAX_CALLBACK_DATA_BYTES = 64;
export const SESSION_ID_PATTERN = /^[0-9a-f]{6}$/;

const SID = '([0-9a-f]{6})';
const MAX_MINUTES = 24 * 60 - 1;

const simple = (type: 'undo' | 'toCourts' | 'toDates' | 'review' | 'confirm' | 'abort' | 'cancelYes' | 'cancelNo') =>
  (match: RegExpExecArray): CallbackAction | null => ({ type, sid: match[1] as string });

const parseDate = (raw: string): GameDate | null => {
  try {
    return parseGameDate(raw);
  } catch {
    return null;
  }
};

interface Rule {
  readonly pattern: RegExp;
  readonly build: (match: RegExpExecArray) => CallbackAction | null;
}

const RULES: readonly Rule[] = [
  {
    pattern: new RegExp(`^n:d:${SID}:(\\d{4}-\\d{2}-\\d{2})$`),
    build: (match) => {
      const date = parseDate(match[2] as string);
      return date === null ? null : { type: 'pickDate', sid: match[1] as string, date };
    },
  },
  {
    pattern: new RegExp(`^n:c:${SID}:(\\d{1,3})$`),
    build: (match) => ({ type: 'pickCourt', sid: match[1] as string, courtId: Number(match[2]) }),
  },
  {
    pattern: new RegExp(`^n:t:${SID}:(\\d{1,3}):(\\d{1,4})$`),
    build: (match) => {
      const startMinutes = Number(match[3]);
      if (startMinutes > MAX_MINUTES) return null;
      return { type: 'pickTime', sid: match[1] as string, courtId: Number(match[2]), startMinutes };
    },
  },
  {
    pattern: new RegExp(`^n:m:${SID}:(60|90)$`),
    build: (match) => ({ type: 'setDuration', sid: match[1] as string, minutes: Number(match[2]) }),
  },
  { pattern: new RegExp(`^n:u:${SID}$`), build: simple('undo') },
  { pattern: new RegExp(`^n:k:${SID}$`), build: simple('toCourts') },
  { pattern: new RegExp(`^n:r:${SID}$`), build: simple('toDates') },
  { pattern: new RegExp(`^n:g:${SID}$`), build: simple('review') },
  { pattern: new RegExp(`^n:y:${SID}$`), build: simple('confirm') },
  { pattern: new RegExp(`^n:x:${SID}$`), build: simple('abort') },
  { pattern: new RegExp(`^x:y:${SID}$`), build: simple('cancelYes') },
  { pattern: new RegExp(`^x:n:${SID}$`), build: simple('cancelNo') },
];

/** Returns null for anything that is not exactly one of the known shapes. */
export const parseCallbackData = (raw: unknown): CallbackAction | null => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CALLBACK_DATA_BYTES) return null;
  for (const rule of RULES) {
    const match = rule.pattern.exec(raw);
    if (match !== null) return rule.build(match);
  }
  return null;
};

const checked = (data: string): string => {
  if (new TextEncoder().encode(data).length > MAX_CALLBACK_DATA_BYTES) {
    throw new Error(`callback_data exceeds ${MAX_CALLBACK_DATA_BYTES} bytes`);
  }
  return data;
};

export const encodeCallbackData = (action: CallbackAction): string => {
  switch (action.type) {
    case 'pickDate':
      return checked(`n:d:${action.sid}:${action.date}`);
    case 'pickCourt':
      return checked(`n:c:${action.sid}:${action.courtId}`);
    case 'pickTime':
      return checked(`n:t:${action.sid}:${action.courtId}:${action.startMinutes}`);
    case 'setDuration':
      return checked(`n:m:${action.sid}:${action.minutes}`);
    case 'undo':
      return checked(`n:u:${action.sid}`);
    case 'toCourts':
      return checked(`n:k:${action.sid}`);
    case 'toDates':
      return checked(`n:r:${action.sid}`);
    case 'review':
      return checked(`n:g:${action.sid}`);
    case 'confirm':
      return checked(`n:y:${action.sid}`);
    case 'abort':
      return checked(`n:x:${action.sid}`);
    case 'cancelYes':
      return checked(`x:y:${action.sid}`);
    case 'cancelNo':
      return checked(`x:n:${action.sid}`);
  }
};
