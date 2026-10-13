import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthExpiredError } from '../../src/reservaplay/errors.js';
import { createHttpSession, describeFetchFailure, TransportError, USER_AGENT, type HttpSession } from '../../src/reservaplay/http.js';
import { captureLogger } from './helpers.js';

/**
 * The only tests that use the platform's real `fetch` - against a throw-away server on the loopback interface, never
 * a real site. They pin down the assumptions the fake fetch makes (manual redirects, Set-Cookie handling, the shape
 * of undici's network errors).
 */

type Route = (request: IncomingMessage, response: ServerResponse, body: string) => void;

interface Harness {
  readonly session: HttpSession;
  readonly origin: string;
  readonly seen: { readonly headers: IncomingMessage['headers']; readonly body: string; readonly url: string }[];
}

const servers: Server[] = [];

const start = async (route: Route): Promise<Harness> => {
  const seen: Harness['seen'] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      seen.push({ headers: request.headers, body, url: request.url ?? '' });
      route(request, response, body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { session: createHttpSession({ baseUrl: origin, logger: captureLogger() }), origin, seen };
};

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('the real fetch', () => {
  it('does not follow redirects and exposes the Location header', async () => {
    const { session, origin, seen } = await start((_request, response) => {
      response.writeHead(302, { location: '/somewhere-else' }).end();
    });
    const result = await session.request({ method: 'GET', url: `${origin}/start`, label: 'test' });
    expect(result).toMatchObject({ status: 302, location: '/somewhere-else', text: '' });
    expect(seen).toHaveLength(1);
  });

  it('turns a redirect to /login into AuthExpiredError, and 401/419 too', async () => {
    for (const respond of [
      (response: ServerResponse) => response.writeHead(302, { location: '/login' }).end(),
      (response: ServerResponse) => response.writeHead(401).end(),
      (response: ServerResponse) => response.writeHead(419).end(),
    ]) {
      const { session, origin } = await start((_request, response) => respond(response));
      await expect(session.request({ method: 'GET', url: `${origin}/x`, label: 'test' })).rejects.toBeInstanceOf(AuthExpiredError);
    }
  });

  it('sends the plain User-Agent, the headers and the form body, and reads the answer', async () => {
    const { session, origin, seen } = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    });
    const result = await session.request({
      method: 'POST',
      url: `${origin}/sportssuite/manager.php`,
      label: 'test',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body: 'a=1&b=%C3%B1',
    });
    expect(result.text).toBe('{"status":"ok"}');
    expect(seen[0]?.headers['user-agent']).toBe(USER_AGENT);
    expect(seen[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    expect(seen[0]?.headers['x-requested-with']).toBe('XMLHttpRequest');
    expect(seen[0]?.body).toBe('a=1&b=%C3%B1');
  });

  it('keeps every Set-Cookie of a response and sends them back on the next request', async () => {
    const { session, origin, seen } = await start((request, response) => {
      if (request.url === '/set') {
        response.writeHead(200, { 'set-cookie': ['first=1; Path=/; HttpOnly', 'second=2; Path=/', 'third=3; Path=/; SameSite=Lax'] }).end('ok');
      } else {
        response.writeHead(200).end('ok');
      }
    });
    await session.request({ method: 'GET', url: `${origin}/set`, label: 'test' });
    await session.request({ method: 'GET', url: `${origin}/next`, label: 'test' });
    expect((seen[1]?.headers['cookie'] ?? '').split('; ').sort()).toEqual(['first=1', 'second=2', 'third=3']);
  });

  it('stores cookies set on a redirect response', async () => {
    const { session, origin, seen } = await start((request, response) => {
      if (request.url === '/redirect') response.writeHead(302, { location: '/home', 'set-cookie': 'sid=abc; Path=/' }).end();
      else response.writeHead(200).end('ok');
    });
    await session.request({ method: 'GET', url: `${origin}/redirect`, label: 'test' });
    await session.request({ method: 'GET', url: `${origin}/home`, label: 'test' });
    expect(seen[1]?.headers['cookie']).toBe('sid=abc');
  });

  it('reads a large body in several chunks', async () => {
    const payload = 'zñ'.repeat(300_000);
    const { session, origin } = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(payload);
    });
    const result = await session.request({ method: 'GET', url: `${origin}/big`, label: 'test' });
    expect(result.text).toBe(payload);
  });

  describe('network errors keep the "did it reach the server" information', () => {
    it('connection refused: the request was NOT sent', async () => {
      const { session, origin } = await start((_request, response) => response.end());
      for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      const error = await session.request({ method: 'POST', url: `${origin}/x`, label: 'test', body: 'a=1' }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(TransportError);
      expect(error).toMatchObject({ mayHaveReachedServer: false, code: 'ECONNREFUSED', reason: 'network' });
    });

    interface RawFailure {
      readonly cause?: { readonly code?: string; readonly syscall?: string; readonly errors?: readonly { readonly syscall?: string }[] };
    }

    const rawFailure = async (url: string): Promise<RawFailure> =>
      fetch(url, { method: 'POST', body: 'a=1' }).then(
        () => ({}),
        (error: unknown) => error as RawFailure,
      );

    const closedPort = async (): Promise<string> => {
      const { origin } = await start((_request, response) => response.end());
      for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      return new URL(origin).port;
    };

    it('a refused connection carries the connect syscall, on the member errors of a dual-stack AggregateError too', async () => {
      const port = await closedPort();

      const single = await rawFailure(`http://127.0.0.1:${port}/x`);
      expect(single.cause).toMatchObject({ code: 'ECONNREFUSED', syscall: 'connect' });
      expect(describeFetchFailure(single)).toEqual({ mayHaveReachedServer: false, code: 'ECONNREFUSED' });

      const dual = await rawFailure(`http://localhost:${port}/x`);
      for (const member of dual.cause?.errors ?? []) expect(member.syscall).toBe('connect');
      expect(describeFetchFailure(dual).mayHaveReachedServer).toBe(false);
    });

    it('a connection dropped after the request was written has no connect syscall, so it stays ambiguous', async () => {
      const { origin } = await start((request) => {
        request.socket.destroy();
      });
      const failure = await rawFailure(`${origin}/x`);
      expect(failure.cause?.syscall).not.toBe('connect');
      expect(describeFetchFailure(failure).mayHaveReachedServer).toBe(true);
    });

    it('connection refused through "localhost" (dual stack) is still NOT sent', async () => {
      const { origin } = await start((_request, response) => response.end());
      const port = new URL(origin).port;
      for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      const session = createHttpSession({ baseUrl: `http://localhost:${port}`, logger: captureLogger() });
      const error = await session.request({ method: 'POST', url: `http://localhost:${port}/x`, label: 'test', body: 'a=1' }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(TransportError);
      expect(error).toMatchObject({ mayHaveReachedServer: false });
    });

    it('the server drops the connection after receiving the request: it MAY have reached the server', async () => {
      const { session, origin, seen } = await start((request) => {
        request.socket.destroy();
      });
      const error = await session.request({ method: 'POST', url: `${origin}/x`, label: 'test', body: 'a=1' }).catch((reason: unknown) => reason);
      expect(seen).toHaveLength(1);
      expect(error).toBeInstanceOf(TransportError);
      expect(error).toMatchObject({ mayHaveReachedServer: true });
    });

    it('the server never answers: a timeout, which MAY have reached the server', async () => {
      const { origin, seen } = await start(() => undefined);
      const impatient = createHttpSession({ baseUrl: origin, logger: captureLogger(), defaultTimeoutMs: 150 });
      const error = await impatient.request({ method: 'POST', url: `${origin}/x`, label: 'test', body: 'a=1' }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(TransportError);
      expect(error).toMatchObject({ reason: 'timeout', mayHaveReachedServer: true });
      expect(seen).toHaveLength(1);
    });

    it('the server stalls in the middle of the body: a timeout too', async () => {
      const { origin } = await start((_request, response) => {
        response.writeHead(200, { 'content-length': '1000' });
        response.write('partial');
      });
      const impatient = createHttpSession({ baseUrl: origin, logger: captureLogger(), defaultTimeoutMs: 150 });
      const error = await impatient.request({ method: 'GET', url: `${origin}/x`, label: 'test' }).catch((reason: unknown) => reason);
      expect(error).toMatchObject({ name: 'TransportError', mayHaveReachedServer: true });
    });
  });
});
