/**
 * A ReservaplayApi that behaves like the real site, with synthetic data only (account 12345, fake names):
 * the calendar is visible from midnight, the booking form is closed until the window opens and then renders a
 * hash, a day on which the account already has a booking renders no form, and add_event creates a booking at
 * most once per day (a second one is counted as a violation and refused). The answer to add_event goes through
 * the real classifier, exactly like the real client does.
 */
import { DateTime } from 'luxon';
import { COURTS, isAcademyFreeDay } from '../../src/config/courts.js';
import { buildAddEventBody } from '../../src/reservaplay/bookingBody.js';
import { classifyAddEventResponse, type FormGate } from '../../src/reservaplay/classify.js';
import type { GameDate } from '../../src/config/gameDate.js';
import { buildHolidaySet } from '../../src/config/holidays.js';
import { CLUB_LUXON_OPTIONS } from '../../src/config/timezone.js';
import type {
  AccountContext,
  BookRequest,
  BookResult,
  CancelResult,
  DaySchedule,
  PriceQuote,
  ReservaplayApi,
  SlotChoice,
  SlotRef,
  WalletInfo,
} from '../../src/contracts.js';
import { AuthExpiredError, LoginFailedError, UnexpectedResponseError } from '../../src/reservaplay/errors.js';
import type { PaymentMode } from '../../src/reservaplay/bookingBody.js';
import { bookingOpensAt } from '../../src/sniper/openTime.js';
import { bookingErrorPayload, bookingOkPayload } from '../fixtures/reservaplay/pages.js';
import type { VirtualClock } from './_virtualClock.js';

const HOLIDAYS = buildHolidaySet(undefined);

export const ACCOUNT_ID = 12345;
export const SITE_HASH = 'd'.repeat(40);
export const PRICE_CENTS = 1902;
export const FIRST_RESERVATION_ID = 100_002;

/** Slot starts of the synthetic club: two 90 minute slots per court. */
export const SLOT_STARTS: readonly number[] = [1080, 1170];

export type BookScript =
  /** The booking is made and the answer arrives. */
  | 'ok'
  /** The booking IS made on the site, but the answer never arrives (timeout after the server processed it). */
  | 'lost_answer'
  /** The request times out and the site never processed it. */
  | 'lost_request'
  /** Somebody else took the slot an instant before: the site answers with a message nobody has seen before. */
  | 'taken_by_other';

export interface OwnBooking {
  readonly gameDate: GameDate;
  readonly courtId: number;
  readonly startMinutes: number;
  readonly durationMinutes: number;
  readonly reservationId: number;
}

export interface SiteCall {
  readonly name: string;
  readonly atMs: number;
  readonly gameDate?: GameDate;
}

export interface AddEvent {
  readonly atMs: number;
  readonly serverMs: number;
  readonly body: string;
  readonly script: BookScript;
  readonly courtId: number;
  readonly startMinutes: number;
}

/** The answer of the site goes through the real classifier, exactly like the real client does. */
const toResult = (payload: unknown): BookResult => {
  const outcome = classifyAddEventResponse({ status: 200, body: JSON.stringify(payload) });
  return outcome.kind === 'ok' ? { kind: 'booked', reservationId: outcome.reservationId } : { kind: 'rejected', outcome };
};

export class FakeSite implements ReservaplayApi {
  readonly calls: SiteCall[] = [];
  readonly addEvents: AddEvent[] = [];
  readonly cancelRequests: number[] = [];
  readonly bookings: OwnBooking[] = [];
  /** Slots somebody else holds; not free in the calendar. */
  readonly takenByOthers: SlotChoice[] = [];
  walletCents = 5000;
  loggedIn = false;
  loginCount = 0;
  loginFails = false;
  /** add_event requests that were NOT the first for a day that already had a booking: must stay 0. */
  doubleBookings = 0;
  /** add_event requests that arrived before the window of their date had opened: must stay 0. */
  bookedBeforeOpen = 0;
  maxBooksInFlight = 0;
  latencyMs: Partial<Record<'probeForm' | 'book' | 'getDay', number>> = {};
  /** Decides what each add_event does (nth is 0-based). */
  bookScript: (nth: number, request: BookRequest) => BookScript = () => 'ok';
  /** Called with the gate the site is about to return for a probe (to raise the stop flag at the worst moment). */
  onProbe: ((gate: FormGate, slot: SlotRef) => void) | undefined;
  /** Makes the calendar unreadable for the next n reads of the booked date (a flaky network during reconciliation). */
  failCalendarReads = 0;
  private accountKnown = false;
  private booksInFlight = 0;
  private nextReservationId = FIRST_RESERVATION_ID;

