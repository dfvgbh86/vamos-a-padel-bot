import type { GameDate } from '../config/gameDate.js';
import type { ReservaplayApi } from '../contracts.js';
import { AuthExpiredError } from '../reservaplay/errors.js';
import { errorName, type JobsLogger } from './logger.js';

export type ProbeApi = Pick<ReservaplayApi, 'getDay' | 'getWallet' | 'quote' | 'keepAlive'>;

export const isCents = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Wallet balance in cents, or null when it cannot be read or the answer is not a sane amount. Never throws. */
export const readWalletCents = async (api: ProbeApi, logger: JobsLogger): Promise<number | null> => {
  try {
    const { balanceCents } = await api.getWallet();
    if (isCents(balanceCents)) return balanceCents;
    logger.warn({}, 'wallet balance has an unexpected shape');
    return null;
  } catch (error) {
    logger.warn({ errorName: errorName(error) }, 'wallet balance could not be read');
    return null;
  }
};

export type OwnBookingProbe = 'present' | 'absent' | 'unknown';

/**
 * Does the account hold a booking on `gameDate`? 'absent' only when a calendar with slots was read and none is the
 * account's own: an empty or unreadable answer proves nothing. Never throws.
 */
export const probeOwnBooking = async (api: ProbeApi, logger: JobsLogger, gameDate: GameDate): Promise<OwnBookingProbe> => {
  try {
    const slots = (await api.getDay(gameDate)).courts.flatMap((court) => court.slots);
    if (slots.some((slot) => slot.ownBooking)) return 'present';
    return slots.length > 0 ? 'absent' : 'unknown';
  } catch (error) {
    logger.warn({ gameDate, errorName: errorName(error) }, 'own-booking check failed, the form gate will decide');
    return 'unknown';
  }
};

/** true: session confirmed alive; false: the site says it expired; null: could not be determined (network, server). */
export const probeSession = async (api: ProbeApi, logger: JobsLogger): Promise<boolean | null> => {
  try {
    await api.keepAlive();
    return true;
  } catch (error) {
    if (error instanceof AuthExpiredError) return false;
    logger.warn({ errorName: errorName(error) }, 'session liveness could not be determined');
    return null;
  }
};
