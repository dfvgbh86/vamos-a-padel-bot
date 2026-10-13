import { createHttpSession, type HttpRequest, type HttpSession, type HttpSessionOptions } from '../../src/reservaplay/http.js';
import { BASE_URL } from '../fixtures/reservaplay/constants.js';
import { createFakeFetch, type Handler } from '../fixtures/reservaplay/fakeFetch.js';
import { captureLogger } from './helpers.js';

export const open = (handler: Handler, options: Partial<HttpSessionOptions> = {}) => {
  const fake = createFakeFetch(handler);
  const logger = captureLogger();
  const session: HttpSession = createHttpSession({ baseUrl: BASE_URL, logger, fetchImpl: fake.fetchImpl, ...options });
  return { ...fake, logger, session };
};

export const get = (session: HttpSession, path = '/page', extra: Partial<HttpRequest> = {}) =>
  session.request({ method: 'GET', url: `${BASE_URL}${path}`, label: 'test', ...extra });

export const failureOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the request to fail');
};
