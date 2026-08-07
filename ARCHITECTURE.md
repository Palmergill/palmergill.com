# Architecture

## Overview

```text
Browser
  |
  | static HTML/CSS/JS
  v
Static host / local FastAPI static mode
  |
  | /api/*
  v
FastAPI backend
  |
  +-- stock data clients and SQLite/Postgres cache
  +-- poker game APIs
  +-- craps strategy translation API
  +-- Bitcoin chat APIs
  +-- admin/log APIs
```

## Frontend Entry Points

The active public site is static:

- `/` - portfolio/project launcher from `index.html`
- `/about/` - professional background and selected project context
- `/docs/` - website documentation from `docs/index.html`
- `/login/` - protected workspace sign-in
- `/stock-research/` - stock research app
- `/bitcoin-chat/` - Bitcoin chat app
- `/fantasy/` - fantasy football dashboard
- `/fantasy/draft-order/` - Fourth & Fortune draft-order rooms
- `/casino/` - casino landing page linking the browser table games
- `/poker/` - poker app
- `/craps/` - craps app
- `/craps-strategy/` - craps strategy simulator
- `/blackjack/` - blackjack app
- `/high-card-flush/` - single-player High Card Flush app
- `/admin/` - protected backend log dashboard

Shared site chrome defaults to the warm light palette defined in
`shared/site-nav.css`. Casino pages opt into `body.theme-casino` so their
felt-table surfaces and navigation chrome keep the dark casino treatment.

## Backend

The backend is a FastAPI service in `backend/app`.

Important routes:

- `/api/stocks/*`
- `/api/poker/*` (includes the `GET /api/poker/games/{game_id}/ws` WebSocket push channel)
- `/api/craps/*`
- `/api/bitcoin/*`
- `/api/fantasy/*` (public fantasy reads plus account-gated persistent draft rooms)
- `/api/analytics/*` (public client analytics ingest)
- `/api/admin/*`
- `/health`
- `/docs` - protected FastAPI docs when accessing the backend service directly

In production, `/` returns API metadata from the Railway API service. In local development, `./start.sh` sets `LOCAL_SITE_ROOT=true`, which makes FastAPI serve the root portfolio page and active static project folders from the same process. The local `/docs` path remains FastAPI's generated API documentation path, so the static website docs page is a production/static-host route.

The active deployed API is `backend/app/main.py`. Poker routes are part of this shared backend.

## Local Development

```bash
./start.sh
```

Open:

```text
http://127.0.0.1:8000
```

Logs:

```text
logs/backend.log
```

## Deployment

- Static site hosting serves the root static files and project directories.
- Vercel rewrites `/api/*`, `/login/session`, `/login/signup`, and `/login/logout` to the Railway API.
- Railway runs the Dockerized FastAPI backend from `backend/`.
- `/`, `/docs/`, `/login/`, `/signup/`, `/casino/`, `/poker/`, `/craps/`, `/craps-strategy/`, `/blackjack/`, `/high-card-flush/`, `/api/poker/*`, `/api/craps/*`, `/stock-research/`, `/bitcoin-chat/`, `/api/stocks/*`, `/api/bitcoin/*`, and `/api/analytics/*` are public. Stock and Bitcoin routes serve demo data when unauthenticated; any signed-in account unlocks live provider-backed data. Admin, FastAPI docs/OpenAPI JSON, and other API routes require authentication. Protected backend routes return `503` when `APP_AUTH_PASSWORD` is missing.

## Accounts

Two roles, stored in different places on purpose:

- **admin** — the `APP_AUTH_USERNAME` / `APP_AUTH_PASSWORD` env pair. No database row, so nothing that can write to `app_users` can grant itself the logs.
- **member** — a row in `app_users`, created at `/signup/` with the invite code in `APP_SIGNUP_INVITE_CODE` or the join code for an open fantasy draft room. Passwords are hashed with stdlib scrypt (`backend/app/accounts.py`). Members get the live tools; `/admin/*`, `/api/admin/*`, `/api/fantasy/admin/*`, and the FastAPI docs return `403`.

Fourth & Fortune persists rooms, players, rounds, and every dealt card in the
`ff_draft_*` tables. The API owns turn authorization and derives a separate
per-account deck from a committed master seed; the seed is disclosed only when
the last score is locked. Each player takes `ROUNDS_PER_PLAYER` (5) rounds from
their own deck, consumed continuously. Round one follows the seed-derived player
order; every later round is frozen from the standings after the preceding round,
with the scoring leader first. Five rounds can consume up to 65 cards from a
52-card deck, so a round with no deck left to deal from is recorded as
`exhausted` and scores zero rather than stranding the room on a manager who can
neither flip nor bank. A room has an explicit mode: `league` rooms accept
account-backed invites, `practice` rooms are private solo warm-ups, and
admin-only `test` rooms contain marked bot players that advance one round at a
time through the same scoring and verification path as a real draft.

A turn that ends is not handed straight to the next manager. The room enters
`turn_state = 'resolved'`, keeps the finished hand and the acting player on the
table, and publishes the action in `last_event_json`; the turn advances on the
first read or action that arrives more than `TURN_HOLD_SECONDS` later. Without
that hold the card that busted or banked a round was already gone by the time a
spectator's poll landed. There is no scheduler, so reads are what drive the
clock — a held room is never stuck for longer than it takes someone to look at
it. `lastEvent` carries the same final-round concealment as the cards it
describes. `turn_started_at` records when the current manager went on the clock:
the host's forfeit is the one lever a person controls rather than the seed, so it
stays out of reach until `FORFEIT_GRACE_SECONDS` have passed.

Spectators receive every live card and pot value in rounds one through four.
During the final round the API returns only each opponent's card count, freezes
the public leaderboard at the standings after round four, and withholds the seed,
final scores, and draft order until the host records the synchronized reveal in
`revealed_at`. Because those standings are frozen, the decision strip reports
`standingsSealed` and omits the bank position and score to beat instead of
ranking a manager against totals that opponents have already played past.

The API service is the only thing that authenticates anyone — it owns the user table and mints the signed `pg_session` cookie, which carries a role claim. `middleware.js` at the Vercel edge only verifies that cookie and enforces the role gate; it deliberately no longer implements a second login. An admin role claim is honored only for the configured admin username, so a member token cannot be rewritten into an admin one even though both are signed with the same secret. Cookies issued before member accounts existed carry no role claim and are read as admin only when the username matches.
