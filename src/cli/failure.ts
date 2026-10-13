import { GrammyError, HttpError } from 'grammy';
import { EnvError } from '../config/env.js';
import { AuthExpiredError, LoginFailedError, UnexpectedResponseError } from '../reservaplay/errors.js';
import { TransportError } from '../reservaplay/http.js';

/**
 * The reason of a failure in words, chosen by the kind of error only. The message of an error is never printed:
 * the layers below do not promise it is free of account data.
 */
export const siteFailureHint = (error: unknown): string => {
  if (error instanceof EnvError) return error.message;
  if (error instanceof LoginFailedError) {
    return 'The site did not accept the login. Check RESERVAPLAY_USERNAME and RESERVAPLAY_PASSWORD in .env (a password containing # or spaces must be in quotes).';
  }
  if (error instanceof AuthExpiredError) return 'The site rejected the session.';
  if (error instanceof TransportError) return 'The site could not be reached (network problem or timeout).';
  if (error instanceof UnexpectedResponseError) return 'The site answered in a way the bot does not understand (its pages may have changed).';
  return `Unexpected error (${error instanceof Error ? error.name : typeof error}).`;
};

export const telegramFailureHint = (error: unknown): string => {
  if (error instanceof EnvError) return error.message;
  if (error instanceof GrammyError) {
    if (error.error_code === 401) return 'Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN in .env.';
    if (error.error_code === 409) return 'Another program is already polling this bot (is the bot running?). Stop it and try again.';
    return `Telegram refused the request (error ${error.error_code}).`;
  }
  if (error instanceof HttpError) return 'Telegram could not be reached (network problem).';
  return `Unexpected error (${error instanceof Error ? error.name : typeof error}).`;
};
