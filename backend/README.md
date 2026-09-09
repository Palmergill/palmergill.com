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

## Previewing the members-only league hub

`/fantasy/league/` is behind the member gate and reads only from the local
database, so previewing it needs three things: a member account, some league
data, and a server pointed at the database that holds both.

**None of the credentials below are real.** They exist only in the local
SQLite file and are safe to recreate or change at will. Do not reuse them
anywhere that matters.

### 1. A local member account

```bash
cd backend && ./venv/bin/python - <<'EOF'
from app.database import SessionLocal
from app import accounts

db = SessionLocal()
try:
    if accounts.get_user(db, "leaguetester") is None:
        accounts.create_user(db, "leaguetester", "hub-preview-2026-local")
        print("created")
    else:
        print("already exists")
finally:
    db.close()
EOF
```

| | |
|---|---|
| Username | `leaguetester` |
| Password | `hub-preview-2026-local` |
| Role | member (not admin — the hub only needs a member) |
| Scope | `backend/stock_data.db` on this machine only |

### 2. League data

ESPN is keyless for this league's public seasons, so the collector fills the
local database without any credential. Private seasons close their run as
`skipped`, which is the expected answer rather than a failure:

```bash
cd backend && ESPN_LEAGUE_ID=225965 ./venv/bin/python - <<'EOF'
from app.database import SessionLocal
from app.services import fantasy_league_collector as lc

db = SessionLocal()
try:
    for season in (2026, 2025, 2024):
        print(season, [(r.job, r.status) for r in lc.collect_season(db, season)])
finally:
    db.close()
EOF
```

If this fails with `no such table`, the local schema is behind. Run
`./venv/bin/python -c "from app.database_migration import init_db_with_migration; init_db_with_migration()"`
first.

### 3. The server, pointed at the right database

Two gotchas, both of which produce a page that looks broken rather than an
error that explains itself:

- `DATABASE_URL` defaults to `sqlite:///./stock_data.db`, **relative to the
  working directory**. Starting uvicorn from the repo root uses
  `./stock_data.db`, not `backend/stock_data.db`, so the account and league
  data collected above are simply not there and login returns 401.
- `/login/session` returns 503 unless `APP_AUTH_USERNAME` and
  `APP_AUTH_PASSWORD` are set. They sign the session token; a member still
  signs in with their own account password, not these.

```bash
LOCAL_SITE_ROOT=true \
ESPN_LEAGUE_ID=225965 \
APP_AUTH_USERNAME=palmer \
APP_AUTH_PASSWORD=local-dev-only-password \
DATABASE_URL="sqlite:///$(pwd)/backend/stock_data.db" \
backend/venv/bin/uvicorn app.main:app --app-dir backend --port 8000
```

Then sign in at `http://127.0.0.1:8000/login/` and open
`http://127.0.0.1:8000/fantasy/league/`.

### What you should expect to see

The hub lands on the newest readable season. **Before week 1 that season is
in preseason mode, which deliberately orders the teams grid above the
ledger** — every derived column is empty until games are played, and a
banner says so. To see the ledger with real numbers, pick a played season:
`http://127.0.0.1:8000/fantasy/league/?season=2024`.

Columns stay blank when the data behind them is genuinely missing rather
than zero, and the footnote under the table names the reason. Lineup
efficiency in particular needs stored weekly roster snapshots *and* player
actuals, so it stays empty on a season collected for the first time.

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
- `http://127.0.0.1:8000/fantasy/league/` - members-only league hub (see above)
- `http://127.0.0.1:8000/health` - health check
- `http://127.0.0.1:8000/docs` - protected FastAPI docs

## Routers

- `/api/stocks/*` - stock lookup, summary, earnings, and price history.
- `/api/poker/*` - active integrated poker game API plus the `GET /api/poker/games/{game_id}/ws` WebSocket push channel.
- `/api/craps/*` - public craps strategy translation API.
- `/api/bitcoin/*` - Bitcoin provider status, block/transaction/mempool lookups, and chat.
- `/api/analytics/*` - public client analytics ingest (`POST /api/analytics/events`).
- `/api/admin/*` - protected structured log and file-tail endpoints, including the analytics summary surfaced in the admin dashboard and `GET /api/admin/users`, the member account roster behind the console's Members tab.

The fantasy dashboard's regular-season player over/unders come from three
public, keyless market sources, because The Odds API's NFL player props are
game-scoped and the sportsbook feeds carrying season futures are priced for
trading desks:

