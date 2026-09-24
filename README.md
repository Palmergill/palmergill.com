# Palmer Gill

Personal project site plus shared API backend.

The public site uses a single warm light theme by default. Casino games keep
their dark felt play surfaces and use a documented casino override for shared
navigation chrome.

## Active Site Paths

- `/` - project index
- `/about/` - professional background and selected project context
- `/docs/` - website documentation
- `/login/` - protected workspace sign-in
- `/stock-research/` - polished stock research app
- `/bitcoin-chat/` - Bitcoin chat app
- `/fantasy/` - ESPN league hub and the section's home: standings, power rankings, enriched rosters, start/sit advice, league free agents, team overviews, and league-aware chat. Members only, with a teaser for everyone else
- `/fantasy/week/` - weekly league recap (members only)
- `/fantasy/draft-recap/` - draft recap for the league (members only)
- `/fantasy/market/` - implied player value from betting markets, against the projections. Public and league-agnostic
- `/fantasy/draft-order/` - account-backed, verifiable draft-order game with solo practice, games against bots, personal records, a top-10 all-runs leaderboard, and admin bot-test rooms
- `/fantasy/rankings/` - personal ranking boards with tiers, a head-to-head "who would you draft first?" helper, publishable share links, and a site consensus built from published boards
- `/casino/` - landing page linking the casino games
- `/poker/` - Texas Hold'em poker app
- `/craps/` - craps app
- `/craps-strategy/` - craps strategy simulator
- `/blackjack/` - blackjack app
- `/high-card-flush/` - single-player High Card Flush table
- `/admin/` - protected backend log dashboard

## Active Backend Paths

- `/api/stocks/*` - stock research API
- `/api/poker/*` - poker API
- `/api/bitcoin/*` - Bitcoin chat API
- `/api/analytics/*` - public client analytics ingest (`POST /api/analytics/events`)
- `/api/craps/*` - public craps strategy translation API
- `/api/fantasy/*` - fantasy data and account-gated draft rooms
- `/api/fantasy/league/*` - members-only ESPN league reads (403 for anonymous callers)
- `/api/fantasy/rankings/*` - personal ranking boards; `/boards` routes are account-owned, shared/consensus reads are public
- `/api/admin/*` - protected admin/log APIs
- `/health` - backend health check
- `/docs` - protected FastAPI docs when accessing the backend service directly

## Local Development

Requires Python 3.10 or newer. `./start.sh` creates `backend/venv` when it is missing and installs backend dependencies before starting FastAPI.

```bash
./start.sh
```

Open:

```text
http://127.0.0.1:8000
```

The local server runs FastAPI and, with `LOCAL_SITE_ROOT=true`, also serves the static root page plus `assets/`, `shared/`, `about/`, `login/`, `signup/`, `stock-research/`, `bitcoin-chat/`, `fantasy/`, `casino/`, `poker/`, `craps/`, `craps-strategy/`, `blackjack/`, `high-card-flush/`, and `admin/`. The local `/docs` path is reserved for FastAPI API docs; the static website docs page is served by production static hosting at `/docs/`.

Protected local app routes, FastAPI docs/OpenAPI JSON, and protected API routes require Basic Auth. Stock and Bitcoin app/API routes run in demo mode without credentials and use live providers with valid credentials. Set:

```bash
APP_AUTH_USERNAME=palmer APP_AUTH_PASSWORD=your-password ./start.sh
```

Member sign-ups are open whenever app authentication is configured. The API
allows at most five successfully created accounts per UTC day.

Logs are written to:

```text
logs/backend.log
```

## Testing

Testing is end-to-end: Playwright boots the FastAPI backend with
`LOCAL_SITE_ROOT=true` against a throwaway SQLite file and drives the real
pages in Chromium (specs live in `e2e/`). Each test fails on any page
script error or console error.

```bash
npm install
npx playwright install chromium
npm test            # expects backend/venv; set E2E_PYTHON to use another interpreter
```

The only unit tests left are backend security invariants that a browser
cannot observe (token signing, proxy-hop parsing, CSV injection, log
redaction):

```bash
cd backend && venv/bin/pytest
```

Both run on every push/PR via `.github/workflows/ci-cd.yml`.

## Deployment Model

- Static site: hosted from the repo root and project folders.
- API service: Railway/FastAPI from `backend/`.
- Vercel rewrites `/api/*`, `/login/session`, `/login/signup`, and `/login/logout` to the Railway backend in production.
- The root page `/`, `/docs/`, `/login/`, `/signup/`, `/stock-research/`, `/bitcoin-chat/`, `/casino/`, `/poker/`, `/craps/`, `/craps-strategy/`, `/blackjack/`, `/high-card-flush/`, `/api/poker/*`, `/api/craps/*`, `/api/stocks/*`, `/api/bitcoin/*`, and `/api/analytics/*` stay public. Unauthenticated stock and Bitcoin API requests return demo data only; any signed-in account unlocks the live provider-backed paths. Admin and other `/api/*` routes require authentication; sign-in creates a signed HttpOnly session cookie carrying a role, failed sign-ins are rate-limited, and Basic Auth remains supported for the admin. Protected routes return `503` if `APP_AUTH_PASSWORD` is missing. Set the same `APP_AUTH_USERNAME` and `APP_AUTH_PASSWORD` values in Vercel and Railway.
- Two roles: the **admin** (env vars, full access) and **members** (rows in `app_users`, created through the open `/signup/` flow, capped at five successful registrations per UTC day). Members get the live tools but are refused `/admin/*`, `/api/admin/*`, `/api/fantasy/admin/*`, and the API docs. See `ARCHITECTURE.md` for how the roles are kept apart.
- Poker games are cached in process and snapshotted to the backend database so a fresh backend process can recover active games until inactive cleanup removes them.

## Repository Layout

```text
backend/          FastAPI API service
admin/            Protected admin/log dashboard
shared/           Shared static navigation assets
login/            Public sign-in page for protected admin tools
about/            About page
docs/             Website docs and provider/setup markdown docs
stock-research/   Active stock research frontend
bitcoin-chat/     Active Bitcoin chat frontend
fantasy/          Fantasy dashboard, Fourth & Fortune draft-order game, and the ESPN league hub
casino/           Casino landing page and game rules
poker/            Active poker frontend and supporting docs/tests
craps/            Active craps frontend
craps-strategy/   Active craps strategy simulator
blackjack/        Active blackjack frontend and tests
high-card-flush/  High Card Flush frontend, PWA shell, and tests
```

## Notes

Bitcoin Dashboard production node, Cloudflare Tunnel, and Railway setup are documented in [docs/BITCOIN_CHAT_SETUP.md](docs/BITCOIN_CHAT_SETUP.md).

The production Railway Dockerfile copies and runs `backend/`. Poker uses the shared backend router under `backend/app/routers/poker.py`.
