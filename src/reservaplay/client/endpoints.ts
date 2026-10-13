import type { DateTime } from 'luxon';
import { parseGameDate, type GameDate } from '../../config/gameDate.js';
import { CLUB_LUXON_OPTIONS } from '../../config/timezone.js';
import type { SlotRef } from '../../contracts.js';
import { DEFAULT_GUEST_COUNT, GUEST_ACCOUNT_ID } from '../bookingBody.js';

const MINUTES_PER_DAY = 24 * 60;

/** Path segments keep `:` and `,` literal, like a browser does for these URLs; everything else unsafe is percent-encoded. */
const segment = (value: string | number): string =>
  encodeURIComponent(String(value)).replace(/%3A/gi, ':').replace(/%2C/gi, ',');

const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const guestIds = Array<number>(DEFAULT_GUEST_COUNT).fill(GUEST_ACCOUNT_ID).join(',');

interface CheckedSlot {
  readonly gameDate: GameDate;
  readonly courtId: number;
  readonly startMinutes: number;
  readonly durationMinutes: number;
}

/** Every number that ends up in a URL is re-validated: `NaN` or `-1` must never be sent to the site. */
const checkedSlot = (slot: SlotRef): CheckedSlot => {
  const gameDate = parseGameDate(slot.gameDate);
  const { courtId, startMinutes, durationMinutes } = slot;
  if (!Number.isSafeInteger(courtId) || courtId < 1) throw new Error(`Invalid court id: ${String(courtId)}`);
  if (!Number.isInteger(startMinutes) || startMinutes < 0 || startMinutes >= MINUTES_PER_DAY) {
    throw new Error(`Invalid start time (minutes from midnight): ${String(startMinutes)}`);
  }
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > MINUTES_PER_DAY) {
    throw new Error(`Invalid duration: ${String(durationMinutes)} min`);
  }
  return { gameDate, courtId, startMinutes, durationMinutes };
};

const checkedAccountId = (accountId: number): number => {
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || accountId === GUEST_ACCOUNT_ID) {
    throw new Error(`Invalid account id: ${String(accountId)}`);
  }
  return accountId;
};

export const clubToday = (now: DateTime): string => {
  if (!now.isValid) throw new Error('The club clock returned an invalid time');
  return now.setZone(CLUB_LUXON_OPTIONS.zone).toFormat('yy-MM-dd', CLUB_LUXON_OPTIONS);
};

export interface Endpoints {
  readonly login: string;
  readonly calWeek: string;
  readonly wallet: string;
  readonly manager: string;
  calendar(gameDate: GameDate): string;
  slotForm(slot: SlotRef, now: DateTime): string;
  paymentOptions(slot: SlotRef, accountId: number): string;
  guestInfo(slot: SlotRef, accountId: number): string;
}

export const createEndpoints = (baseUrl: string): Endpoints => ({
  login: `${baseUrl}/login`,
  calWeek: `${baseUrl}/reserves/cal_week.php`,
  wallet: `${baseUrl}/view/reserves/compra-moneder`,
  manager: `${baseUrl}/sportssuite/manager.php`,

  // The calendar API takes a two-digit year ("26-10-19"); a literal "+" is the space before the time.
  calendar: (gameDate) => {
    const date = parseGameDate(gameDate);
    return `${baseUrl}/api/tipo_recurso/1/reservas_usuario?day=${date.slice(2)}+00:00:00&InicioMostrarReservas=0`;
  },

  slotForm: (slot, now) => {
    const { gameDate, courtId, startMinutes, durationMinutes } = checkedSlot(slot);
    const dayOfMonth = Number(gameDate.slice(8, 10));
    return (
      `${baseUrl}/reserves/cal_event.php?data=${gameDate}%2000:00:00&hora=${startMinutes}` +
      `&hora_fin=${startMinutes + durationMinutes}&resource=${courtId}&date=${clubToday(now)}&diaheader${dayOfMonth}`
    );
  },

  paymentOptions: (slot, accountId) => {
    const { gameDate, courtId, startMinutes, durationMinutes } = checkedSlot(slot);
    const host = checkedAccountId(accountId);
    return (
      `${baseUrl}/view/reserves/load_content/pago_anticipado_select/socio/${host}/recurso/${courtId}` +
      `/fecha/${segment(`${gameDate} 00:00:00`)}/fecha_ini/${segment(`${gameDate} ${clock(startMinutes)}`)}` +
      `/duracion/${durationMinutes}/id_mst_socios_responsable/0/participantes/${segment(`${host},${guestIds}`)}` +
      '/id_reg_reserva/0?no_radio=0'
    );
  },

  guestInfo: (slot, accountId) => {
    const { gameDate, courtId, startMinutes, durationMinutes } = checkedSlot(slot);
    const host = checkedAccountId(accountId);
    return (
      `${baseUrl}/api/reserves/socios/${segment(guestIds)}/prepago_show_info/recurso/${courtId}` +
      `/fecha/${segment(`${gameDate} 00:00:00`)}/fecha_ini/${segment(`${gameDate} ${clock(startMinutes)}`)}` +
      `/duracion/${durationMinutes}/id_mst_socios_responsable/${host}/socios/${segment(`${host},${guestIds}`)}`
    );
  },
});

/** Body of `op=del_event`; `socis` is added only when the account id is known. */
export const cancelBody = (reservationId: number, accountId: number | null): string => {
  if (!Number.isSafeInteger(reservationId) || reservationId <= 0) throw new Error(`Invalid reservation id: ${String(reservationId)}`);
  const fields: [string, string][] = [
    ['id_reserva', String(reservationId)],
    ['op', 'del_event'],
    ['eliminarReservaPermiso', '1'],
    ['pasar_a_monedero', '1'],
  ];
  if (accountId !== null) fields.push(['socis', `${checkedAccountId(accountId)},${guestIds}`]);
  return new URLSearchParams(fields).toString();
};
