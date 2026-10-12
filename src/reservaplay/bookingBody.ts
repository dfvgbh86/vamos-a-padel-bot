import { assertCourtAllowed } from '../config/courts.js';
import type { GameDate } from '../config/gameDate.js';

/** Shared "Invitado" account used for every guest participant. */
export const GUEST_ACCOUNT_ID = 3;
export const MIN_DURATION_MINUTES = 60;
export const MAX_DURATION_MINUTES = 180;
export const DEFAULT_GUEST_COUNT = 3;

export type PaymentMode = 'wallet' | 'card';

export interface AddEventRequest {
  /** 40-hex account token taken from a rendered booking form of the current session. */
  readonly hash: string;
  readonly accountId: number;
  readonly gameDate: GameDate;
  /** `id_mst_recurso`. */
  readonly courtId: number;
  /** Minutes from midnight, e.g. 1080 = 18:00. */
  readonly startMinutes: number;
  readonly durationMinutes: number;
  readonly guestCount?: number;
  readonly payment: PaymentMode;
  readonly holidays: ReadonlySet<GameDate>;
}

const HASH_PATTERN = /^[0-9a-f]{40}$/;

const formatClock = (minutes: number): string => {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
};

/**
 * The only place that builds the `op=add_event` request body (field order mirrors the site's own form POST,
 * captured from a real booking on 2026-10-12). The academy-court guard runs here, on the very values
 * that are serialised, so a booking for a forbidden court cannot be produced by any caller.
 */
export const buildAddEventBody = (request: AddEventRequest): string => {
  const guestCount = request.guestCount ?? DEFAULT_GUEST_COUNT;

  assertCourtAllowed(request.courtId, request.gameDate, request.holidays);

  if (!HASH_PATTERN.test(request.hash)) throw new Error('Booking hash must be 40 lowercase hex characters');
  if (!Number.isInteger(request.accountId) || request.accountId <= 0 || request.accountId === GUEST_ACCOUNT_ID) {
    throw new Error(`Invalid account id: ${request.accountId}`);
  }
  if (!Number.isInteger(request.startMinutes) || request.startMinutes < 0 || request.startMinutes >= 24 * 60) {
    throw new Error(`Invalid start time (minutes from midnight): ${request.startMinutes}`);
  }
  if (
    !Number.isInteger(request.durationMinutes) ||
    request.durationMinutes < MIN_DURATION_MINUTES ||
    request.durationMinutes > MAX_DURATION_MINUTES
  ) {
    throw new Error(`Invalid duration: ${request.durationMinutes} min`);
  }
  if (!Number.isInteger(guestCount) || guestCount < 0 || guestCount > DEFAULT_GUEST_COUNT) {
    throw new Error(`Invalid guest count: ${guestCount}`);
  }

  const participants = [request.accountId, ...Array<number>(guestCount).fill(GUEST_ACCOUNT_ID)].join(',');
  const wallet = request.payment === 'wallet';

  return new URLSearchParams([
    ['hash', request.hash],
    ['id_reserva', ''],
    ['libres', '0'],
    ['libres_step', '1'],
    ['nivel', '0'],
    ['nivel_max', '7'],
    ['sx', '-'],
    ['lista_usuarios', '0'],
    ['data', `${request.gameDate} 00:00:00`],
    ['recurso', String(request.courtId)],
    ['op', 'add_event'],
    ['desactivar_pago', '0'],
    ['tipo_pago_anticipado_socio', wallet ? '5' : '2'],
    ['array_of_bonos', ''],
    ['esReservaFija', '0'],
    ['array_of_bonos', ''],
    ['esReservaFija', '0'],
    ['tipoabonos', '0'],
    ['tipo_pago_anticipado_tpvonline', wallet ? '0' : '1'],
    ['duration', String(request.durationMinutes)],
    ['time_ini', formatClock(request.startMinutes)],
    ['socis', participants],
  ]).toString();
};
