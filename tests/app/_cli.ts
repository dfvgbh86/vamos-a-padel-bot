import type { SiteEnv } from '../../src/config/env.js';
import type { CliDeps } from '../../src/cli/types.js';
import { runCli } from '../../src/cli/run.js';
import type { JobStore, ReservaplayApi } from '../../src/contracts.js';
import { START_MS, PASSWORD, USERNAME } from './_rig.js';
import { FakeSite } from './_site.js';
import { createVirtualClock } from './_virtualClock.js';

export const SITE_ENV = { RESERVAPLAY_USERNAME: USERNAME, RESERVAPLAY_PASSWORD: PASSWORD };

export interface CliRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export interface CliRig {
  readonly site: FakeSite;
  readonly outChunks: string[];
  readonly errChunks: string[];
  readonly createdFor: SiteEnv[];
  run(argv: readonly string[], patch?: Partial<CliDeps>): Promise<CliRun>;
}

/** The CLI on a fake site and a virtual clock; every written chunk is kept. */
export const createCliRig = (env: Record<string, string | undefined> = SITE_ENV): CliRig => {
  const clock = createVirtualClock(START_MS);
  const site = new FakeSite(clock);
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const createdFor: SiteEnv[] = [];
  const base: CliDeps = {
    env,
    out: (text) => void outChunks.push(text),
    err: (text) => void errChunks.push(text),
    clock,
    createApi: (siteEnv): ReservaplayApi => {
      createdFor.push(siteEnv);
      return site;
    },
  };
  return {
    site,
    outChunks,
    errChunks,
    createdFor,
    run: async (argv, patch = {}) => {
      const code = await runCli(argv, { ...base, ...patch });
      return { code, out: outChunks.join(''), err: errChunks.join('') };
    },
  };
};

export type ClosableStore = JobStore & { close(): void; closed: boolean };

export const closable = (store: JobStore & { close(): void }): ClosableStore => {
  const wrapper = {
    create: (...args: Parameters<JobStore['create']>) => store.create(...args),
    get: (id: number) => store.get(id),
    list: (filter?: Parameters<JobStore['list']>[0]) => store.list(filter),
    transition: (...args: Parameters<JobStore['transition']>) => store.transition(...args),
    isStopped: () => store.isStopped(),
    setStopped: (stopped: boolean) => store.setStopped(stopped),
    closed: false,
    close: () => {
      wrapper.closed = true;
      store.close();
    },
  };
  return wrapper;
};
