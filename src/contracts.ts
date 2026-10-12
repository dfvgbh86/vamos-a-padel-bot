/**
 * Cross-module contracts. Every module (reservaplay client, jobs, sniper, telegram) depends ONLY on
 * these types and on the already implemented pure core (config/, sniper/openTime.ts, reservaplay/bookingBody.ts,
 * reservaplay/classify.ts). Changing this file requires coordination: it is the seam between parallel work.
 *
 * Money is always integer euro cents. Time is epoch milliseconds unless a luxon DateTime is stated.
 */
import type { GameDate } from './config/gameDate.js';
import type { PaymentMode } from './reservaplay/bookingBody.js';
import type { AddEventOutcome, FormGate, TransportOutcome } from './reservaplay/classify.js';

// ---------------------------------------------------------------------------------------------
// Slots and the day calendar (parsed from GET /api/tipo_recurso/1/reservas_usuario, whitelist only)
// ---------------------------------------------------------------------------------------------

/** One wish of the owner: this court at this start time. Jobs hold a priority-ordered list of them. */
export interface SlotChoice {
  /** `id_mst_recurso`, NOT the Pista number. */
  readonly courtId: number;
  /** Minutes from midnight, e.g. 1080 = 18:00. */
  readonly startMinutes: number;
}

export interface SlotRef extends SlotChoice {
  readonly gameDate: GameDate;
  readonly durationMinutes: number;
}

export interface DaySlot {
  readonly startMinutes: number;
  readonly endMinutes: number;
  readonly durationMinutes: number;
  /** `reserva === null` in the site JSON. */
  readonly free: boolean;
  /** The logged-in account is a participant of the reservation in this slot (`esta_en_reserva`). */
  readonly ownBooking: boolean;
}

export interface DayCourt {
  readonly courtId: number;
  readonly name: string;
  readonly slots: readonly DaySlot[];
}

export interface DaySchedule {
  readonly gameDate: GameDate;
  readonly courts: readonly DayCourt[];
}

// ---------------------------------------------------------------------------------------------
// ReservaPlay API facade (implemented by src/reservaplay/client.ts, faked in tests of other modules)
// ---------------------------------------------------------------------------------------------

/** Both values come from a rendered booking form of the CURRENT session and are never persisted. */
export interface AccountContext {
  readonly accountId: number;
  readonly hash: string;
}

export interface WalletInfo {
  readonly balanceCents: number;
}

export interface PriceQuote {
  /** Total the account will pay for the booking, if the site reports it. */
  readonly totalCents: number | null;
  /** The "Monedero virtual" payment option is enabled (enough credit). */
  readonly walletPayable: boolean;
}

export type BookResult =
  | { readonly kind: 'booked'; readonly reservationId: number }
  | { readonly kind: 'rejected'; readonly outcome: Exclude<AddEventOutcome, { kind: 'ok' }> }
  /** The request may or may not have created a booking: callers must reconcile before any retry. */
  | { readonly kind: 'ambiguous' }
  /** The request never left the machine (connection refused, DNS). Safe to retry. */
  | { readonly kind: 'not_sent' };

export type CancelResult =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly reason: string };

export interface BookRequest {
  readonly slot: SlotRef;
  readonly account: AccountContext;
  readonly payment: PaymentMode;
  readonly holidays: ReadonlySet<GameDate>;
}

export interface ReservaplayApi {
  /** Logs in with the credentials the implementation was constructed with. Throws on failure. */
  login(): Promise<void>;
  /** Cheap authenticated request that proves the session is alive; throws AuthExpiredError otherwise. */
  keepAlive(): Promise<void>;
  getDay(gameDate: GameDate): Promise<DaySchedule>;
  /** GET of the slot's booking form, classified. This is the "window is open" gate. */
  probeForm(slot: SlotRef): Promise<FormGate>;
  /**
   * Reads accountId + hash from an OPEN form of `sample` (must be a day on which the account has no booking,
   * otherwise the site renders no form). Throws if the form is not open.
   */
  getAccountContext(sample: SlotRef): Promise<AccountContext>;
  getWallet(): Promise<WalletInfo>;
  quote(slot: SlotRef, payment: PaymentMode): Promise<PriceQuote>;
  /** Sends exactly one add_event request (never retries internally). */
  book(request: BookRequest): Promise<BookResult>;
  cancel(reservationId: number): Promise<CancelResult>;
}

// ---------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------

