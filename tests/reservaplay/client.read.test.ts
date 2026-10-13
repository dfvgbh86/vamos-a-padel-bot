import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { InvalidGameDateError, parseGameDate } from '../../src/config/gameDate.js';
import { AuthExpiredError, UnexpectedResponseError } from '../../src/reservaplay/errors.js';
import { TransportError } from '../../src/reservaplay/http.js';
import { calendarPayload } from '../fixtures/reservaplay/calendar.js';
import { BASE_URL, HASH } from '../fixtures/reservaplay/constants.js';
import { createFakeSite } from '../fixtures/reservaplay/fakeSite.js';
import { closedWindowHtml, dailyLimitHtml, loginPageHtml, openFormHtml, tooShortHtml } from '../fixtures/reservaplay/pages.js';
import { emptyResponse, htmlResponse, jsonResponse, redirectResponse } from '../fixtures/reservaplay/responses.js';
import { clubNow, failureOf, intercepting, lastCall, loggedIn, makeClient, slotRef, switchableNetwork } from './helpers.js';

describe('getDay()', () => {
  const day = parseGameDate('2026-10-19');
  const CALENDAR_URL = `${BASE_URL}/api/tipo_recurso/1/reservas_usuario?day=26-10-19+00:00:00&InicioMostrarReservas=0`;

  it('requests the calendar with a two-digit year, the XHR header and the session cookie', async () => {
    const { site, client } = await loggedIn();
    await client.getDay(day);
    expect(site.calls).toHaveLength(1);
    expect(lastCall(site)).toMatchObject({ method: 'GET', url: CALENDAR_URL, redirect: 'manual' });
    expect(lastCall(site)?.headers['x-requested-with']).toBe('XMLHttpRequest');
    expect(lastCall(site)?.headers['accept']).toContain('application/json');
    expect(lastCall(site)?.headers['cookie']).toContain('laravel_session=');
  });

  it('formats single-digit months and days with zeros', async () => {
    const { site, client } = await loggedIn();
    await client.getDay(parseGameDate('2027-03-05'));
    expect(lastCall(site)?.url).toBe(`${BASE_URL}/api/tipo_recurso/1/reservas_usuario?day=27-03-05+00:00:00&InicioMostrarReservas=0`);
  });

  it('returns the parsed schedule', async () => {
    const { site, client } = await loggedIn();
    site.state.calendar = () =>
      calendarPayload([
        { id: 4, name: 'Pista 4', slots: [{ start: 540, end: 630, duration: 90, taken: true, own: 1 }] },
        { id: 9, name: 'Pista 7', slots: [{ start: 1080, end: 1170, duration: 90 }] },
      ]);
    const schedule = await client.getDay(day);
    expect(schedule.gameDate).toBe(day);
    expect(schedule.courts.map((court) => court.courtId)).toEqual([4, 9]);
    expect(schedule.courts[0]?.slots[0]).toMatchObject({ free: false, ownBooking: true });
    expect(schedule.courts[1]?.slots[0]).toMatchObject({ free: true, ownBooking: false });
  });

  it('throws UnexpectedResponseError for a wrong shape, without echoing the body', async () => {
    const { site, client } = await loggedIn();
    site.state.calendar = () => [[[{ id_mst_recurso: 4, horari: [{ hora_ini: 'BODY-MARKER' }] }]]];
    const error = await failureOf(client.getDay(day));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as Error).message).not.toContain('BODY-MARKER');
  });

  it('throws UnexpectedResponseError for a body that is not JSON, without echoing it', async () => {
    const { site } = await loggedIn();
    const wrapped = makeClient({ fetchImpl: intercepting(site, () => htmlResponse('<html>BODY-MARKER</html>')) });
    const error = await failureOf(wrapped.getDay(day));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as Error).message).not.toContain('BODY-MARKER');
    expect((error as Error).message).not.toContain('Unexpected token');
  });

  it('throws AuthExpiredError when the session is gone (redirect, 401, 419 or a login page)', async () => {
    const { site, client } = await loggedIn();
    site.expireSession();
    await expect(client.getDay(day)).rejects.toBeInstanceOf(AuthExpiredError);

    for (const respond of [() => emptyResponse(401), () => emptyResponse(419), () => htmlResponse(loginPageHtml())]) {
      const other = makeClient({ fetchImpl: (() => Promise.resolve(respond())) as unknown as typeof fetch });
      await expect(other.getDay(day)).rejects.toBeInstanceOf(AuthExpiredError);
    }
  });

  it('throws UnexpectedResponseError with the status for 5xx and other non-200 answers', async () => {
    for (const status of [500, 502, 404]) {
      const other = makeClient({ fetchImpl: (() => Promise.resolve(jsonResponse({ message: 'BODY-MARKER' }, { status }))) as unknown as typeof fetch });
      const error = await failureOf(other.getDay(day));
      expect(error).toBeInstanceOf(UnexpectedResponseError);
      expect((error as UnexpectedResponseError).status).toBe(status);
      expect((error as Error).message).not.toContain('BODY-MARKER');
    }
  });

  it('rejects a game date that is not a strict YYYY-MM-DD before sending anything', async () => {
    const { site, client } = await loggedIn();
    await expect(client.getDay('2026-13-45' as never)).rejects.toBeInstanceOf(InvalidGameDateError);
    expect(site.calls).toHaveLength(0);
  });

  it('propagates transport errors', async () => {
    const site = createFakeSite();
    const network = switchableNetwork(site);
    const { client } = await loggedIn(site, { fetchImpl: network.fetchImpl });
    network.arm('ECONNRESET');
    await expect(client.getDay(day)).rejects.toBeInstanceOf(TransportError);
  });
});

