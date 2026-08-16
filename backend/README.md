# Backend

FastAPI service for the Palmer Gill project site.

## Setup

```bash
python3.11 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Python 3.10 or newer is required by the pinned FastAPI dependency. From the repo root, `./start.sh` will create `backend/venv` automatically when it is missing.

## Run API Only

```bash
uvicorn app.main:app --reload
```

This mode exposes API endpoints and returns service metadata at `/`.

## Run Local Site + API

From the repo root:

```bash
./start.sh
```

That sets `LOCAL_SITE_ROOT=true`, which serves the root portfolio page, shared assets, and configured project folders from the same FastAPI process. The local `/docs` path remains the generated FastAPI API docs path, not the static website docs page.

Protected local app routes, FastAPI docs/OpenAPI JSON, and protected API routes require Basic Auth. Stock and Bitcoin app/API routes run in demo mode without credentials and use live provider-backed data with valid credentials. Run:

```bash
APP_AUTH_USERNAME=palmer APP_AUTH_PASSWORD=your-password ./start.sh
```

Poker, craps, craps strategy, blackjack, High Card Flush, login, `/api/poker/*`, `/api/craps/*`, and `/api/analytics/*` remain public. Stock research, Bitcoin chat, `/api/stocks/*`, and `/api/bitcoin/*` run in demo mode without credentials and use live provider-backed data with valid credentials. Admin, FastAPI docs, OpenAPI JSON, and other `/api/*` routes are protected. Protected routes return `503` if `APP_AUTH_PASSWORD` is missing.

## Useful URLs

- `http://127.0.0.1:8000/` - local site root when `LOCAL_SITE_ROOT=true`
- `http://127.0.0.1:8000/about/` - about page
- `http://127.0.0.1:8000/login/` - sign-in page for protected admin tools
- `http://127.0.0.1:8000/stock-research/` - stock app
- `http://127.0.0.1:8000/casino/` - casino game launcher
- `http://127.0.0.1:8000/poker/` - poker app
- `http://127.0.0.1:8000/craps/` - craps app
- `http://127.0.0.1:8000/craps-strategy/` - craps strategy simulator
- `http://127.0.0.1:8000/blackjack/` - blackjack app
- `http://127.0.0.1:8000/high-card-flush/` - High Card Flush app
- `http://127.0.0.1:8000/bitcoin-chat/` - Bitcoin chat app
- `http://127.0.0.1:8000/admin/` - protected admin/log dashboard
- `http://127.0.0.1:8000/health` - health check
- `http://127.0.0.1:8000/docs` - protected FastAPI docs

## Routers

- `/api/stocks/*` - stock lookup, summary, earnings, and price history.
- `/api/poker/*` - active integrated poker game API plus the `GET /api/poker/games/{game_id}/ws` WebSocket push channel.
- `/api/craps/*` - public craps strategy translation API.
- `/api/bitcoin/*` - Bitcoin provider status, block/transaction/mempool lookups, and chat.
- `/api/analytics/*` - public client analytics ingest (`POST /api/analytics/events`).
- `/api/admin/*` - protected structured log and file-tail endpoints, including the analytics summary surfaced in the admin dashboard and `GET /api/admin/users`, the member account roster behind the console's Members tab.

The fantasy dashboard's regular-season player over/unders come from Kalshi,
because The Odds API's NFL player props are game-scoped and the sportsbook
feeds carrying season futures are priced for trading desks. Kalshi's market
data is public, so the collector needs no key and no configuration.

Kalshi lists threshold contracts ("3500+ passing yards") rather than lines, so
the parser reads each contract's strike as the over/under point and its YES
price as the Over. It is an overlay on the projection consensus, not a
replacement: roughly 110 players clear its quote filter versus a few thousand
in the Sleeper/FantasyPros/ESPN projections, and thinly quoted contracts are
dropped rather than shown. Optional overrides:

```text
KALSHI_MAX_SPREAD=0.20   # widest YES bid/ask still treated as a real quote
KALSHI_API_URL=https://api.elections.kalshi.com/trade-api/v2
KALSHI_TIMEOUT_SECONDS=20
```

Raising `KALSHI_MAX_SPREAD` much past 0.30 admits one-sided books whose
midpoint is an artifact of the empty order book rather than a market view.

The root deployment runs this shared backend. Poker is served by `app/routers/poker.py` plus the shared game and AI modules.
