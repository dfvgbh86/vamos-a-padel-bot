import { isWeekend, type GameDate } from './gameDate.js';

export interface Court {
  /** `id_mst_recurso` from the ReservaPlay API. NOT the same as the Pista number. */
  readonly id: number;
  readonly pista: number;
  readonly name: string;
  /** Academy (Escuela Padel Enjoy) takes these courts on weekdays; the club cancels other bookings. */
  readonly academyOnWeekdays: boolean;
}

export const COURTS: readonly Court[] = [
  { id: 1, pista: 1, name: 'Pista 1 semicubierta', academyOnWeekdays: true },
  { id: 2, pista: 2, name: 'Pista 2 semicubierta', academyOnWeekdays: true },
  { id: 3, pista: 3, name: 'Pista 3 semicubierta', academyOnWeekdays: true },
  { id: 4, pista: 4, name: 'Pista 4 semicubierta', academyOnWeekdays: false },
  { id: 7, pista: 5, name: 'Pista 5 semicubierta', academyOnWeekdays: true },
  { id: 8, pista: 6, name: 'Pista 6 semicubierta', academyOnWeekdays: true },
  { id: 9, pista: 7, name: 'Pista 7 semicubierta', academyOnWeekdays: false },
  { id: 10, pista: 8, name: 'Pista 8 exterior', academyOnWeekdays: false },
  { id: 11, pista: 9, name: 'Pista 9 exterior', academyOnWeekdays: false },
  { id: 12, pista: 10, name: 'Pista 10 exterior', academyOnWeekdays: false },
];

export class CourtNotAllowedError extends Error {
  constructor(
    readonly courtId: number,
    readonly gameDate: string,
  ) {
    super(`Court id ${courtId} is not allowed for ${gameDate}`);
    this.name = 'CourtNotAllowedError';
  }
}

/** Saturday, Sunday or a holiday: no academy sessions, every court may be booked. */
export const isAcademyFreeDay = (gameDate: GameDate, holidays: ReadonlySet<GameDate>): boolean =>
  isWeekend(gameDate) || holidays.has(gameDate);

/** Court ids the bot may book on `gameDate` (club time zone). */
export const allowedCourtIds = (gameDate: GameDate, holidays: ReadonlySet<GameDate>): readonly number[] => {
  const academyFree = isAcademyFreeDay(gameDate, holidays);
  return COURTS.filter((court) => academyFree || !court.academyOnWeekdays).map((court) => court.id);
};

/** Hard guard; called inside the booking-body builder from the same `gameDate`/`courtId` that go on the wire. */
export const assertCourtAllowed = (
  courtId: number,
  gameDate: GameDate,
  holidays: ReadonlySet<GameDate>,
): void => {
  if (!allowedCourtIds(gameDate, holidays).includes(courtId)) {
    throw new CourtNotAllowedError(courtId, gameDate);
  }
};