  constructor(readonly clock: VirtualClock) {}

  count(name: string): number {
    return this.calls.filter((call) => call.name === name).length;
  }

  private record(name: string, gameDate?: GameDate): void {
    this.calls.push({ name, atMs: this.clock.nowMs(), ...(gameDate === undefined ? {} : { gameDate }) });
  }

  private requireSession(): void {
    if (!this.loggedIn) throw new AuthExpiredError();
  }

  private async lag(name: keyof FakeSite['latencyMs']): Promise<void> {
    const ms = this.latencyMs[name] ?? 0;
    await (ms > 0 ? this.clock.sleep(ms) : Promise.resolve());
  }

  ownBookingOn(gameDate: GameDate): OwnBooking | undefined {
    return this.bookings.find((booking) => booking.gameDate === gameDate);
  }

  private opensAtMs(gameDate: GameDate): number {
    return bookingOpensAt(gameDate).toMillis();
  }

  login = async (): Promise<void> => {
    this.record('login');
    this.loginCount++;
    if (this.loginFails) throw new LoginFailedError('Login was not accepted (HTTP 200)');
    this.loggedIn = true;
  };

  keepAlive = async (): Promise<void> => {
    this.record('keepAlive');
    this.requireSession();
  };

  expireSession(): void {
    this.loggedIn = false;
  }

  getDay = async (gameDate: GameDate): Promise<DaySchedule> => {
    this.record('getDay', gameDate);
    this.requireSession();
    await this.lag('getDay');
    if (this.failCalendarReads > 0 && this.ownBookingOn(gameDate) !== undefined) {
      this.failCalendarReads--;
      throw new UnexpectedResponseError('Calendar answered HTTP 500', 500);
    }
    const academy = new Set(COURTS.filter((court) => court.academyOnWeekdays).map((court) => court.id));
    const academyDay = !isAcademyFreeDay(gameDate, HOLIDAYS);
    return {
      gameDate,
      courts: COURTS.map((court) => ({
        courtId: court.id,
        name: court.name,
        slots: SLOT_STARTS.map((startMinutes) => {
          const own = this.ownBookingOn(gameDate)?.courtId === court.id && this.ownBookingOn(gameDate)?.startMinutes === startMinutes;
          const heldByOthers =
            (academyDay && academy.has(court.id)) ||
            this.takenByOthers.some((slot) => slot.courtId === court.id && slot.startMinutes === startMinutes);
          return { startMinutes, endMinutes: startMinutes + 90, durationMinutes: 90, free: !own && !heldByOthers, ownBooking: own };
        }),
      })),
    };
  };

  private gateFor(slot: SlotRef): FormGate {
    if (this.ownBookingOn(slot.gameDate) !== undefined) return { kind: 'daily_limit' };
    const serverMs = this.clock.serverNowMs();
    if (serverMs < this.opensAtMs(slot.gameDate)) {
      const reading = Math.floor(serverMs / 1000) * 1000;
      return { kind: 'window_closed', serverCheckTime: DateTime.fromMillis(reading, CLUB_LUXON_OPTIONS) };
    }
    const taken = this.takenByOthers.some((other) => other.courtId === slot.courtId && other.startMinutes === slot.startMinutes);
    return taken ? { kind: 'unknown' } : { kind: 'open', hash: SITE_HASH };
  }

  probeForm = async (slot: SlotRef): Promise<FormGate> => {
    this.record('probeForm', slot.gameDate);
    this.requireSession();
    await this.lag('probeForm');
    const gate = this.gateFor(slot);
    this.onProbe?.(gate, slot);
    return gate;
  };

