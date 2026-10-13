/**
 * The whole bot, wired by createApp, running against fakes: a virtual clock, a fake site, a fake Telegram
 * transport driven by synthetic updates, and a real in-memory SQLite job store. Nothing touches a network.
 */
import { Writable } from 'node:stream';
import type { Transformer } from 'grammy';
import { DateTime } from 'luxon';
import { createApp, type App, type AppOverrides, type AppStore } from '../../src/app.js';
import type { Env } from '../../src/config/env.js';
import { buildHolidaySet } from '../../src/config/holidays.js';
import { CLUB_LUXON_OPTIONS } from '../../src/config/timezone.js';
import { parseGameDate } from '../../src/config/gameDate.js';
import type { JobState } from '../../src/contracts.js';
import { createLogger } from '../../src/runtime/logger.js';
import { bookingOpensAt } from '../../src/sniper/openTime.js';
import {
  callbackUpdate,
  createFakeTransport,
  FAKE_TOKEN,
  messageUpdate,
  OWNER_ID,
  type ApiCall,
  type Button,
  type FakeTransport,
} from '../telegram/_harness.js';
import { FakeSite } from './_site.js';
import { createVirtualClock, type VirtualClock } from './_virtualClock.js';

export const PASSWORD = 'synthetic-password-0001';
export const USERNAME = 'test-player';

/** Tuesday 13 October 2026, 06:30 in Madrid (UTC+2): half an hour before the window of the 20th opens. */
export const START_MS = DateTime.fromISO('2026-10-13T06:30:00', CLUB_LUXON_OPTIONS).toMillis();
export const GAME_DAY = parseGameDate('2026-10-20');
/** 07:00 on the 13th: when 20 October opens. */
export const OPENS_MS = bookingOpensAt(GAME_DAY).toMillis();
export const MINUTE = 60_000;

export const TEST_ENV: Env = {
  telegramBotToken: FAKE_TOKEN,
  allowedUserIds: [OWNER_ID],
  baseUrl: 'https://club.example.test',
  username: USERNAME,
  password: PASSWORD,
  holidays: buildHolidaySet(undefined),
  dbPath: ':memory:',
  logLevel: 'silent',
};

export interface Screen {
  readonly method: string;
  readonly text: string;
  readonly buttons: readonly Button[];
}

const toScreen = (call: ApiCall): Screen => {
  const markup = call.payload['reply_markup'] as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined;
  return {
    method: call.method,
    text: String(call.payload['text'] ?? ''),
    buttons: (markup?.inline_keyboard ?? []).flat().map((button) => ({ text: button.text, data: button.callback_data ?? '' })),
  };
};

export interface Wish {
  readonly court: string;
  readonly time: string;
}

export interface Owner {
  say(text: string): Promise<void>;
  press(label: string | RegExp): Promise<void>;
  screen(): Screen;
  /** /new: the date button, then court + time for every wish in priority order, then "Готово" and "Подтвердить". */
  createJob(dateLabel: string, wishes: readonly Wish[]): Promise<void>;
}

export interface SentMessage {
  readonly chatId: number;
  readonly text: string;
  /** Job state in the store when the message left the bot. */
  readonly storeState: JobState | undefined;
}

export interface RigOptions {
  readonly startMs?: number;
  readonly walletCents?: number;
  readonly latency?: FakeSite['latencyMs'];
  readonly store?: AppStore;
  readonly overrides?: Partial<AppOverrides>;
  readonly env?: Partial<Env>;
  /** The site starts with a live session (otherwise the first request has to log in, like after a fresh start). */
  readonly loggedIn?: boolean;
  /** Runs the REAL ReservaPlay client over this fetch (a fake site) instead of the fake API. */
  readonly fetchImpl?: typeof fetch;
}

