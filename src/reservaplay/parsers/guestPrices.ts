import { htmlToText, normalizeText } from './html.js';
import { AMOUNT_WITH_EURO, parseMoneyCents } from './money.js';

const GUEST_PRICE = new RegExp(`invitado\\s+invitado\\s*-\\s*${AMOUNT_WITH_EURO}`, 'g');
const MAX_JSON_DEPTH = 8;
const MAX_STRINGS = 200;

/** Every string value of a JSON document (bounded), so prices can be found wherever the site puts its HTML. */
const collectStrings = (node: unknown, depth: number, out: string[]): void => {
  if (out.length >= MAX_STRINGS || depth > MAX_JSON_DEPTH) return;
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const child of node) collectStrings(child, depth + 1, out);
  else if (typeof node === 'object' && node !== null) for (const child of Object.values(node)) collectStrings(child, depth + 1, out);
};

const textsOf = (body: string): string[] => {
  try {
    const strings: string[] = [];
    collectStrings(JSON.parse(body) as unknown, 0, strings);
    return strings;
  } catch {
    return [body];
  }
};

/**
 * Guest prices ("Invitado Invitado - 5.34€", one per guest) in integer cents, from an HTML page or a JSON document that
 * carries HTML. Best effort: null when there is none or when any price is garbled (a partial list would understate the total).
 */
export const parseGuestPrices = (body: unknown): readonly number[] | null => {
  if (typeof body !== 'string') return null;
  const prices: number[] = [];
  for (const source of textsOf(body)) {
    const text = htmlToText(source);
    if (text === null) continue;
    for (const match of normalizeText(text).matchAll(GUEST_PRICE)) {
      const cents = parseMoneyCents(match[1] ?? '');
      if (cents === null) return null;
      prices.push(cents);
    }
  }
  return prices.length === 0 ? null : prices;
};
