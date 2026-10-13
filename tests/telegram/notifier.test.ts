import { describe, expect, it } from 'vitest';
import type { JobEvent, PreflightFailure } from '../../src/contracts.js';
import { formatJobEvent } from '../../src/telegram/notifier.js';
import { FAKE_HASH } from '../qa/_helpers.js';
import { OPENS_21_MS, date, makeJob } from './_fakes.js';

const job = makeJob({
  id: 12,
  gameDate: date('2026-10-21'),
  opensAtMs: OPENS_21_MS,
  choices: [
    { courtId: 9, startMinutes: 1080 },
    { courtId: 10, startMinutes: 1170 },
  ],
});

const balanced = (html: string): boolean => (html.match(/<b>/g)?.length ?? 0) === (html.match(/<\/b>/g)?.length ?? 0);

describe('formatJobEvent: every event kind, in Russian', () => {
  it('armed: when the window opens (club time) and the choices in priority order', () => {
    const text = formatJobEvent({ kind: 'armed', job });
    expect(text).toContain('заряжено на 14.10 07:00 Madrid');
    expect(text).toContain('#12');
    expect(text).toContain('ср 21.10.2026');
    expect(text).toContain('90 мин');
    expect(text).toContain('1. Pista 7 semicubierta, 18:00');
    expect(text).toContain('2. Pista 8 exterior, 19:30');
  });

  it('preflight_ok: balance and price', () => {
    const text = formatJobEvent({ kind: 'preflight_ok', job, walletCents: 4000, quoteCents: 1902 });
    expect(text).toContain('Предстартовая проверка пройдена');
    expect(text).toContain('Монедеро: 40,00 €');
    expect(text).toContain('стоимость брони: 19,02 €');
  });

  it('preflight_ok: the price may still be unknown', () => {
    const text = formatJobEvent({ kind: 'preflight_ok', job, walletCents: 4000, quoteCents: null });
    expect(text).toContain('стоимость брони: пока неизвестна');
  });

  it('preflight_failed no_funds: an explicit request to top up, before the window opens', () => {
    const text = formatJobEvent({ kind: 'preflight_failed', job, reason: 'no_funds', detail: 'нужно 19,02 €, на счёте 5,00 €' });
    expect(text).toContain('Не хватает денег');
    expect(text).toContain('пополните монедеро');
    expect(text).toContain('14.10 07:00 Madrid');
    expect(text).toContain('Детали: нужно 19,02 €, на счёте 5,00 €');
  });

  it.each<[PreflightFailure, string]>([
    ['auth', 'Не удалось войти на сайт клуба'],
    ['daily_limit', 'На эту дату уже есть бронь'],
    ['window_unknown', 'Не удалось определить, когда откроется окно'],
    ['other', 'Предстартовая проверка не пройдена'],
  ])('preflight_failed %s', (reason, phrase) => {
    const text = formatJobEvent({ kind: 'preflight_failed', job, reason, detail: '' });
    expect(text).toContain(phrase);
    expect(text).toContain('#12');
    expect(text).not.toContain('Детали');
  });

  it('window_open', () => {
    expect(formatJobEvent({ kind: 'window_open', job })).toContain('Окно бронирования открылось');
  });

  it('booked: court name from the table (not the resource id), date, time and the reservation id', () => {
    const text = formatJobEvent({ kind: 'booked', job, reservationId: 100002, choice: { courtId: 9, startMinutes: 1080 } });
    expect(text).toContain('ЗАБРОНИРОВАНО');
    expect(text).toContain('Pista 7 semicubierta');
    expect(text).toContain('ср 21.10.2026');
    expect(text).toContain('18:00–19:30');
    expect(text).toContain('Номер брони: 100002');
    expect(text).toContain('#12');
  });

  it.each([
    [4, 'Pista 4 semicubierta'],
    [7, 'Pista 5 semicubierta'],
    [8, 'Pista 6 semicubierta'],
    [9, 'Pista 7 semicubierta'],
    [10, 'Pista 8 exterior'],
    [12, 'Pista 10 exterior'],
  ])('booked: resource id %i is shown as "%s"', (courtId, name) => {
    const text = formatJobEvent({ kind: 'booked', job, reservationId: 1, choice: { courtId, startMinutes: 600 } });
    expect(text).toContain(name);
  });

  it('booked: an unknown resource id is not passed off as a Pista', () => {
    const text = formatJobEvent({ kind: 'booked', job, reservationId: 1, choice: { courtId: 99, startMinutes: 600 } });
    expect(text).toContain('корт (id 99)');
    expect(text).not.toContain('Pista');
  });

  it('booked: the time range follows the job duration and wraps past midnight', () => {
    const text = formatJobEvent({
      kind: 'booked',
      job: makeJob({ durationMinutes: 120 }),
      reservationId: 5,
      choice: { courtId: 4, startMinutes: 22 * 60 + 30 },
    });
    expect(text).toContain('22:30–00:30');
  });

  it('booked: never carries access codes, pins, hashes or passwords', () => {
    const text = formatJobEvent({ kind: 'booked', job, reservationId: 100002, choice: { courtId: 9, startMinutes: 1080 } });
    expect(text).not.toMatch(/pin|парол|password|hash|код/i);
  });

  it('needs_payment', () => {
    const text = formatJobEvent({ kind: 'needs_payment', job, reservationId: 100003 });
    expect(text).toContain('нужна оплата');
    expect(text).toContain('Номер брони: 100003');
  });

  it('failed: the reason', () => {
    const text = formatJobEvent({ kind: 'failed', job, reason: 'слот уже занят' });
    expect(text).toContain('Не удалось забронировать');
    expect(text).toContain('Причина: слот уже занят');
  });

  it('ambiguous: tells the owner to check the booking by hand and not to expect a blind retry', () => {
    const text = formatJobEvent({ kind: 'ambiguous', job, detail: 'timeout after sending' });
    expect(text).toContain('проверьте бронь вручную');
    expect(text).toContain('не повторяет запрос вслепую');
    expect(text).toContain('Детали: timeout after sending');
  });

  it('expired', () => {
    const text = formatJobEvent({ kind: 'expired', job });
    expect(text).toContain('истекло');
    expect(text).toContain('ничего не забронировано');
  });

  it('keeps the markup balanced and every text short enough for Telegram', () => {
    const events: JobEvent[] = [
      { kind: 'armed', job },
      { kind: 'preflight_ok', job, walletCents: 1, quoteCents: 2 },
      { kind: 'preflight_failed', job, reason: 'no_funds', detail: 'x'.repeat(10_000) },
      { kind: 'window_open', job },
      { kind: 'booked', job, reservationId: 1, choice: { courtId: 4, startMinutes: 600 } },
      { kind: 'needs_payment', job, reservationId: 1 },
      { kind: 'failed', job, reason: 'y'.repeat(10_000) },
      { kind: 'ambiguous', job, detail: 'z'.repeat(10_000) },
      { kind: 'expired', job },
    ];
    for (const event of events) {
      const text = formatJobEvent(event);
      expect(balanced(text), event.kind).toBe(true);
      expect(text.length, event.kind).toBeLessThan(1500);
    }
  });
});