  getAccountContext = async (sample: SlotRef): Promise<AccountContext> => {
    this.record('getAccountContext', sample.gameDate);
    this.requireSession();
    const gate = this.gateFor(sample);
    if (gate.kind !== 'open') throw new UnexpectedResponseError(`The booking form is not open (${gate.kind})`);
    this.accountKnown = true;
    return { accountId: ACCOUNT_ID, hash: gate.hash };
  };

  getWallet = async (): Promise<WalletInfo> => {
    this.record('getWallet');
    this.requireSession();
    return { balanceCents: this.walletCents };
  };

  quote = async (slot: SlotRef, _payment: PaymentMode): Promise<PriceQuote> => {
    this.record('quote', slot.gameDate);
    this.requireSession();
    if (!this.accountKnown) throw new Error('The account id is not known yet');
    return { totalCents: PRICE_CENTS, walletPayable: this.walletCents >= PRICE_CENTS };
  };

  /** The site side of an add_event that went through. */
  private createBooking(request: BookRequest): number {
    const reservationId = this.nextReservationId++;
    const { slot } = request;
    this.bookings.push({
      gameDate: slot.gameDate,
      courtId: slot.courtId,
      startMinutes: slot.startMinutes,
      durationMinutes: slot.durationMinutes,
      reservationId,
    });
    this.walletCents -= PRICE_CENTS;
    return reservationId;
  }

  private answer(request: BookRequest): BookResult {
    const { slot } = request;
    let payload: unknown;
    if (this.ownBookingOn(slot.gameDate) !== undefined) {
      this.doubleBookings++;
      payload = bookingErrorPayload('Ya tienes 1 reserva/s para este dia');
    } else if (this.clock.serverNowMs() < this.opensAtMs(slot.gameDate)) {
      this.bookedBeforeOpen++;
      payload = bookingErrorPayload('No puedes reservar hasta las 07:00');
    } else {
      payload = bookingOkPayload(this.createBooking(request));
    }
    return toResult(payload);
  }

  book = async (request: BookRequest): Promise<BookResult> => {
    this.record('book', request.slot.gameDate);
    this.requireSession();
    this.booksInFlight++;
    this.maxBooksInFlight = Math.max(this.maxBooksInFlight, this.booksInFlight);
    try {
      const nth = this.addEvents.length;
      const script = this.bookScript(nth, request);
      // The real client builds the body with the same function: the academy guard and the field order are exercised here too.
      const body = buildAddEventBody({
        hash: request.account.hash,
        accountId: request.account.accountId,
        gameDate: request.slot.gameDate,
        courtId: request.slot.courtId,
        startMinutes: request.slot.startMinutes,
        durationMinutes: request.slot.durationMinutes,
        payment: request.payment,
        holidays: request.holidays,
      });
      this.addEvents.push({
        atMs: this.clock.nowMs(),
        serverMs: this.clock.serverNowMs(),
        body,
        script,
        courtId: request.slot.courtId,
        startMinutes: request.slot.startMinutes,
      });
      await this.lag('book');
      if (request.account.hash !== SITE_HASH || request.account.accountId !== ACCOUNT_ID) {
        return toResult(bookingErrorPayload('Token no valido'));
      }
      switch (script) {
        case 'lost_request':
          return { kind: 'ambiguous' };
        case 'lost_answer':
          this.answer(request);
          return { kind: 'ambiguous' };
        case 'taken_by_other':
          this.takenByOthers.push({ courtId: request.slot.courtId, startMinutes: request.slot.startMinutes });
          return toResult(bookingErrorPayload('La pista ya esta ocupada'));
        case 'ok':
          return this.answer(request);
      }
    } finally {
      this.booksInFlight--;
    }
  };

  cancel = async (reservationId: number): Promise<CancelResult> => {
    this.record('cancel');
    this.cancelRequests.push(reservationId);
    return { kind: 'failed', reason: 'the bot never cancels on its own' };
  };
}
