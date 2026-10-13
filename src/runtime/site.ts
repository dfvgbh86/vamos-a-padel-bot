import { DateTime } from 'luxon';
import type { SiteEnv } from '../config/env.js';
import { CLUB_LUXON_OPTIONS } from '../config/timezone.js';
import type { Clock, ReservaplayApi } from '../contracts.js';
import { createReservaplayClient } from '../reservaplay/client.js';
import type { HttpLogger } from '../reservaplay/http.js';

/** The real ReservaPlay client for the configured account. Nothing is sent until the first call. */
export const createSiteApi = (
  env: SiteEnv,
  clock: Clock,
  logger: HttpLogger,
  fetchImpl?: typeof fetch,
): ReservaplayApi =>
  createReservaplayClient({
    baseUrl: env.baseUrl,
    username: env.username,
    password: env.password,
    logger,
    holidays: env.holidays,
    now: () => DateTime.fromMillis(clock.nowMs(), CLUB_LUXON_OPTIONS),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
