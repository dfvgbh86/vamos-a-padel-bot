import { htmlToText, normalizeText } from './html.js';
import { AMOUNT_WITH_EURO, parseMoneyCents } from './money.js';

const WALLET_SENTENCE = new RegExp(`dispones de\\s+${AMOUNT_WITH_EURO}\\s+en tu monedero virtual`);

/** "Actualmente dispones de 19.02 € en tu monedero virtual" to integer cents; null when absent or garbled. */
export const parseWalletCents = (html: unknown): number | null => {
  const text = htmlToText(html);
  if (text === null) return null;
  const amount = WALLET_SENTENCE.exec(normalizeText(text))?.[1];
  return amount === undefined ? null : parseMoneyCents(amount);
};