| Source | Shape | Aug 2026 coverage |
| --- | --- | --- |
| **Kalshi** | Exchange. Threshold contracts ("3500+ passing yards") forming a per-player ladder | 135 players, but 12 passing-TD lines and no price movement in eleven days |
| **Underdog** | Posted balanced lines, one per player and category, at -112/-112 | 141 players, 27 passing-TD lines |
| **Polymarket** | Exchange, same ladder shape as Kalshi | 128 players, 25 passing-TD lines, quotes minutes old |

Kalshi alone put ten quarterbacks on the implied fantasy points board and
none of Lamar Jackson, Jalen Hurts, Jayden Daniels or Justin Herbert, because
it quoted their passing yards but no usable passing-TD contract. Together the
three reach 30 quarterbacks and 132 players overall.

For the exchanges the parser reads each contract's strike as the over/under
point and its YES price as the Over; a tight two-sided midpoint is preferred,
and when the book is one-sided a last trade is used only if it has real volume
and remains inside the live book. Underdog posts a single line whose two
prices are de-vigged into one fair probability. Every provider therefore
stores Over and Under as complements of the same number, so a price means the
same thing whichever source it came from. Ladders whose prices contradict
themselves — P(2000+) below P(3000+) — are dropped whole.

This remains an overlay on the projection consensus, not a replacement:
roughly 170 players clear the quote filters versus a few thousand in the
Sleeper/FantasyPros/ESPN projections.

Providers are fetched independently. One failing records a `partial` run
naming it and costs only the coverage it had; only losing all of them is an
`error`. Within Kalshi the six series are likewise independent, so a single
flaky category no longer aborts the fetch. The endpoints are public but
undocumented, and PrizePicks — the obvious fourth source — already sits behind
a bot check, so losing one should be survivable by design.

Where providers overlap, a player's implied value is the **median** of their
individual 50% crossings, and the headline price is the median of their
probabilities rather than the friendliest of them: after de-vigging these are
estimates of one number, not competing offers. Curve slopes used to
extrapolate a sparse ladder are kept per provider, since Underdog has no
ladder and the two exchanges space their strikes differently.

`GET /api/fantasy/season-props` ranks everyone quoted in one category — the
entry point, since a bare name lookup only helps once you already know who has
a market — and reports how many providers back each row.
`GET /api/fantasy/season-offenses` builds one top-10 team board — yardage,
touchdowns and the fantasy points they imply on a single row — from
non-overlapping air and rushing markets, summing each player's implied value
(not a ladder rung, which would rank teams on which provider quoted them). A
team needs both halves quoted to be ranked, and its points are scored against
the markets they came from, so a receiving fallback is worth a receiver's
0.1/yard rather than a passer's 0.04. `GET /api/fantasy/season-fantasy-points` converts every
available implied yardage and touchdown value into a fantasy points board
using complete stat pairs; stats without a matching yardage and touchdown
market are not estimated. Its `scoring` option supports standard, half-PPR and
PPR; reception bonuses come from the latest season-long projection because no
market quotes season receptions.

Every response carries a `sources` array giving each provider's own
`quoted_at` — the last time *it* moved a price. That is deliberately separate
from `as_of`, the collection time: an hour-old run said nothing about a Kalshi
board that had not ticked since August 12, and the UI now shows both.

Optional overrides:

```text
KALSHI_MAX_SPREAD=0.20        # widest YES bid/ask still treated as a real quote
KALSHI_API_URL=https://api.elections.kalshi.com/trade-api/v2
KALSHI_TIMEOUT_SECONDS=20
UNDERDOG_ENABLED=true         # false switches the provider off without a deploy
UNDERDOG_API_URL=https://api.underdogfantasy.com/beta/v6/over_under_lines
UNDERDOG_TIMEOUT_SECONDS=45   # one response carries every sport, tens of MB
POLYMARKET_ENABLED=true
POLYMARKET_MAX_SPREAD=0.20
POLYMARKET_API_URL=https://gamma-api.polymarket.com
POLYMARKET_TIMEOUT_SECONDS=45
```

Raising either `MAX_SPREAD` much past `0.30` admits one-sided books whose
midpoint is an artifact of the empty order book rather than a market view.

The root deployment runs this shared backend. Poker is served by `app/routers/poker.py` plus the shared game and AI modules.
