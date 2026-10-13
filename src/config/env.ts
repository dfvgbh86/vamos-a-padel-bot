import { z } from 'zod';
import type { GameDate } from './gameDate.js';
import { buildHolidaySet } from './holidays.js';

export const DEFAULT_BASE_URL = 'https://enjoyvalenciaclubesoutdoor.reservaplay.com';
export const DEFAULT_DB_PATH = 'data/bot.sqlite';
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** The variables to read from; the caller decides where they come from (an entry point passes the real environment). */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface SiteEnv {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly holidays: ReadonlySet<GameDate>;
  /** As configured: a relative path is resolved by whoever opens the database. */
  readonly dbPath: string;
  readonly logLevel: LogLevel;
}

export interface Env extends SiteEnv {
  readonly telegramBotToken: string;
  /** Never empty: an empty allowlist is a startup error, not "everyone". */
  readonly allowedUserIds: readonly number[];
}

export interface TelegramTokenEnv {
  readonly telegramBotToken: string;
}

/** Names of the failing keys only: a value (token, password, id) never appears in the message. */
export class EnvError extends Error {
  constructor(
    readonly missing: readonly string[],
    readonly invalid: readonly string[],
  ) {
    super(describeProblems(missing, invalid));
    this.name = 'EnvError';
  }
}

const describeProblems = (missing: readonly string[], invalid: readonly string[]): string => {
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
  if (invalid.length > 0) parts.push(`invalid: ${invalid.join(', ')}`);
  return `Configuration error (${parts.join('; ')}). Copy .env.example to .env and fill it in.`;
};

const custom = (ctx: z.core.$RefinementCtx<string | undefined>, input: string | undefined): typeof z.NEVER => {
  ctx.issues.push({ code: 'custom', message: 'invalid', input });
  return z.NEVER;
};

const USER_ID = /^\d{1,16}$/;

const parseUserIds = (value: string): readonly number[] | null => {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return null;
  const ids = new Set<number>();
  for (const entry of entries) {
    if (!USER_ID.test(entry)) return null;
    const id = Number(entry);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    ids.add(id);
  }
  return [...ids];
};

/** Credentials travel to this address: https only, and no credentials, query or fragment in the URL itself. */
const parseBaseUrl = (value: string): string | null => {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
};

const fields = {
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1),
  TELEGRAM_ALLOWED_USER_IDS: z.string().transform((value, ctx) => {
    const ids = parseUserIds(value);
    return ids === null ? custom(ctx, value) : ids;
  }),
  RESERVAPLAY_BASE_URL: z
    .string()
    .transform((value, ctx) => parseBaseUrl(value) ?? custom(ctx, value))
    .default(DEFAULT_BASE_URL),
  RESERVAPLAY_USERNAME: z.string().trim().min(1),
  // Never trimmed: the value is the password exactly as the owner wrote it.
  RESERVAPLAY_PASSWORD: z.string().min(1),
  EXTRA_HOLIDAYS: z
    .string()
    .optional()
    .transform((value, ctx) => {
      try {
        return buildHolidaySet(value);
      } catch {
        return custom(ctx, value);
      }
    }),
  DB_PATH: z
    .string()
    .trim()
    .min(1)
    .refine((value) => !value.includes('\0'))
    .default(DEFAULT_DB_PATH),
  LOG_LEVEL: z.string().trim().toLowerCase().pipe(z.enum(LOG_LEVELS)).default('info'),
};

type Parsed = { [K in keyof typeof fields]: z.output<(typeof fields)[K]> };

const SITE_KEYS = [
  'RESERVAPLAY_BASE_URL',
  'RESERVAPLAY_USERNAME',
  'RESERVAPLAY_PASSWORD',
  'EXTRA_HOLIDAYS',
  'DB_PATH',
  'LOG_LEVEL',
] as const;
const ALL_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USER_IDS', ...SITE_KEYS] as const;
const TOKEN_KEYS = ['TELEGRAM_BOT_TOKEN'] as const;

/** A blank value counts as absent: an untouched `KEY=` line of a copied .env.example means "not set". */
const present = (value: string | undefined): string | undefined => (value === undefined || value.trim() === '' ? undefined : value);

const read = <K extends keyof Parsed>(source: EnvSource, keys: readonly K[]): Pick<Parsed, K> => {
  const raw: Record<string, string | undefined> = {};
  for (const key of keys) raw[key] = present(source[key]);
  const schema = z.object(Object.fromEntries(keys.map((key) => [key, fields[key]])));
  const result = schema.safeParse(raw);
  if (result.success) return result.data as Pick<Parsed, K>;

  const missing = new Set<string>();
  const invalid = new Set<string>();
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key === '') continue;
    (raw[key] === undefined ? missing : invalid).add(key);
  }
  throw new EnvError(
    keys.filter((key) => missing.has(key)),
    keys.filter((key) => invalid.has(key)),
  );
};

const toSiteEnv = (parsed: Pick<Parsed, (typeof SITE_KEYS)[number]>): SiteEnv => ({
  baseUrl: parsed.RESERVAPLAY_BASE_URL,
  username: parsed.RESERVAPLAY_USERNAME,
  password: parsed.RESERVAPLAY_PASSWORD,
  holidays: parsed.EXTRA_HOLIDAYS,
  dbPath: parsed.DB_PATH,
  logLevel: parsed.LOG_LEVEL,
});

/** Everything the bot needs. Throws EnvError naming the missing or invalid keys. */
export const loadEnv = (source: EnvSource): Env => {
  const parsed = read(source, ALL_KEYS);
  return { ...toSiteEnv(parsed), telegramBotToken: parsed.TELEGRAM_BOT_TOKEN, allowedUserIds: parsed.TELEGRAM_ALLOWED_USER_IDS };
};

/** The club account only (CLI checks): no Telegram settings are required. */
export const loadSiteEnv = (source: EnvSource): SiteEnv => toSiteEnv(read(source, SITE_KEYS));

/** The bot token only (finding out the owner's Telegram id, before the allowlist exists). */
export const loadTelegramTokenEnv = (source: EnvSource): TelegramTokenEnv => ({
  telegramBotToken: read(source, TOKEN_KEYS).TELEGRAM_BOT_TOKEN,
});

/** Variable names in the order .env.example documents them. */
export const ENV_KEYS: readonly string[] = ALL_KEYS;
