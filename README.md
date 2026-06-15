# Palmer Gill

Personal project site plus shared API backend.

## Active Site Paths

- `/` - project index
- `/about/` - professional background and selected project context
- `/docs/` - website documentation
- `/login/` - protected workspace sign-in
- `/stock-research/` - polished stock research app
- `/bitcoin-chat/` - Bitcoin chat app
- `/casino/` - landing page linking the casino games
- `/poker/` - Texas Hold'em poker app
- `/craps/` - craps app
- `/blackjack/` - blackjack app
- `/mockups/` - interactive frontend design studies
- `/blackjack-mockups/` - blackjack card-first layout concepts
- `/admin/` - protected backend log dashboard

## Active Backend Paths

- `/api/stocks/*` - stock research API
- `/api/poker/*` - poker API
- `/api/bitcoin/*` - Bitcoin chat API
- `/api/analytics/*` - public client analytics ingest (`POST /api/analytics/events`)
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

The local server runs FastAPI and, with `LOCAL_SITE_ROOT=true`, also serves the static root page plus `assets/`, `shared/`, `about/`, `login/`, `stock-research/`, `bitcoin-chat/`, `casino/`, `poker/`, `craps/`, `blackjack/`, and `admin/`. The local `/docs` path is reserved for FastAPI API docs; the static website docs page is served by production static hosting at `/docs/`.

Protected local app routes, FastAPI docs/OpenAPI JSON, and protected API routes require Basic Auth. Stock and Bitcoin app/API routes run in demo mode without credentials and use live providers with valid credentials. Set:

```bash
APP_AUTH_USERNAME=palmer APP_AUTH_PASSWORD=your-password ./start.sh
```

Logs are written to:

```text
logs/backend.log
```

## Deployment Model

- Static site: hosted from the repo root and project folders.
- API service: Railway/FastAPI from `backend/`.
- Vercel rewrites `/api/*` to the Railway backend in production.
- The root page `/`, `/docs/`, `/login/`, `/stock-research/`, `/bitcoin-chat/`, `/casino/`, `/poker/`, `/craps/`, `/blackjack/`, `/api/poker/*`, `/api/stocks/*`, `/api/bitcoin/*`, and `/api/analytics/*` stay public. Unauthenticated stock and Bitcoin API requests return demo data only; valid Basic Auth credentials unlock the live provider-backed paths. Admin and other `/api/*` routes require authentication; the login page creates a signed HttpOnly session cookie, failed sign-ins are rate-limited, and Basic Auth remains supported. Protected routes return `503` if `APP_AUTH_PASSWORD` is missing. Set the same `APP_AUTH_USERNAME` and `APP_AUTH_PASSWORD` values in Vercel and Railway.
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
casino/           Casino landing page linking poker, craps, and blackjack
poker/            Active poker frontend and supporting docs/tests
craps/            Active craps frontend
blackjack/        Active blackjack frontend and tests
```

## Notes

Bitcoin Chat production node, Cloudflare Tunnel, and Railway setup are documented in [docs/BITCOIN_CHAT_SETUP.md](docs/BITCOIN_CHAT_SETUP.md).

The production Railway Dockerfile copies and runs `backend/`. Poker uses the shared backend router under `backend/app/routers/poker.py`.
