import type { DaySchedule, SlotChoice } from '../contracts.js';

export interface OwnBookingMatch {
  /** The wished slot the booking covers, or null when the account has a booking on that day elsewhere. */
  readonly choice: SlotChoice | null;
}

export const hasOwnBooking = (day: DaySchedule): boolean =>
  day.courts.some((court) => court.slots.some((slot) => slot.ownBooking));

/** The calendar slot of the choice's court that covers its start time is booked by somebody else (not free, not ours). */
export const slotTakenByOthers = (day: DaySchedule, choice: SlotChoice): boolean => {
  const court = day.courts.find((candidate) => candidate.courtId === choice.courtId);
  const slot = court?.slots.find(
    (candidate) => candidate.startMinutes <= choice.startMinutes && choice.startMinutes < candidate.endMinutes,
  );
  return slot !== undefined && !slot.free && !slot.ownBooking;
};

/** Looks for a booking of the logged-in account on `day`, preferring one that covers a wished choice. */
export const findOwnBooking = (day: DaySchedule, choices: readonly SlotChoice[]): OwnBookingMatch | null => {
  let anyOwnBooking = false;
  for (const court of day.courts) {
    for (const slot of court.slots) {
      if (!slot.ownBooking) continue;
      anyOwnBooking = true;
      const covered = choices.find(
        (choice) =>
          choice.courtId === court.courtId && slot.startMinutes <= choice.startMinutes && choice.startMinutes < slot.endMinutes,
      );
      if (covered !== undefined) return { choice: covered };
    }
  }
  return anyOwnBooking ? { choice: null } : null;
};