export interface Rig {
  readonly app: App;
  readonly site: FakeSite;
  readonly clock: VirtualClock;
  readonly transport: FakeTransport;
  readonly owner: Owner;
  /** Everything the bot logged, as one string. */
  readonly logText: () => string;
  /** Every message the bot sent, in order, with the job state at that moment. */
  readonly sent: () => SentMessage[];
  /** `advanceMs`: virtual time that passes while the app starts (recovery waits for a request sent before a crash to settle). */
  start(advanceMs?: number): Promise<void>;
  stop(): Promise<void>;
  /** Moves virtual time to `targetMs`, letting the bot run on the way. */
  runTo(targetMs: number): Promise<void>;
  /** Moves virtual time to the opening of the window plus `afterMs`. */
  runPastOpening(afterMs?: number): Promise<void>;
}

/** Guards a step that must finish without virtual time passing: fails the test instead of hanging it. */
export const withRealDeadline = async <T>(work: Promise<T>, what: string, ms = 5000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms of real time`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
};

export const createRig = (options: RigOptions = {}): Rig => {
  const clock = createVirtualClock(options.startMs ?? START_MS);
  const site = new FakeSite(clock);
  site.walletCents = options.walletCents ?? 5000;
  site.loggedIn = options.loggedIn ?? false;
  Object.assign(site.latencyMs, options.latency);
  const transport = createFakeTransport();

  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });

  const states: { text: string; chatId: number; storeState: JobState | undefined }[] = [];
  let appRef: App | undefined;
  const transformer: Transformer = (prev, method, payload, signal) => {
    if (method === 'sendMessage') {
      const body = payload as unknown as { chat_id: number; text?: string };
      const job = appRef?.store.list().at(-1);
      states.push({ text: String(body.text ?? ''), chatId: Number(body.chat_id), storeState: job?.state });
    }
    return transport.transformer(prev, method, payload, signal);
  };

  const env: Env = { ...TEST_ENV, ...options.env };
  const app = createApp(env, {
    logger: createLogger('debug', sink),
    clock,
    ...(options.fetchImpl === undefined ? { api: site } : { fetchImpl: options.fetchImpl }),
    telegramTransformer: transformer,
    ...(options.store === undefined ? {} : { store: options.store }),
    ...options.overrides,
  });
  appRef = app;

  const send = (update: ReturnType<typeof messageUpdate>): Promise<void> => app.telegram.bot.handleUpdate(update);
  const screens = (): Screen[] =>
    transport.calls.filter((call) => call.method === 'sendMessage' || call.method === 'editMessageText').map(toScreen);
  const screen = (): Screen => {
    const latest = screens().at(-1);
    if (latest === undefined) throw new Error('the bot has not shown anything yet');
    return latest;
  };
  const press = async (label: string | RegExp): Promise<void> => {
    const current = screen();
    const match = current.buttons.find((button) => (typeof label === 'string' ? button.text.includes(label) : label.test(button.text)));
    if (match === undefined) throw new Error(`no button ${String(label)}; buttons: ${current.buttons.map((button) => button.text).join(' | ')}`);
    await send(callbackUpdate(match.data));
  };

  const owner: Owner = {
    say: (text) => send(messageUpdate(text)),
    press,
    screen,
    createJob: async (dateLabel, wishes) => {
      await send(messageUpdate('/new'));
      await press(dateLabel);
      for (const wish of wishes) {
        await press(wish.court);
        await press(wish.time);
      }
      await press('Готово');
      await press('Подтвердить');
    },
  };

  return {
    app,
    site,
    clock,
    transport,
    owner,
    logText: () => lines.join(''),
    sent: () => states.map(({ text, chatId, storeState }) => ({ chatId, text, storeState })),
    start: async (advanceMs = 0) => {
      const started = app.start();
      await clock.settle();
      if (advanceMs > 0) await clock.advanceBy(advanceMs);
      await withRealDeadline(started, 'app.start()');
    },
    stop: async () => {
      const stopped = app.stop();
      await clock.advanceBy(10_000);
      await withRealDeadline(stopped, 'app.stop()');
    },
    runTo: (targetMs) => clock.advanceTo(targetMs),
    runPastOpening: (afterMs = 30_000) => clock.advanceTo(OPENS_MS + afterMs),
  };
};

/** Messages of the bot that contain `text` (notifications and flow screens alike). */
export const messagesWith = (rig: Rig, text: string): SentMessage[] => rig.sent().filter((message) => message.text.includes(text));
