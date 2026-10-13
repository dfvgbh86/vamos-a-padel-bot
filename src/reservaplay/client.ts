import type { DateTime } from 'luxon';
import { parseGameDate, type GameDate } from '../config/gameDate.js';
import { buildHolidaySet } from '../config/holidays.js';
import type {
  AccountContext,
  BookRequest,
  BookResult,
  CancelResult,
  DaySchedule,
  PriceQuote,
  ReservaplayApi,
  SlotRef,
  WalletInfo,
} from '../contracts.js';
import { buildAddEventBody, DEFAULT_GUEST_COUNT } from './bookingBody.js';
import { classifyAddEventResponse, classifyFormPage, classifyTransportFailure, type FormGate } from './classify.js';
import { cancelBody, createEndpoints } from './client/endpoints.js';
import { ACCEPT_HTML, ACCEPT_JSON, ACCEPT_LANGUAGE, errorPageTitle, FORM_ENCODED, MANAGER_POST_HEADERS, pageHeaders, XHR } from './client/headers.js';
import { decodeJson, expectStatus200, interpretCancel, isAnswerToTrust, rejectLoginPage, transportFailedCancel } from './client/responses.js';
import { AuthExpiredError, LoginFailedError, UnexpectedResponseError } from './errors.js';
import {
  checkedTimeoutMs,
  createHttpSession,
  normalizeBaseUrl,
  TransportError,
  type HttpLogger,
  type HttpResponse,
} from './http.js';
import {
  parseCalendar,
  parseCsrfToken,
  parseGuestPrices,
  parseHostAccountId,
  parsePaymentOptions,
  parseWalletCents,
} from './parsers/index.js';

export interface ReservaplayClientConfig {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly logger: HttpLogger;
  /** The club's "now" (time zone Europe/Madrid); only its calendar day is used, for the `date` parameter of the booking form. */
  readonly now: () => DateTime;
  readonly fetchImpl?: typeof fetch;
  /** Default: the official Valencia holidays. Used when a BookRequest carries none. */
  readonly holidays?: ReadonlySet<GameDate>;
  /** Timeout of ordinary requests, default 15 s; an integer from 1 to 2^31-1 ms or the constructor throws. */
  readonly timeoutMs?: number;
  /**
   * Timeout of the booking POST: default 25 s, a smaller positive value is raised to 20 s (the site needs ~2 s and a retry
   * is not allowed). Anything that is not an integer from 1 to 2^31-1 ms makes the constructor throw.
   */
  readonly bookTimeoutMs?: number;
}

/** quote()/cancel() need the account id, which only a rendered booking form reveals (see getAccountContext). */
export class AccountUnknownError extends Error {
  constructor() {
    super('The account id is not known yet: call getAccountContext() first');
    this.name = 'AccountUnknownError';
  }
}

export const MIN_BOOK_TIMEOUT_MS = 20_000;
export const DEFAULT_BOOK_TIMEOUT_MS = 25_000;

const requireCredential = (name: string, value: unknown): void => {
  if (typeof value !== 'string' || value === '') throw new Error(`ReservaPlay ${name} is not configured`);
};

const resolveBookTimeoutMs = (configured: number | undefined): number =>
  configured === undefined ? DEFAULT_BOOK_TIMEOUT_MS : Math.max(checkedTimeoutMs('bookTimeoutMs', configured), MIN_BOOK_TIMEOUT_MS);

