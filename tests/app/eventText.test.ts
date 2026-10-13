/**
 * Found while integrating: a booking that the sniper finds in the calendar (after an unclear answer or a restart) is
 * reported with reservation id 0. The owner must not be shown "Номер брони: 0".
 */
import { describe, expect, it } from 'vitest';
import { formatJobEvent } from '../../src/telegram/eventText.js';
import { makeJob } from '../telegram/_fakes.js';

const job = makeJob();
const choice = { courtId: 9, startMinutes: 1080 };

describe('the reservation number in booking messages', () => {
  it('shows a readable id', () => {
    expect(formatJobEvent({ kind: 'booked', job, reservationId: 100_002, choice })).toContain('Номер брони: 100002');
    expect(formatJobEvent({ kind: 'needs_payment', job, reservationId: 100_002 })).toContain('Номер брони: 100002');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('says that the id could not be read instead of printing %s', (reservationId) => {
    for (const text of [formatJobEvent({ kind: 'booked', job, reservationId, choice }), formatJobEvent({ kind: 'needs_payment', job, reservationId })]) {
      expect(text).toContain('Номер брони: не удалось прочитать');
      expect(text).toContain('проверьте бронь на сайте клуба');
      expect(text).not.toMatch(/Номер брони: (0|-1|1\.5|NaN|Infinity)/);
    }
  });

  it('still announces the booking itself', () => {
    const text = formatJobEvent({ kind: 'booked', job, reservationId: 0, choice });
    expect(text).toContain('ЗАБРОНИРОВАНО');
    expect(text).toContain('Pista 7 semicubierta');
    expect(text).toContain('18:00–19:30');
  });
});