export interface Clock {
  /** Epoch ms corrected by the measured server offset (best estimate of server time). */
  nowMs(): number;
  /** Monotonic milliseconds, for measuring durations and short waits. */
  monotonicMs(): number;
  sleep(ms: number): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

export type JobState =
  | 'scheduled' // armed, waiting for the window
  | 'warming' // preflight phase (login, hash, wallet, clock)
  | 'firing' // gate polling / booking attempts in progress
  | 'booked' // reservation confirmed
  | 'needs_payment' // booked by card, owner must pay (only if card fallback is enabled)
  | 'failed'
  | 'cancelled' // cancelled by the owner before booking
  | 'expired'; // window long gone, nothing was booked

/** States in which a job occupies its game date (one active job per date). */
export const ACTIVE_JOB_STATES: readonly JobState[] = ['scheduled', 'warming', 'firing', 'booked', 'needs_payment'];

export interface NewJob {
  readonly gameDate: GameDate;
  /** Priority order, non-empty, no duplicates. */
  readonly choices: readonly SlotChoice[];
  readonly durationMinutes: number;
  readonly payment: PaymentMode;
}

export interface Job extends NewJob {
  readonly id: number;
  readonly state: JobState;
  /** Epoch ms at which the booking window for `gameDate` opens (see sniper/openTime.ts). */
  readonly opensAtMs: number;
  readonly reservationId: number | null;
  readonly bookedChoice: SlotChoice | null;
  readonly failureReason: string | null;
  /** Number of add_event requests sent for this job. */
  readonly attempts: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface JobPatch {
  readonly reservationId?: number;
  readonly bookedChoice?: SlotChoice;
  readonly failureReason?: string;
  /** Added to `attempts`. */
  readonly attemptsDelta?: number;
}

export class DuplicateActiveJobError extends Error {
  constructor(readonly gameDate: GameDate) {
    super(`There is already an active job for ${gameDate}`);
    this.name = 'DuplicateActiveJobError';
  }
}

export interface JobStore {
  /** Throws DuplicateActiveJobError if an active job for the same game date exists. */
  create(job: NewJob, opensAtMs: number, nowMs: number): Job;
  get(id: number): Job | undefined;
  list(filter?: { readonly states?: readonly JobState[] }): readonly Job[];
  /**
   * Optimistic transition: applies only if the current state is one of `from`; returns the updated job,
   * or undefined when the job was missing or in another state. Must be atomic.
   */
  transition(
    id: number,
    from: JobState | readonly JobState[],
    to: JobState,
    nowMs: number,
    patch?: JobPatch,
  ): Job | undefined;
  /** Emergency stop flag (persisted); the sniper checks it before every booking request. */
  isStopped(): boolean;
  setStopped(stopped: boolean): void;
}

// ---------------------------------------------------------------------------------------------
// Events from the sniper to the outside world (Telegram notifier implements the sink)
// ---------------------------------------------------------------------------------------------

export type PreflightFailure = 'no_funds' | 'auth' | 'daily_limit' | 'window_unknown' | 'other';

export type JobEvent =
  | { readonly kind: 'armed'; readonly job: Job }
  | { readonly kind: 'preflight_ok'; readonly job: Job; readonly walletCents: number; readonly quoteCents: number | null }
  | { readonly kind: 'preflight_failed'; readonly job: Job; readonly reason: PreflightFailure; readonly detail: string }
  | { readonly kind: 'window_open'; readonly job: Job }
  | { readonly kind: 'booked'; readonly job: Job; readonly reservationId: number; readonly choice: SlotChoice }
  | { readonly kind: 'needs_payment'; readonly job: Job; readonly reservationId: number }
  | { readonly kind: 'failed'; readonly job: Job; readonly reason: string }
  | { readonly kind: 'ambiguous'; readonly job: Job; readonly detail: string }
  | { readonly kind: 'expired'; readonly job: Job };

export interface JobEventSink {
  emit(event: JobEvent): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Service layer used by the Telegram bot (implemented in src/jobs/service.ts)
// ---------------------------------------------------------------------------------------------

export type CreateJobRejection =
  | 'invalid_input'
  | 'date_in_past'
  | 'date_too_far'
  | 'court_not_allowed'
  | 'duplicate_active_job'
  | 'own_booking_exists';

export type CreateJobResult =
  | {
      readonly kind: 'created';
      readonly job: Job;
      /** Wallet balance known at creation time, or null if it could not be read. */
      readonly walletCents: number | null;
      /** Price the booking needs: from the site when it could be quoted, otherwise an estimate (see requiredIsEstimate). */
      readonly requiredCents: number | null;
      /** true when the site could not quote yet (e.g. window not open) and a typical price was assumed. */
      readonly requiredIsEstimate: boolean;
      /** false => the bot must tell the owner immediately that money is missing (owner requirement). */
      readonly fundsOk: boolean;
    }
  | { readonly kind: 'rejected'; readonly reason: CreateJobRejection; readonly detail: string };

export type CancelJobResult =
  | { readonly kind: 'cancelled'; readonly job: Job }
  | { readonly kind: 'not_cancellable'; readonly state: JobState }
  | { readonly kind: 'not_found' };

export interface StatusReport {
  readonly stopped: boolean;
  readonly sessionAlive: boolean | null;
  readonly walletCents: number | null;
  readonly activeJobs: readonly Job[];
  /** Holidays (YYYY-MM-DD) in the next 30 days, so a wrong date is noticed. */
  readonly upcomingHolidays: readonly GameDate[];
  readonly nextWindowOpensAtMs: number | null;
}

export interface CreateJobInput {
  readonly gameDate: GameDate;
  readonly choices: readonly SlotChoice[];
  /** Defaults to 90. */
  readonly durationMinutes?: number;
  /** Defaults to 'wallet'. */
  readonly payment?: PaymentMode;
}

export interface JobService {
  /** Court ids the owner may pick for `gameDate` (weekday/weekend/holiday aware). */
  allowedCourts(gameDate: GameDate): readonly number[];
  /** Latest game date that is already open right now, and the next one to open (for the date picker). */
  getDay(gameDate: GameDate): Promise<DaySchedule>;
  createJob(input: CreateJobInput): Promise<CreateJobResult>;
  listJobs(): readonly Job[];
  cancelJob(id: number): Promise<CancelJobResult>;
  status(): Promise<StatusReport>;
  wallet(): Promise<WalletInfo>;
  stopAll(): void;
  resumeAll(): void;
}

export type { AddEventOutcome, FormGate, TransportOutcome };