export const createReservaplayClient = (config: ReservaplayClientConfig): ReservaplayApi => {
  requireCredential('username', config.username);
  requireCredential('password', config.password);

  const { logger } = config;
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const endpoints = createEndpoints(baseUrl);
  const holidays = config.holidays ?? buildHolidaySet(undefined);
  const bookTimeoutMs = resolveBookTimeoutMs(config.bookTimeoutMs);
  const http = createHttpSession({
    baseUrl,
    logger,
    ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
    ...(config.timeoutMs === undefined ? {} : { defaultTimeoutMs: checkedTimeoutMs('timeoutMs', config.timeoutMs) }),
  });

  let knownAccountId: number | null = null;
  let bookingInFlight = false;

  const get = (label: string, url: string, headers: Readonly<Record<string, string>>): Promise<HttpResponse> =>
    http.request({ method: 'GET', url, label, headers });

  const requireAccountId = (): number => {
    if (knownAccountId === null) throw new AccountUnknownError();
    return knownAccountId;
  };

  const keepAlive = async (): Promise<void> => {
    const response = await get('keep_alive', endpoints.calWeek, ACCEPT_HTML);
    expectStatus200(response, 'Keep-alive');
    rejectLoginPage(response.text);
  };

  const performLogin = async (): Promise<void> => {
    await http.clearCookies();
    const page = await http.request({ method: 'GET', url: endpoints.login, label: 'login_page', headers: ACCEPT_HTML, onAuthRejected: 'return' });
    expectStatus200(page, 'Login page');
    const token = parseCsrfToken(page.text);
    if (token === null) throw new UnexpectedResponseError('No CSRF token found on the login page');

    const submitted = await http.request({
      method: 'POST',
      url: endpoints.login,
      label: 'login_submit',
      headers: { ...XHR, Accept: 'application/json, text/plain, */*', 'Content-Type': FORM_ENCODED },
      body: new URLSearchParams([
        ['_token', token],
        ['username', config.username],
        ['password', config.password],
      ]).toString(),
      onAuthRejected: 'return',
    });
    if (submitted.status === 429 || submitted.status >= 500) {
      logger.warn({ status: submitted.status }, 'login request refused');
      throw new LoginFailedError(`Login request refused (HTTP ${submitted.status})`);
    }

    // The format of the login answer is not known: only an authenticated request proves the session.
    try {
      await keepAlive();
    } catch (error) {
      if (!(error instanceof AuthExpiredError) && !(error instanceof UnexpectedResponseError)) throw error;
      logger.warn({ status: submitted.status }, 'login was not accepted');
      throw new LoginFailedError(`Login was not accepted (HTTP ${submitted.status})`);
    }
    logger.info({}, 'logged in');
  };

  /**
   * Single flight: a login wipes and refills the shared cookie jar, so a second one started meanwhile would pair its POST
   * with the other login's session cookie. Callers share the running attempt. Callers must still not overlap a login with
   * other requests: they would send, or store, cookies of a session that is being replaced.
   */
  let loginInFlight: Promise<void> | null = null;
  const login = (): Promise<void> => {
    if (loginInFlight !== null) return loginInFlight;
    const attempt = performLogin().finally(() => {
      loginInFlight = null;
    });
    loginInFlight = attempt;
    return attempt;
  };

  const getDay = async (gameDate: GameDate): Promise<DaySchedule> => {
    const date = parseGameDate(gameDate);
    const response = await get('calendar', endpoints.calendar(date), { ...XHR, ...ACCEPT_JSON });
    expectStatus200(response, 'Calendar');
    const payload = decodeJson(response.text);
    if (payload === undefined) {
      rejectLoginPage(response.text);
      throw new UnexpectedResponseError('Calendar response is not JSON', response.status);
    }
    return parseCalendar(payload, date);
  };

  const fetchForm = async (slot: SlotRef, label: string): Promise<{ readonly gate: FormGate; readonly html: string }> => {
    const response = await get(label, endpoints.slotForm(slot, config.now()), {
      ...ACCEPT_HTML,
      ...ACCEPT_LANGUAGE,
      ...pageHeaders(baseUrl, slot.gameDate),
    });
    const failed = (): UnexpectedResponseError => new UnexpectedResponseError(`Booking form answered HTTP ${response.status}`, response.status);
    if (response.status >= 300 && (response.status < 400 || response.status >= 500)) throw failed();
    const gate = classifyFormPage(response.text);
    if (!isAnswerToTrust(gate, response.status)) throw failed();
    return { gate, html: response.text };
  };

  const probeForm = async (slot: SlotRef): Promise<FormGate> => (await fetchForm(slot, 'probe_form')).gate;

  const getAccountContext = async (sample: SlotRef): Promise<AccountContext> => {
    const { gate, html } = await fetchForm(sample, 'account_context');
    if (gate.kind === 'login_required') throw new AuthExpiredError();
    if (gate.kind !== 'open') throw new UnexpectedResponseError(`The booking form is not open (${gate.kind})`);
    const accountId = parseHostAccountId(html);
    if (accountId === null) throw new UnexpectedResponseError('The host account id was not found in the booking form');
    knownAccountId = accountId;
    return { accountId, hash: gate.hash };
  };

  const getWallet = async (): Promise<WalletInfo> => {
    const response = await get('wallet', endpoints.wallet, ACCEPT_HTML);
    expectStatus200(response, 'Wallet page');
    rejectLoginPage(response.text);
    const balanceCents = parseWalletCents(response.text);
    if (balanceCents === null) throw new UnexpectedResponseError('The wallet balance was not found on the wallet page');
    return { balanceCents };
  };

  /** Best effort: any failure except an expired session only means "total unknown". */
  const guestTotalCents = async (slot: SlotRef, accountId: number, hostCents: number): Promise<number | null> => {
    try {
      const response = await get('guest_prices', endpoints.guestInfo(slot, accountId), { ...XHR, ...ACCEPT_JSON });
      if (response.status !== 200) return null;
      const prices = parseGuestPrices(response.text);
      return prices === null || prices.length !== DEFAULT_GUEST_COUNT ? null : prices.reduce((sum, cents) => sum + cents, hostCents);
    } catch (error) {
      if (error instanceof AuthExpiredError) throw error;
      logger.debug({}, 'guest prices unavailable');
      return null;
    }
  };

  const quote = async (slot: SlotRef): Promise<PriceQuote> => {
    const accountId = requireAccountId();
    const response = await get('payment_options', endpoints.paymentOptions(slot, accountId), { ...XHR, ...ACCEPT_JSON });
    expectStatus200(response, 'Payment options');
    const payload = decodeJson(response.text);
    if (payload === undefined) {
      rejectLoginPage(response.text);
      throw new UnexpectedResponseError('Payment options response is not JSON', response.status);
    }
    const options = parsePaymentOptions(payload);
    if (options === null) throw new UnexpectedResponseError('The payment options were not found in the response');
    const totalCents =
      options.hostPriceCents === null ? null : await guestTotalCents(slot, accountId, options.hostPriceCents);
    return { totalCents, walletPayable: options.walletPayable };
  };

  const sendBooking = async (body: string, gameDate: GameDate): Promise<BookResult> => {
    try {
      const response = await http.request({
        method: 'POST',
        url: endpoints.manager,
        label: 'add_event',
        headers: { ...MANAGER_POST_HEADERS, ...pageHeaders(baseUrl, gameDate) },
        body,
        timeoutMs: bookTimeoutMs,
        onAuthRejected: 'return',
      });
      // A gateway answered for a request the backend may have processed: same uncertainty as a timeout.
      if (response.status === 502 || response.status === 504) return classifyTransportFailure(true);
      if (response.status >= 500) logger.warn({ status: response.status, title: errorPageTitle(response.text) }, 'booking request got a server error');
      const outcome = classifyAddEventResponse({ status: response.status, location: response.location, body: response.text });
      return outcome.kind === 'ok' ? { kind: 'booked', reservationId: outcome.reservationId } : { kind: 'rejected', outcome };
    } catch (error) {
      if (error instanceof TransportError) return classifyTransportFailure(error.mayHaveReachedServer);
      throw error;
    }
  };

  /** Exactly one add_event in flight: a second call is refused, never queued and never retried. */
  const book = async (request: BookRequest): Promise<BookResult> => {
    if (bookingInFlight) {
      logger.error({}, 'refused a second booking request while one is in flight');
      throw new Error('A booking request is already in flight');
    }
    bookingInFlight = true;
    try {
      const { slot, account } = request;
      const body = buildAddEventBody({
        hash: account.hash,
        accountId: account.accountId,
        gameDate: slot.gameDate,
        courtId: slot.courtId,
        startMinutes: slot.startMinutes,
        durationMinutes: slot.durationMinutes,
        payment: request.payment,
        holidays: request.holidays ?? holidays,
      });
      const result = await sendBooking(body, slot.gameDate);
      logger.info({ outcome: result.kind === 'rejected' ? result.outcome.kind : result.kind }, 'booking request finished');
      return result;
    } finally {
      bookingInFlight = false;
    }
  };

  /** Fails closed: the only captured cancel carried `socis` and its full refund is unverified without it. */
  const cancel = async (reservationId: number): Promise<CancelResult> => {
    const body = cancelBody(reservationId, knownAccountId);
    if (knownAccountId === null) {
      logger.warn({}, 'refused to cancel before the account id was known');
      return { kind: 'failed', reason: 'account id not known yet' };
    }
    try {
      const response = await http.request({
        method: 'POST',
        url: endpoints.manager,
        label: 'del_event',
        headers: MANAGER_POST_HEADERS,
        body,
        onAuthRejected: 'return',
      });
      const result = interpretCancel(response);
      logger.info({ outcome: result.kind }, 'cancel request finished');
      return result;
    } catch (error) {
      if (!(error instanceof TransportError)) throw error;
      return transportFailedCancel(error.mayHaveReachedServer);
    }
  };

  return { login, keepAlive, getDay, probeForm, getAccountContext, getWallet, quote, book, cancel };
};
