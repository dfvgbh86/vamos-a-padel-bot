# vamos-a-padel-bot

A personal Telegram bot that books a padel court at [Enjoy Valencia](https://enjoyvalenciaclubesoutdoor.reservaplay.com)
(ReservaPlay platform) the moment the booking window opens, using the owner's own account.

> **Status: working.** Login, calendar, wallet, a booking made through the bot's own requests and its cancellation have been
> run against the real club site, and a booking has been made end to end from Telegram. What the site answers for a slot
> that was just taken or for an empty wallet has not been observed yet: such an answer stops the job with an alert. The
> rules and invariants are in [CONTRACT.md](CONTRACT.md).

## What it does

1. In Telegram you send `/new`, pick a date, one or more courts with a start time each (in priority order) and confirm.
2. The bot arms the job for the moment the window of that date opens: **`D-7` 07:00 Europe/Madrid**.
3. Ten minutes before, it logs in, reads the account context, checks the wallet against the price and calibrates its
   clock against the server's. A shortage of money is reported at once (when the job is created, and again before the
   window), never discovered silently at 07:00.
4. From three seconds before the opening it polls the booking form of the first wished slot. **Only when the server
   itself shows an open form** it sends a booking request (host + 3 guests, paid from the club wallet), one at a time,
   and reports the result in Telegram.

## Rules that are built in

- On weekdays the academy courts (resource ids `1, 2, 3, 7, 8`, i.e. Pista 1-3 and 5-6) are **never** booked; on
  weekends and official Valencia holidays (2026-2027 built in, more through `EXTRA_HOLIDAYS`) all ten courts are
  allowed. The guard lives inside the booking-body builder, on the exact values that are sent.
- The window is never bypassed: no booking request is sent before the server rendered an open form for that slot.
- At most one booking request is in flight. An unclear outcome (timeout, reset, 502/504, an answer nobody
  understands) blocks sending again until the calendar was checked for an own booking on that date.
- An unknown answer stops the job and alerts you instead of retrying blindly.
- The emergency stop (`/stop`) is checked before every booking request and survives a restart; `/resume` lifts it.
- A booking is stored in the database **before** the Telegram message about it is sent.
- The bot never cancels a booking on its own.
- Only the Telegram user ids in `TELEGRAM_ALLOWED_USER_IDS` are served (private chats only); everybody else is ignored
  without a reply. An empty list is a startup error, never "everyone".
- Passwords, tokens, hashes and cookies are never logged (the logger redacts them by key; error messages are scrubbed).

## Running on your PC

Requires Node 22+ on Windows (or any OS) and a PC that is **on and awake at the opening time**
(`scripts\keep-pc-awake.cmd` stops Windows from sleeping while the PC is plugged in; a wake timer and autostart are
not set up).

1. **Rotate secrets that were ever pasted anywhere** (a chat, an issue, a screenshot): revoke the Telegram bot token with
   `@BotFather` (`/revoke`) and change the club password, *before the first run*.
2. Create your configuration: copy `.env.example` to `.env` and fill in `TELEGRAM_BOT_TOKEN`, `RESERVAPLAY_USERNAME`
   and `RESERVAPLAY_PASSWORD`. `.env` is git-ignored; only Node reads it (`--env-file`), the bot's code never does.
   A value with `#`, spaces or quotes must be wrapped in quotes: `RESERVAPLAY_PASSWORD="my pass#word"`.
3. Install and build:
   ```bash
   npm install
   npm run build
   ```
4. Find out your Telegram user id (the bot must not be running): run `npm run cli -- whoami-telegram`, send any
   message to your bot, and put the printed number into `TELEGRAM_ALLOWED_USER_IDS` (several ids: comma-separated).
5. Check the login: `npm run cli -- login-check` prints `OK` or `FAIL` (the reason goes to stderr).
6. Start the bot: `npm start`. Stop it with Ctrl+C (Telegram, the sniper and the database are shut down in order).

