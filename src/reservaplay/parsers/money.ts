const PLAIN = /^(\d{1,9})(?:[.,](\d{1,2}))?$/;
const GROUPED = /^(\d{1,3})((?:[.,]\d{3})+)([.,])(\d{1,2})$/;

const toCents = (euros: string, fraction: string | undefined): number | null => {
  const cents = Number(euros) * 100 + Number((fraction ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
};

/**
 * "19.02", "19,02", "19", "1.234,56" or "1,234.56" to integer euro cents, digit by digit (no float arithmetic
 * on the fraction). Thousands separators are accepted only together with decimals and a different decimal
 * separator, so "19.021" or "1.234" (thousands or decimals?) are rejected rather than guessed. Anything else is null.
 */
export const parseMoneyCents = (token: string): number | null => {
  const text = token.trim();
  const plain = PLAIN.exec(text);
  if (plain !== null) return toCents(plain[1] ?? '', plain[2]);

  const grouped = GROUPED.exec(text);
  if (grouped === null) return null;
  const [, head = '', thousands = '', decimalSeparator = '', fraction = ''] = grouped;
  const separators = new Set(thousands.replace(/\d/g, ''));
  if (separators.size !== 1 || separators.has(decimalSeparator)) return null;
  return toCents(head + thousands.replace(/[.,]/g, ''), fraction);
};

/** Source pattern of an amount token followed by a euro sign (or EUR); callers append their own context. */
export const AMOUNT_WITH_EURO = '([0-9][0-9.,]*)\\s*(?:€|eur\\b)';
