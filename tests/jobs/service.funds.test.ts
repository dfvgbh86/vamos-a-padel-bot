import { afterEach, describe, expect, it } from 'vitest';
import { createJobService } from '../../src/jobs/service.js';
import { SqliteJobStore } from '../../src/jobs/store.js';
import { buildHolidaySet } from '../../src/config/holidays.js';
import { cleanupTemp, date, makeApi, makeClock, makeLogger, track } from './_helpers.js';
import { created, harness, request } from './_service.js';

afterEach(cleanupTemp);

const FUTURE = date('2026-10-21');

describe('createJob: funds check (owner requirement)', () => {
  it('reports ok when the wallet covers the quoted price', async () => {
    const { service, api } = harness();
    api.getWallet.mockResolvedValue({ balanceCents: 5000 });
    api.quote.mockResolvedValue({ totalCents: 1902, walletPayable: true });
    const result = created(await service.createJob(request()));
    expect(result).toMatchObject({ walletCents: 5000, requiredCents: 1902, requiredIsEstimate: false, fundsOk: true });
  });

  it('asks the site for the price of the FIRST choice with the job duration and payment', async () => {
    const { service, api } = harness();
    await service.createJob(
      request({
        choices: [{ courtId: 10, startMinutes: 1170 }, { courtId: 9, startMinutes: 1080 }],
        durationMinutes: 120,
      }),
    );
    expect(api.quote).toHaveBeenCalledTimes(1);
    expect(api.quote).toHaveBeenCalledWith({ gameDate: '2026-10-20', courtId: 10, startMinutes: 1170, durationMinutes: 120 }, 'wallet');
  });

  it('the boundary is inclusive: exactly enough is ok, one cent short is not', async () => {
    const exact = harness();
    exact.api.getWallet.mockResolvedValue({ balanceCents: 1902 });
    expect(created(await exact.service.createJob(request())).fundsOk).toBe(true);

    const short = harness();
    short.api.getWallet.mockResolvedValue({ balanceCents: 1901 });
    expect(created(await short.service.createJob(request())).fundsOk).toBe(false);
  });

  it('still creates the job when funds are short, but flags it so the bot can warn immediately', async () => {
    const { service, store, api } = harness();
    api.getWallet.mockResolvedValue({ balanceCents: 500 });
    const result = created(await service.createJob(request()));
    expect(result).toMatchObject({ walletCents: 500, requiredCents: 1902, requiredIsEstimate: false, fundsOk: false });
    expect(store.get(result.job.id)?.state).toBe('scheduled');
  });

  it('an empty wallet is short, not unknown', async () => {
    const { service, api } = harness();
    api.getWallet.mockResolvedValue({ balanceCents: 0 });
    expect(created(await service.createJob(request()))).toMatchObject({ walletCents: 0, fundsOk: false });
  });

  it('uses the price quoted by the site, not the constant', async () => {
    const { service, api } = harness();
    api.getWallet.mockResolvedValue({ balanceCents: 2500 });
    api.quote.mockResolvedValue({ totalCents: 2700, walletPayable: false });
    expect(created(await service.createJob(request()))).toMatchObject({ requiredCents: 2700, requiredIsEstimate: false, fundsOk: false });
  });
});

