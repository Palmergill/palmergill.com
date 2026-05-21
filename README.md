# Palmer Gill

Personal project site plus shared API backend.

## Active Site Paths

- `/` - project index
- `/about/` - professional background and selected project context
- `/docs/` - website documentation
- `/stock-research/` - polished stock research app
- `/poker/` - Texas Hold'em poker app
- `/craps/` - craps app
- `/blackjack/` - blackjack app
- `/bitcoin-chat/` - Bitcoin chat app
- `/admin/` - protected backend log dashboard

## Active Backend Paths

- `/api/stocks/*` - stock research API
- `/api/poker/*` - poker API
- `/api/bitcoin/*` - Bitcoin chat API
- `/api/admin/*` - protected admin/log APIs
- `/health` - backend health check
- `/docs` - protected FastAPI docs when accessing the backend service directly

## Local Development

```bash
./start.sh
```

Open:

```text
http://127.0.0.1:8000
```

The local server runs FastAPI and, with `LOCAL_SITE_ROOT=true`, also serves the static root page plus `assets/`, `shared/`, `about/`, `stock-research/`, `poker/`, `craps/`, `blackjack/`, `bitcoin-chat/`, and `admin/`. The local `/docs` path is reserved for FastAPI API docs; the static website docs page is served by production static hosting at `/docs/`.

Protected local app routes, FastAPI docs/OpenAPI JSON, and API routes require Basic Auth. Set:

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
- The root page `/`, `/docs/`, `/poker/`, `/craps/`, `/blackjack/`, and `/api/poker/*` stay public. Stock research, Bitcoin chat, admin, and other `/api/*` routes require Basic Auth; protected routes return `503` if `APP_AUTH_PASSWORD` is missing. Set the same `APP_AUTH_USERNAME` and `APP_AUTH_PASSWORD` values in Vercel and Railway.

## Repository Layout

```text
backend/          FastAPI API service
admin/            Protected admin/log dashboard
shared/           Shared static navigation assets
about/            About page
docs/             Website docs and provider/setup markdown docs
stock-research/   Active stock research frontend
poker/            Active poker frontend and supporting docs/tests
craps/            Active craps frontend
blackjack/        Active blackjack frontend and tests
bitcoin-chat/     Active Bitcoin chat frontend
archive/          Legacy frontends, demos, and planning artifacts
```

## Notes

The original site started as only the stock research app. Legacy versions of that UI have been moved into `archive/` so active entrypoints are easier to identify.

Bitcoin Chat production node, Cloudflare Tunnel, and Railway setup are documented in [docs/BITCOIN_CHAT_SETUP.md](docs/BITCOIN_CHAT_SETUP.md).

The production Railway Dockerfile copies and runs `backend/`. The richer standalone poker backend under `poker/backend/` is retained for reference/development and is not part of the root Railway deployment unless the deployment configuration is changed.