Windows helpers in `scripts\` (double-click): `whoami-telegram.cmd`, `check-live.cmd` (build, then the read-only live
checks below, saved to `logs\check-live.txt`), `start-bot.cmd` (build and start; the log is also appended to
`logs\bot.log`) and `keep-pc-awake.cmd` (run it yourself once: it changes the Windows power settings).

Optional live checks, read-only: `npm run cli -- slots 2026-10-20` (free slots on the courts the bot may book),
`npm run cli -- wallet`, `npm run cli -- status` (emergency stop, session, wallet, next window, jobs).
They log in separately: do not run them in the minutes before a window opens.

Telegram commands: `/new`, `/jobs`, `/cancel <id>` (cancels a *job*, never a booking), `/status`, `/wallet`,
`/stop`, `/resume`, `/help`.

Commands that need the club site (the date picker of `/new`, the balance check when a job is created, `/wallet`,
`/status`) log in on demand. In the 15 minutes before a window opens the sniper owns the session: such a command
then answers with a service error until the sniper has logged in. The price shown when a job is created is usually an
estimate (19.02 EUR for 90 minutes); the exact price is read by the preparation ten minutes before the window.

If Telegram polling dies while the bot runs (for example a second copy was started with the same token) the error is
logged, booking jobs keep running and results are still sent; restart the bot to get the commands back.

### Configuration (`.env`)

| Key | Required | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | Bot token from `@BotFather` |
| `TELEGRAM_ALLOWED_USER_IDS` | yes | Comma-separated numeric Telegram user ids; empty = the bot refuses to start |
| `RESERVAPLAY_USERNAME`, `RESERVAPLAY_PASSWORD` | yes | The club account |
| `RESERVAPLAY_BASE_URL` | no | Default `https://enjoyvalenciaclubesoutdoor.reservaplay.com` (https only; plain http is accepted for `127.0.0.1`, `localhost` and `[::1]` alone, for the tests) |
| `EXTRA_HOLIDAYS` | no | Comma-separated `YYYY-MM-DD` dates treated like a weekend (all courts allowed) |
| `DB_PATH` | no | SQLite file, default `data/bot.sqlite` (the folder is created) |
| `LOG_LEVEL` | no | `fatal` ... `trace`, `silent`; default `info` (JSON lines on stdout) |
| `TELEGRAM_API_ROOT` | no, **tests only** | Bot API root of a fake Telegram, e.g. `http://127.0.0.1:8081`. The bot token is sent there, so only an `http` URL whose host is exactly `127.0.0.1`, `localhost` or `[::1]` is accepted; anything else is a configuration error naming this key. Leave it unset |

A configuration error names the failing keys only, never their values.

## Development

```bash
npm install
npm test          # vitest, no network (includes the smoke test below, about 20 s)
npm run typecheck # tsc --noEmit
npm run build     # tsc -p tsconfig.build.json -> dist/src
npm run test:smoke # only the black-box smoke test
```

The smoke test (`tests/smoke`) builds the bot, then starts the built `dist/src/index.js` as a real child process
(`node --env-file=...`, like `npm start`) against two fake servers on `127.0.0.1` with ephemeral ports: a ReservaPlay
club site and a Telegram Bot API (reached through the tests-only `TELEGRAM_API_ROOT`). It drives `/start` and `/new`
with the bot's own buttons, checks that exactly one `add_event` with the expected body is sent for an already open
date, that the job ends `booked` in a temporary SQLite file and the owner is told, that a stranger gets no reply, that
no secret reaches the log, that shutdown is orderly (exit code 0) and that configuration errors name keys only. It uses
only synthetic credentials generated per run, never reads your `.env`, and a connection guard fails it if the bot
ever connects anywhere but the two fakes.

## Layout

```
src/config/       strict GameDate, court table + guard, holidays, time zone, environment (zod)
src/reservaplay/  HTTP client (cookie session), parsers, booking body builder, response / form classifiers
src/jobs/         SQLite job store (node:sqlite), job service, state machine
src/sniper/       window arithmetic, server-corrected clock, preflight, firing loop, runner, restart recovery
src/telegram/     grammY bot (allowlist, /new flow, commands), result notifier
src/runtime/      logger with redaction, owner-facing session handling, shutdown, database path
src/app.ts        wiring: store -> recovery -> sniper -> Telegram; orderly shutdown
src/main.ts       loads the environment and runs the app; src/index.ts is the entry point
src/cli.ts        owner CLI entry point; commands in src/cli/
tests/            unit tests + tests/app (wiring, CLI, end-to-end simulation) + tests/smoke (built bot, real sockets)
CONTRACT.md       what the bot promises (rules, invariants) and relies on
```

## Not done yet

- The answers of the site for a slot that was just taken, for an empty wallet and for other refusals are not known, so
  such an answer stops the job with an alert.
- A wake timer, Windows autostart, a watch mode for freed slots, a card-payment fallback (off by design).

## Disclaimer

Automating bookings may be against a venue's terms of use. This project is meant for one person's own account,
one session and a modest request rate; it does not try to bypass the booking window or any protection.
Use at your own risk.