describe('formatJobEvent: hostile and secret text', () => {
  it('escapes HTML in reasons and details', () => {
    const hostile = '<b>bold</b> <a href="https://evil.example">click</a> &amp; "quotes"';
    for (const event of [
      { kind: 'failed', job, reason: hostile },
      { kind: 'ambiguous', job, detail: hostile },
      { kind: 'preflight_failed', job, reason: 'other', detail: hostile },
    ] as JobEvent[]) {
      const text = formatJobEvent(event);
      expect(text).not.toContain('<a href');
      expect(text).toContain('&lt;b&gt;bold&lt;/b&gt;');
      expect(text).toContain('&amp;amp;');
      expect(text).toContain('&quot;quotes&quot;');
      expect(balanced(text)).toBe(true);
    }
  });

  it('masks an account hash and a bot token that leaked into a failure reason', () => {
    const shapedToken = `123456789:${'A'.repeat(35)}`;
    const text = formatJobEvent({
      kind: 'failed',
      job,
      reason: `request failed hash=${FAKE_HASH} url=https://api.telegram.org/bot${shapedToken}/sendMessage`,
    });
    expect(text).not.toContain(FAKE_HASH);
    expect(text).not.toContain('AAAAAAAAAA');
    expect(text).toContain('[скрыто]');
  });

  it('truncates by code points, never splitting an emoji', () => {
    const text = formatJobEvent({ kind: 'failed', job, reason: '🎾'.repeat(2000) });
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(Array.from(text).filter((char) => char === '🎾')).toHaveLength(299);
    expect(text).toContain('…');
  });

  it('removes control and bidi-override characters from dynamic text', () => {
    const text = formatJobEvent({ kind: 'failed', job, reason: 'ok\u0000‮evil​\nsecond line' });
    expect(text).toContain('Причина: okevil second line');
  });
});
