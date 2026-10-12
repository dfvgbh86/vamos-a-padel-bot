# vamos-a-padel-bot

A personal Telegram bot that books a padel court at [Enjoy Valencia](https://enjoyvalenciaclubesoutdoor.reservaplay.com)
(ReservaPlay platform) the moment the booking window opens, using the owner's own account.

> **Status: work in progress.** The pure domain logic (court rules, booking window, request body builder,
> response classifiers) is implemented and unit-tested. The HTTP client, the sniper/scheduler, the job store
> and the Telegram bot are next. See [PLAN.md](PLAN.md) (in Russian) for the verified protocol notes,
> design invariants and roadmap.

## Rules baked into the code

- A game day `D` opens for booking at **`D-7` 07:00 Europe/Madrid**.
- On weekdays the academy courts (resource ids `1, 2, 3, 7, 8`, i.e. Pista 1-3 and 5-6) are **never** booked;
  on weekends and configured holidays all ten courts are allowed. The guard lives inside the booking-body
  builder, on the exact values that are serialised.
- One booking per day, 90 minutes by default, host + 3 guests, paid from the club's virtual wallet.
- A POST is only allowed after the server itself rendered an open booking form; unknown responses are never
  retried blindly; at most one booking request is in flight.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```

Requires Node 22+. Copy `.env.example` to `.env` and fill in your own values - `.env` is git-ignored and
secrets must never be committed or pasted into chats or issues.

## Layout

```
src/config/       strict GameDate type, court table + guard, holidays, time zone
src/sniper/       booking-window arithmetic (DST-safe)
src/reservaplay/  booking request body builder, response / form classifiers
tests/            unit tests (no network)
PLAN.md           protocol notes, invariants, roadmap (Russian)
```

## Disclaimer

Automating bookings may be against a venue's terms of use. This project is meant for one person's own account,
one session and a modest request rate; it does not try to bypass the booking window or any protection.
Use at your own risk.
