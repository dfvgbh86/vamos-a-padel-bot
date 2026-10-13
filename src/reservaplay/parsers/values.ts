export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** PHP-style flags: `true`, `1`, `"1"`, `"true"`, any non-empty string other than "0"/"false". */
export const isTruthyFlag = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value !== 'string') return false;
  const text = value.trim().toLowerCase();
  return text !== '' && text !== '0' && text !== 'false';
};

/** Integer written as a JSON number or as a digit string; anything else is undefined. */
export const toInteger = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value.trim())) return undefined;
  return Number(value.trim());
};
