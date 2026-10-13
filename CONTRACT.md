# Contract

What this bot promises, and what it relies on. Code and tests refer to the numbered items (C1, C2, ...).

## Scope

One person, one club account, one booking per day. The bot books a padel court at Enjoy Valencia (ReservaPlay) for the
host plus three guest participants ("Invitado"), paid from the club wallet, the moment the booking window opens:
`D-7` at 07:00 Europe/Madrid. The owner drives it from a private Telegram chat.

## Booking rules

- **R1 Courts.** On weekdays the academy courts (resource ids 1, 2, 3, 7, 8) are never booked; on weekends and official
  Valencia holidays all ten courts are allowed. The guard lives in the booking-body builder, on the values that are sent.
- **R2 Duration.** 60 or 90 minutes (default 90); a start time is a button or a typed `HH:MM`.
- **R3 Payment.** The club wallet only. Card payment is off by default.

## Invariants

- **C1 The window is never bypassed.** A booking request is sent only after the server itself rendered an open booking
  form for that slot. The clock of the PC decides nothing.
- **C2 One booking request in flight** per account; never queued, never retried in parallel.
- **C3 An unclear outcome blocks sending again.** After a timeout, a reset, a 5xx or an answer nobody understands the
  calendar is checked for an own booking on that date first; if that cannot be read, nothing is sent again and the owner
  is told. An unknown answer stops the job instead of being retried blindly.
- **C4 Stop flag.** `/stop` is checked before every booking request and survives a restart; limits on attempts and time.
- **C5 Hash and tokens are never persisted.** The account `hash` and the page CSRF token are read fresh from a rendered
  page of the current session.
- **C6 Time.** Short timer chunks (at most one second); no long timers; a restart reconciles before it fires again.
- **C7 Money.** At most one active job per game date; the price comes from the site (the wallet option shown by the
  site is the authority on affordability); a shortage is reported when the job is created and again before the window.
  The bot never cancels a booking by itself.
- **C8 Card fallback is off** unless the owner switches it on.
- **C9 Session.** Login shortly before the window, keep-alive, at most one re-login and one repeat while firing;
  redirects are never followed automatically (a redirect to `/login` means the session expired).
- **C10 Telegram access.** Only the numeric user ids in `TELEGRAM_ALLOWED_USER_IDS`, private chats only, everybody else
  ignored without a reply; an empty list is a startup error. `callback_data` is never trusted: court, date and time are
  checked again when they leave the bot.
- **C11 Privacy.** Only whitelisted calendar fields are parsed (other people's data is dropped at parse time); raw
  responses and error pages are never logged or stored; secrets are redacted from logs; fixtures contain no personal data.
- **C12 Result before notification.** A booking is stored in the database before the Telegram message about it is sent.

## What the bot relies on (the club site)

- Login: `GET /login` for a CSRF token, `POST /login`; cookies `laravel_session`, `XSRF-TOKEN` and the load balancer's.
- Day calendar: `GET /api/tipo_recurso/1/reservas_usuario?day=YY-MM-DD+00:00:00` with `X-Requested-With: XMLHttpRequest`.
- Booking form: `GET /reserves/cal_event.php?...`; open only from 07:00:00 on `D-7`.
- Booking and cancel: `POST /sportssuite/manager.php` (urlencoded). **Every such POST must carry `X-CSRF-Token`**, the value of
  `<meta name="csrf_token">` of a logged-in page (the site's own scripts add it to every ajax call); without it the
  server answers HTTP 500 and nothing is booked.
- The answer to "slot already taken" and to "not enough money" has not been observed yet: such an answer is classified
  as unknown and stops the job with an alert (C3).

## Not promised

The PC must be on and awake at the opening time; a wake timer and autostart are not set up. Automating bookings may be
against the venue's terms of use: personal use, one session, a modest request rate.