describe('createJob: estimate when the site cannot quote', () => {
  it('a date that is not open yet is priced with the default estimate of 19.02 EUR and flagged as an estimate', async () => {
    const { service, api } = harness();
    const result = created(await service.createJob(request({ gameDate: FUTURE })));
    expect(result).toMatchObject({ walletCents: 5000, requiredCents: 1902, requiredIsEstimate: true, fundsOk: true });
    expect(api.quote).not.toHaveBeenCalled();
    expect(api.getWallet).toHaveBeenCalledTimes(1);
  });

  it('warns about a short wallet against the estimate too', async () => {
    const { service, api } = harness();
    api.getWallet.mockResolvedValue({ balanceCents: 1500 });
    expect(created(await service.createJob(request({ gameDate: FUTURE })))).toMatchObject({
      requiredCents: 1902,
      requiredIsEstimate: true,
      fundsOk: false,
    });
  });

  it('honours a custom estimate', async () => {
    const { service, api } = harness({ estimatedPriceCents: 2500 });
    api.getWallet.mockResolvedValue({ balanceCents: 2000 });
    expect(created(await service.createJob(request({ gameDate: FUTURE })))).toMatchObject({
      requiredCents: 2500,
      requiredIsEstimate: true,
      fundsOk: false,
    });
  });

  it('falls back to the estimate when the quote throws', async () => {
    const { service, api, logger } = harness();
    api.quote.mockRejectedValue(new Error('SECRET-RESPONSE-BODY'));
    expect(created(await service.createJob(request()))).toMatchObject({ requiredCents: 1902, requiredIsEstimate: true, fundsOk: true });
    expect(logger.dump()).not.toContain('SECRET-RESPONSE-BODY');
  });

  it('falls back to the estimate when the site reports no price', async () => {
    const { service, api } = harness();
    api.quote.mockResolvedValue({ totalCents: null, walletPayable: true });
    expect(created(await service.createJob(request()))).toMatchObject({ requiredCents: 1902, requiredIsEstimate: true });
  });

  it.each([0, -5, 19.02, Number.NaN, Number.POSITIVE_INFINITY, '1902'])('does not trust a quoted total of %s', async (totalCents) => {
    const { service, api } = harness();
    api.quote.mockResolvedValue({ totalCents: totalCents as never, walletPayable: true });
    expect(created(await service.createJob(request()))).toMatchObject({ requiredCents: 1902, requiredIsEstimate: true });
  });

  it('survives a quote call that throws synchronously', async () => {
    const { service, api } = harness();
    api.quote.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(created(await service.createJob(request()))).toMatchObject({ requiredIsEstimate: true });
  });
});

describe('createJob: wallet that cannot be read never blocks creation', () => {
  it('creates the job with an unknown balance when the read fails, the wallet flag of the site vouches for the funds', async () => {
    const { service, store, api, logger } = harness();
    api.getWallet.mockRejectedValue(new Error('SECRET-RESPONSE-BODY'));
    const result = created(await service.createJob(request()));
    expect(result).toMatchObject({ walletCents: null, requiredCents: 1902, requiredIsEstimate: false, fundsOk: true });
    expect(store.list().length).toBe(1);
    expect(logger.dump()).not.toContain('SECRET-RESPONSE-BODY');
  });

  it.each([-1, 12.5, Number.NaN, '5000', null, undefined])('treats a nonsensical balance %s as unknown', async (balanceCents) => {
    const { service, api } = harness();
    api.getWallet.mockResolvedValue({ balanceCents: balanceCents as never });
    expect(created(await service.createJob(request()))).toMatchObject({ walletCents: null, fundsOk: true });
  });

  it('survives a wallet call that returns nothing or throws synchronously', async () => {
    const { service, api } = harness();
    api.getWallet.mockResolvedValue(undefined as never);
    expect(created(await service.createJob(request({ gameDate: FUTURE }))).walletCents).toBeNull();
    api.getWallet.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(created(await service.createJob(request({ gameDate: date('2026-10-22') }))).walletCents).toBeNull();
  });

  it('never claims funds are fine when the site itself says the wallet option is disabled', async () => {
    const { service, api } = harness();
    api.getWallet.mockRejectedValue(new Error('down'));
    api.quote.mockResolvedValue({ totalCents: 1902, walletPayable: false });
    expect(created(await service.createJob(request()))).toMatchObject({ walletCents: null, requiredCents: 1902, fundsOk: false });
  });

  it('an unknown balance stays ok when the site says the wallet option is enabled', async () => {
    const { service, api } = harness();
    api.getWallet.mockRejectedValue(new Error('down'));
    api.quote.mockResolvedValue({ totalCents: 1902, walletPayable: true });
    expect(created(await service.createJob(request()))).toMatchObject({ walletCents: null, fundsOk: true });
  });

  it('an unreadable balance is reported as unverifiable (fundsOk false, balance null) when nothing else vouches for it', async () => {
    const { service, store, api } = harness();
    api.getWallet.mockRejectedValue(new Error('down'));
    const result = created(await service.createJob(request({ gameDate: FUTURE })));
    expect(result).toMatchObject({ walletCents: null, requiredCents: 1902, requiredIsEstimate: true, fundsOk: false });
    expect(store.get(result.job.id)?.state).toBe('scheduled');
  });

  it('is also unverifiable when the quote failed too', async () => {
    const { service, api } = harness();
    api.getWallet.mockRejectedValue(new Error('down'));
    api.quote.mockRejectedValue(new Error('down'));
    expect(created(await service.createJob(request()))).toMatchObject({ walletCents: null, requiredIsEstimate: true, fundsOk: false });
  });

  it('a quote without a usable total still vouches for an unreadable balance when it says the wallet is enabled', async () => {
    const { service, api } = harness();
    api.getWallet.mockRejectedValue(new Error('down'));
    api.quote.mockResolvedValue({ totalCents: null, walletPayable: true });
    expect(created(await service.createJob(request()))).toMatchObject({ walletCents: null, requiredIsEstimate: true, fundsOk: true });
  });
});

