import { describe, expect, it } from 'vitest';
import { classifyFormPage } from '../../src/reservaplay/classify.js';
import { createFakeSite } from '../fixtures/reservaplay/fakeSite.js';
import { htmlResponse } from '../fixtures/reservaplay/responses.js';
import { get, open } from './httpHelpers.js';
import { loggedIn, slotRef } from './helpers.js';

/** Bytes of a Latin-1 page: every character below U+0100 is one byte. */
const latin1 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Array.from(text, (char) => char.charCodeAt(0)));

const respondWith = (contentType: string | null, body: Uint8Array<ArrayBuffer>): Response =>
  new Response(body, { status: 200, headers: contentType === null ? {} : { 'content-type': contentType } });

const decoded = async (contentType: string | null, body: Uint8Array<ArrayBuffer>, maxResponseBytes?: number): Promise<string> => {
  const { session } = open(() => respondWith(contentType, body), maxResponseBytes === undefined ? {} : { maxResponseBytes });
  return (await get(session)).text;
};

describe('response decoding follows the declared charset', () => {
  const TOO_SHORT = 'El tiempo de reserva mínimo es de 60 minutos';

  it.each([
    ['ISO-8859-1', 'text/html; charset=ISO-8859-1'],
    ['latin1 (a WHATWG label)', 'text/html; charset=latin1'],
    ['windows-1252', 'text/html;charset=windows-1252'],
    ['a quoted label', 'text/html; charset="iso-8859-1"'],
    ['an upper-case parameter name and spaces', 'text/html ; CHARSET = ISO-8859-1 ; boundary=x'],
  ])('decodes %s', async (_name, contentType) => {
    expect(await decoded(contentType, latin1(TOO_SHORT))).toBe(TOO_SHORT);
  });

  it('still decodes UTF-8 with an explicit charset, without one, and without a Content-Type at all', async () => {
    const bytes = new TextEncoder().encode(`${TOO_SHORT} €`);
    for (const contentType of ['text/html; charset=UTF-8', 'text/html; charset=utf8', 'text/html', 'application/json', null]) {
      expect(await decoded(contentType, bytes), String(contentType)).toBe(`${TOO_SHORT} €`);
    }
  });

  it('falls back to UTF-8 for a label it does not know', async () => {
    const bytes = new TextEncoder().encode(TOO_SHORT);
    for (const contentType of ['text/html; charset=x-no-such-charset', 'text/html; charset=', 'text/html; charset="', 'text/html; charset=iso-2022-kr']) {
      expect(await decoded(contentType, bytes), contentType).toBe(TOO_SHORT);
    }
  });

  it('keeps multi-byte characters intact when a chunk boundary falls inside them', async () => {
    const bytes = new TextEncoder().encode('a€b');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2));
        controller.close();
      },
    });
    const { session } = open(() => new Response(stream, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    expect((await get(session)).text).toBe('a€b');
  });

  it('measures the size limit in bytes of the wire format, whatever the charset', async () => {
    const bytes = latin1('mínimo');
    expect(await decoded('text/html; charset=ISO-8859-1', bytes, bytes.byteLength)).toBe('mínimo');
    await expect(decoded('text/html; charset=ISO-8859-1', bytes, bytes.byteLength - 1)).rejects.toMatchObject({ reason: 'response_too_large' });
  });

  it('matters because the classifier only recognises correctly decoded accents', () => {
    const wronglyDecoded = new TextDecoder('utf-8').decode(latin1(TOO_SHORT));
    expect(classifyFormPage(wronglyDecoded)).toEqual({ kind: 'unknown' });
    expect(classifyFormPage(TOO_SHORT)).toEqual({ kind: 'too_short' });
  });
});

describe('a legacy script that answers in Latin-1', () => {
  const page = (body: string, contentType = 'text/html; charset=ISO-8859-1'): (() => Response) => () =>
    respondWith(contentType, latin1(`<html><body>${body}</body></html>`));

  it('is classified as too_short through probeForm', async () => {
    const { site, client } = await loggedIn(createFakeSite());
    site.state.form = page('<div class="msg">El tiempo de reserva mínimo es de 60 minutos</div>');
    expect(await client.probeForm(slotRef())).toEqual({ kind: 'too_short' });
  });

  it('keeps the server clock reading of the closed-window page ("comprobación")', async () => {
    const { site, client } = await loggedIn(createFakeSite());
    site.state.form = page('No se puede reservar a 8 o más dias vista.<p>Hora actual comprobación: 12/10/2026 06:59:58</p>');
    const gate = await client.probeForm(slotRef());
    expect(gate.kind).toBe('window_closed');
    if (gate.kind === 'window_closed') expect(gate.serverCheckTime?.toFormat('yyyy-MM-dd HH:mm:ss')).toBe('2026-10-12 06:59:58');
  });

  it('would be unrecognised if the declared charset were ignored', async () => {
    const { site, client } = await loggedIn(createFakeSite());
    site.state.form = page('El tiempo de reserva mínimo es de 60 minutos', 'text/html');
    expect(await client.probeForm(slotRef())).toEqual({ kind: 'unknown' });
  });

  it('still reads UTF-8 pages of the usual fixture', async () => {
    const { site, client } = await loggedIn(createFakeSite());
    site.state.form = () => htmlResponse('<div>El tiempo de reserva mínimo es de 60 minutos</div>');
    expect(await client.probeForm(slotRef())).toEqual({ kind: 'too_short' });
  });
});
