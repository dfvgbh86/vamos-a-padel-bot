import type { SlotRef } from '../contracts.js';
import type { PaymentMode } from '../reservaplay/bookingBody.js';
import { isCents, readWalletCents, type ProbeApi } from './apiProbes.js';
import { errorName, type JobsLogger } from './logger.js';

export const DEFAULT_ESTIMATED_PRICE_CENTS = 1902;

export interface FundsReport {
  readonly walletCents: number | null;
  readonly requiredCents: number | null;
  readonly requiredIsEstimate: boolean;
  readonly fundsOk: boolean;
}

export interface FundsRequest {
  readonly slot: SlotRef;
  readonly payment: PaymentMode;
  /** The site only prices a slot whose booking window is open. */
  readonly windowOpen: boolean;
  readonly estimatedPriceCents: number;
}

interface Quoted {
  /** The site's total, only when it is a usable amount. */
  readonly totalCents: number | null;
  /** The site's answer on the wallet option, only when it really is a boolean. */
  readonly walletPayable: boolean | null;
}

const quoteOrUndefined = async (
  api: ProbeApi,
  logger: JobsLogger,
  slot: SlotRef,
  payment: PaymentMode,
): Promise<Quoted | undefined> => {
  try {
    const quote = await api.quote(slot, payment);
    return {
      totalCents: isCents(quote.totalCents) && quote.totalCents > 0 ? quote.totalCents : null,
      walletPayable: typeof quote.walletPayable === 'boolean' ? quote.walletPayable : null,
    };
  } catch (error) {
    logger.warn({ errorName: errorName(error) }, 'price quote failed, using the estimate');
    return undefined;
  }
};

/**
 * The wallet option the site shows is the authority on affordability (CONTRACT C7): a disabled option is short whatever
 * the balance says, and a known balance must cover the price too. Without a balance only a site that confirms the
 * option can vouch for the funds; otherwise they cannot be verified, which is reported like a shortage.
 */
const fundsAreOk = (walletCents: number | null, requiredCents: number, siteSays: boolean | null): boolean => {
  if (siteSays === false) return false;
  if (walletCents === null) return siteSays === true;
  return walletCents >= requiredCents;
};

/**
 * Owner requirement: tell immediately when the wallet cannot cover the booking. Never throws and never blocks job
 * creation: `fundsOk: false` only makes the bot warn. A card booking is not paid from the wallet.
 */
export const assessFunds = async (api: ProbeApi, logger: JobsLogger, request: FundsRequest): Promise<FundsReport> => {
  if (request.payment !== 'wallet') {
    return { walletCents: null, requiredCents: null, requiredIsEstimate: false, fundsOk: true };
  }
  const [walletCents, quote] = await Promise.all([
    readWalletCents(api, logger),
    request.windowOpen ? quoteOrUndefined(api, logger, request.slot, request.payment) : undefined,
  ]);
  const quotedTotal = quote?.totalCents ?? null;
  const requiredCents = quotedTotal ?? request.estimatedPriceCents;
  return {
    walletCents,
    requiredCents,
    requiredIsEstimate: quotedTotal === null,
    fundsOk: fundsAreOk(walletCents, requiredCents, quote?.walletPayable ?? null),
  };
};