describe('createJob: the wallet flag of the site (radio "Monedero virtual" disabled = not enough credit)', () => {
  it('a disabled wallet option makes funds short even when the balance looks sufficient', async () => {
    const { service, api } = harness();
    api.getWallet.mockResolvedValue({ balanceCents: 5000 });
    api.quote.mockResolvedValue({ totalCents: 1902, walletPayable: false });
    expect(created(await service.createJob(request()))).toMatchObject({ walletCents: 5000, requiredCents: 1902, fundsOk: false });
  });

  it('counts even when the quote has no usable total (the estimate gives the number, the flag is still an answer)', async () => {
    const { service, api } = harness();
    api.getWallet.mockResolvedValue({ balanceCents: 2500 });
    api.quote.mockResolvedValue({ totalCents: null, walletPayable: false });
    expect(created(await service.createJob(request()))).toMatchObject({
      walletCents: 2500,
      requiredCents: 1902,
      requiredIsEstimate: true,
      fundsOk: false,
    });
  });

  it.each([0, -5, Number.NaN])('counts when the quoted total is %s (unusable)', async (totalCents) => {
    const { service, api } = harness();
    api.getWallet.mockResolvedValue({ balanceCents: 5000 });
    api.quote.mockResolvedValue({ totalCents, walletPayable: false });
    expect(created(await service.createJob(request()))).toMatchObject({ requiredIsEstimate: true, fundsOk: false });
  });

  it('an enabled wallet option does not hide a short balance', async () => {
    const { service, api } = harness();
    api.getWallet.mockResolvedValue({ balanceCents: 500 });
    api.quote.mockResolvedValue({ totalCents: 1902, walletPayable: true });
    expect(created(await service.createJob(request())).fundsOk).toBe(false);
  });

  it('a flag that is not a boolean is not an answer and is ignored', async () => {
    const { service, api } = harness();
    api.quote.mockResolvedValue({ totalCents: 1902, walletPayable: 'no' as never });
    expect(created(await service.createJob(request())).fundsOk).toBe(true);
  });

  it('is not consulted for a date that cannot be quoted yet', async () => {
    const { service, api } = harness();
    api.quote.mockResolvedValue({ totalCents: 1902, walletPayable: false });
    expect(created(await service.createJob(request({ gameDate: FUTURE }))).fundsOk).toBe(true);
    expect(api.quote).not.toHaveBeenCalled();
  });
});

describe('createJob: card payment', () => {
  it('does not compare the wallet (the card pays): no wallet or quote request, fundsOk true', async () => {
    const { service, api } = harness();
    api.getWallet.mockResolvedValue({ balanceCents: 0 });
    const result = created(await service.createJob(request({ payment: 'card' })));
    expect(result).toMatchObject({ walletCents: null, requiredCents: null, requiredIsEstimate: false, fundsOk: true });
    expect(api.getWallet).not.toHaveBeenCalled();
    expect(api.quote).not.toHaveBeenCalled();
  });
});

describe('createJobService construction', () => {
  const build = (estimatedPriceCents: number) =>
    createJobService({
      store: track(new SqliteJobStore(':memory:')),
      api: makeApi(),
      clock: makeClock(),
      holidays: buildHolidaySet(undefined),
      logger: makeLogger(),
      estimatedPriceCents,
    });

  it.each([0, -1, 19.02, Number.NaN, Number.POSITIVE_INFINITY])('rejects an unusable estimate of %s', (value) => {
    expect(() => build(value)).toThrow(/estimatedPriceCents/);
  });

  it('accepts a positive integer estimate', () => {
    expect(() => build(1902)).not.toThrow();
  });
});
