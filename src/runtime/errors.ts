const MAX_MESSAGE_LENGTH = 300;
const MASK = '[hidden]';
/** Account `hash` values and similar long hex secrets. */
const LONG_HEX = /(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/gi;
/** Telegram bot tokens, also when glued to a URL path. */
const BOT_TOKEN = /(?:bot)?\d{5,}:[A-Za-z0-9_-]{20,}/gi;
const SESSION_COOKIE = /(laravel_session|XSRF-TOKEN|AWSALB\w*)\s*=\s*[^\s;,]+/gi;

/** Masks the configured secret values and anything shaped like a token, hash or session cookie. */
export const redactText = (text: string, secrets: readonly string[] = []): string => {
  let result = text;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join(MASK);
  }
  return result.replace(BOT_TOKEN, MASK).replace(LONG_HEX, MASK).replace(SESSION_COOKIE, `$1=${MASK}`);
};

/** Fields for a log line: the error class and a short, scrubbed message. Never a stack, never a response body. */
export const describeError = (
  error: unknown,
  secrets: readonly string[] = [],
): { readonly errorName: string; readonly errorMessage: string } => {
  if (!(error instanceof Error)) return { errorName: typeof error, errorMessage: '' };
  return { errorName: error.name, errorMessage: redactText(error.message, secrets).slice(0, MAX_MESSAGE_LENGTH) };
};

/** One line for the person at the keyboard when startup fails. Only the message: no stack, no configured value. */
export const fatalMessage = (error: unknown, secrets: readonly string[] = []): string => {
  const { errorName, errorMessage } = describeError(error, secrets);
  return errorMessage.length > 0 ? errorMessage : errorName;
};
