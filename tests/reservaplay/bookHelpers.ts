import type { ReservaplayClientConfig } from '../../src/reservaplay/client.js';
import type { FakeSite } from '../fixtures/reservaplay/fakeSite.js';
import { loggedIn } from './helpers.js';

export const ready = (overrides: Partial<ReservaplayClientConfig> = {}) => loggedIn(undefined, overrides);

export const posts = (site: FakeSite) => site.callsTo('manager.php');

export const respondWith = (site: FakeSite, response: () => Response): void => {
  site.state.manager = () => response();
};
