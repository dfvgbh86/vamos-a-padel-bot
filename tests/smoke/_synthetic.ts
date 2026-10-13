import { randomBytes, randomInt } from 'node:crypto';
import { DateTime } from 'luxon';

/** Everything the smoke test needs a secret for, generated fresh for every run: nothing here belongs to a real account. */
export interface Synthetic {
  readonly botToken: string;
  /** The part of the token after the colon (what an attacker would need). */
  readonly botTokenSecret: string;
  readonly ownerId: number;
  readonly strangerId: number;
  readonly username: string;
  /** Deliberately awkward: a space and a `#` (the README's quoting rule for .env values). */
  readonly password: string;
  readonly csrfToken: string;
  readonly guestSession: string;
  readonly authedSession: string;
  readonly xsrfCookie: string;
  /** 40 lowercase hex characters, like the account hash of the booking form. */
  readonly hash: string;
  readonly accountId: number;
  readonly reservationId: number;
}

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

export const createSynthetic = (): Synthetic => {
  const botTokenSecret = `TEST${hex(16)}`;
  const ownerId = randomInt(100_000_000, 900_000_000);
  return {
    botToken: `${randomInt(100_000_000, 999_999_999)}:${botTokenSecret}`,
    botTokenSecret,
    ownerId,
    strangerId: ownerId + randomInt(1, 1000),
    username: `smoke-player-${hex(4)}`,
    password: `pw #${hex(8)} end`,
    csrfToken: `csrf${hex(12)}`,
    guestSession: `guest${hex(12)}`,
    authedSession: `authed${hex(12)}`,
    xsrfCookie: `xsrf${hex(12)}`,
    hash: hex(20),
    accountId: randomInt(100_000, 900_000),
    reservationId: randomInt(100_000, 900_000),
  };
};

/** Calendar day (YYYY-MM-DD) of the club, `daysAhead` days from now, the way the club's own clock counts. */
export const clubDate = (daysAhead: number): string => {
  const date = DateTime.now().setZone('Europe/Madrid').plus({ days: daysAhead }).toISODate();
  if (date === null) throw new Error('could not compute the club date');
  return date;
};

/** Every value that must never reach a log line, a Telegram message or the other fake server. */
export const secretsOf = (synthetic: Synthetic): readonly string[] => [
  synthetic.password,
  synthetic.password.slice(3, -4),
  synthetic.botToken,
  synthetic.botTokenSecret,
  synthetic.csrfToken,
  synthetic.guestSession,
  synthetic.authedSession,
  synthetic.xsrfCookie,
  synthetic.hash,
];