describe('probeForm()', () => {
  const FORM_URL = `${BASE_URL}/reserves/cal_event.php?data=2026-10-19%2000:00:00&hora=1080&hora_fin=1170&resource=9&date=26-10-12&diaheader19`;

  it('requests exactly the form URL of the real site', async () => {
    const { site, client } = await loggedIn();
    await client.probeForm(slotRef());
    expect(site.calls).toHaveLength(1);
    expect(lastCall(site)).toMatchObject({ method: 'GET', url: FORM_URL, redirect: 'manual' });
    expect(lastCall(site)?.headers['cookie']).toContain('laravel_session=');
  });

  it.each([
    ['hora_fin is start plus duration (60 min)', { durationMinutes: 60 }, 'hora=1080&hora_fin=1140&'],
    ['hora_fin for 120 min', { durationMinutes: 120 }, 'hora=1080&hora_fin=1200&'],
    ['another court', { courtId: 4 }, '&resource=4&'],
    ['a morning start', { startMinutes: 540 }, 'hora=540&hora_fin=630&'],
    ['no leading zero in the diaheader day', { gameDate: parseGameDate('2026-11-05') }, '&diaheader5'],
    ['a two-digit diaheader day', { gameDate: parseGameDate('2026-11-25') }, '&diaheader25'],
    ['the game date in the data parameter', { gameDate: parseGameDate('2026-11-05') }, 'data=2026-11-05%2000:00:00&'],
  ])('builds the URL correctly: %s', async (_name, overrides, fragment) => {
    const { site, client } = await loggedIn();
    await client.probeForm(slotRef(overrides));
    expect(lastCall(site)?.url).toContain(fragment);
  });

  it('takes the `date` parameter from the injected club clock (club time zone, two-digit year)', async () => {
    const cases: [DateTime, string][] = [
      [clubNow('2026-10-12T06:55:00'), 'date=26-10-12&'],
      [clubNow('2026-12-31T23:59:59'), 'date=26-12-31&'],
      [clubNow('2027-01-01T00:00:00'), 'date=27-01-01&'],
      [DateTime.fromISO('2026-10-11T23:30:00Z', { setZone: true }), 'date=26-10-12&'],
      [DateTime.fromISO('2026-10-12T22:30:00Z', { setZone: true }), 'date=26-10-13&'],
      [DateTime.fromISO('2026-10-12T03:30:00', { zone: 'America/New_York' }), 'date=26-10-12&'],
    ];
    for (const [now, fragment] of cases) {
      const { site, client } = await loggedIn(createFakeSite(), { now: () => now });
      await client.probeForm(slotRef());
      expect(lastCall(site)?.url, now.toISO() ?? '').toContain(fragment);
    }
  });

  it('fails clearly when the club clock is invalid, before sending', async () => {
    const { site, client } = await loggedIn(createFakeSite(), { now: () => DateTime.invalid('test') });
    await expect(client.probeForm(slotRef())).rejects.toThrow(/clock/);
    expect(site.calls).toHaveLength(0);
  });

  it('classifies the open form and returns its hash', async () => {
    const { client } = await loggedIn();
    expect(await client.probeForm(slotRef())).toEqual({ kind: 'open', hash: HASH });
  });

  it('classifies the closed-window page with the server check time', async () => {
    const { site, client } = await loggedIn();
    site.state.form = () => htmlResponse(closedWindowHtml('12/10/2026 06:59:58'));
    const gate = await client.probeForm(slotRef());
    expect(gate.kind).toBe('window_closed');
    if (gate.kind === 'window_closed') expect(gate.serverCheckTime?.toFormat('yyyy-MM-dd HH:mm:ss')).toBe('2026-10-12 06:59:58');
  });

  it.each([
    ['daily_limit', () => htmlResponse(dailyLimitHtml())],
    ['too_short', () => htmlResponse(tooShortHtml())],
    ['login_required', () => htmlResponse(loginPageHtml())],
    ['unknown', () => htmlResponse('<html><body>Something new</body></html>')],
  ])('returns the %s gate as a value, not as an error', async (kind, respond) => {
    const { site, client } = await loggedIn();
    site.state.form = respond;
    expect((await client.probeForm(slotRef())).kind).toBe(kind);
  });

  it('classifies the page body even when the status is a client error', async () => {
    const { site, client } = await loggedIn();
    site.state.form = () => htmlResponse(dailyLimitHtml(), { status: 403 });
    expect((await client.probeForm(slotRef())).kind).toBe('daily_limit');
  });

  describe('a transient or error answer is a failed probe, never a verdict', () => {
    const answering = async (response: () => Response) => {
      const context = await loggedIn();
      context.site.state.form = response;
      return context;
    };
    const expectProbeFailure = async (status: number, response: () => Response): Promise<void> => {
      const { site, client } = await answering(response);
      const error = await failureOf(client.probeForm(slotRef()));
      expect(error, `HTTP ${status}`).toBeInstanceOf(UnexpectedResponseError);
      expect((error as UnexpectedResponseError).status).toBe(status);
      expect((error as Error).message).toBe(`Booking form answered HTTP ${status}`);
      expect(site.calls).toHaveLength(1);
    };

    it.each([400, 403, 404, 408, 410, 425, 429])('throws on an unrecognised page behind HTTP %i (a retry may succeed, the job must not die)', async (status) => {
      await expectProbeFailure(status, () => htmlResponse('<html><body>Too many requests, try later</body></html>', { status }));
    });

    it.each([400, 403, 404, 408, 425, 429])('does not trust an open form behind HTTP %i', async (status) => {
      await expectProbeFailure(status, () => htmlResponse(openFormHtml(), { status }));
    });

    it.each([408, 425, 429])('throws on a login page behind the transient HTTP %i', async (status) => {
      await expectProbeFailure(status, () => htmlResponse(loginPageHtml(), { status }));
    });

    it('still asks for a new login when the login page comes with another client error', async () => {
      const { client } = await answering(() => htmlResponse(loginPageHtml(), { status: 403 }));
      expect((await client.probeForm(slotRef())).kind).toBe('login_required');
    });

    it.each([400, 403, 429])('keeps classifying the known notices behind HTTP %i', async (status) => {
      for (const [page, kind] of [
        [dailyLimitHtml(), 'daily_limit'],
        [tooShortHtml(), 'too_short'],
        [closedWindowHtml(), 'window_closed'],
      ] as const) {
        const { client } = await answering(() => htmlResponse(page, { status }));
        expect((await client.probeForm(slotRef())).kind, `${kind} behind HTTP ${status}`).toBe(kind);
      }
    });

    it('accepts the open form and an unknown page only behind a 2xx status', async () => {
      const open = await answering(() => htmlResponse(openFormHtml(), { status: 200 }));
      expect((await open.client.probeForm(slotRef())).kind).toBe('open');
      const unknown = await answering(() => htmlResponse('<p>nope</p>', { status: 203 }));
      expect(await unknown.client.probeForm(slotRef())).toEqual({ kind: 'unknown' });
    });

    it('gives getAccountContext the same protection: no account id from a form behind an error status', async () => {
      const { client } = await answering(() => htmlResponse(openFormHtml(), { status: 429 }));
      await expect(client.getAccountContext(slotRef())).rejects.toBeInstanceOf(UnexpectedResponseError);
    });
  });

  it('throws AuthExpiredError when the session is gone', async () => {
    const { site, client } = await loggedIn();
    site.expireSession();
    await expect(client.probeForm(slotRef())).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it.each([500, 502, 503])('throws UnexpectedResponseError on HTTP %i without reading the page', async (status) => {
    const { site, client } = await loggedIn();
    site.state.form = () => htmlResponse(openFormHtml(), { status });
    const error = await failureOf(client.probeForm(slotRef()));
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect((error as UnexpectedResponseError).status).toBe(status);
  });

  it('throws UnexpectedResponseError on a redirect that is not to the login page', async () => {
    const { site, client } = await loggedIn();
    site.state.form = () => redirectResponse('/somewhere');
    await expect(client.probeForm(slotRef())).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it('refuses an impossible slot before sending anything', async () => {
    const { site, client } = await loggedIn();
    for (const bad of [{ courtId: Number.NaN }, { courtId: 0 }, { startMinutes: -1 }, { startMinutes: 1440 }, { durationMinutes: 0 }, { durationMinutes: 1.5 }]) {
      await expect(client.probeForm(slotRef(bad))).rejects.toThrow();
    }
    expect(site.calls).toHaveLength(0);
  });

  it('propagates transport errors', async () => {
    const site = createFakeSite();
    const network = switchableNetwork(site);
    const { client } = await loggedIn(site, { fetchImpl: network.fetchImpl });
    network.arm('ECONNREFUSED');
    expect(await failureOf(client.probeForm(slotRef()))).toMatchObject({ name: 'TransportError', mayHaveReachedServer: false });
  });
});

