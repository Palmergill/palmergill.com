# Deployment

The site is split into static project pages and a shared API backend.

## Static Site

The active static site lives at the repo root:

- `index.html`
- `about/`
- `docs/`
- `login/`
- `stock-research/`
- `casino/`
- `poker/`
- `craps/`
- `craps-strategy/`
- `blackjack/`
- `bitcoin-chat/`
- `admin/`

Production static hosting should serve those files directly. `vercel.json` rewrites `/api/*` requests to the Railway backend.

Vercel middleware keeps `/` public and requires Basic Auth for:

- `/admin/*`
- `/api/*`, except `/api/poker/*`, `/api/craps/*`, `/api/stocks/*`, `/api/bitcoin/*`, and `/api/analytics/*`

`/docs/*`, `/login/*`, `/stock-research/*`, `/bitcoin-chat/*`, `/poker/*`, `/craps/*`, `/craps-strategy/*`, `/blackjack/*`, `/api/poker/*`, `/api/craps/*`, `/api/stocks/*`, `/api/bitcoin/*`, and `/api/analytics/*` are public. Unauthenticated stock and Bitcoin API requests run in demo mode; valid app credentials unlock the live provider-backed paths. The login page posts to `/login/session`, which sets a signed HttpOnly session cookie for `/admin/*` and protected API requests. Basic Auth remains supported for direct scripted access.

Configure these environment variables in Vercel:

```text
APP_AUTH_USERNAME=palmer
APP_AUTH_PASSWORD=<secret password>
```

If `APP_AUTH_PASSWORD` is missing in Vercel, protected routes return `503` so the apps do not accidentally publish without auth.

## API Backend

Railway builds from the root `Dockerfile`, which installs `backend/requirements.txt` and runs:

```bash
uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
```

Health check:

```text
/health
```

The backend mirrors the same auth model for protected API docs, `/api/*` routes, and locally served app folders. Poker, craps, craps-strategy, blackjack, login, `/api/poker/*`, `/api/craps/*`, and `/api/analytics/*` remain public in the backend. Stock research, Bitcoin chat, `/api/stocks/*`, and `/api/bitcoin/*` allow unauthenticated demo-mode responses and use live providers only after valid app credentials are supplied. Admin, FastAPI docs/OpenAPI JSON, and other `/api/*` routes are protected. Protected routes return `503` if `APP_AUTH_PASSWORD` is missing, so set the same `APP_AUTH_USERNAME` and `APP_AUTH_PASSWORD` values in Railway to keep direct backend access usable and protected.

The root Railway deployment uses the root `Dockerfile`, which copies only `backend/`.

Stock Research uses Polygon in production. Configure:

```text
USE_REAL_DATA=true
POLYGON_API_KEY=<secret Polygon key>
```

`USE_REAL_DATA` defaults to `true` in the app and Docker image; set it to `false` only for local development with synthetic stock data.

Bitcoin Chat uses mempool.space as the default live provider. Configure:

```text
BITCOIN_DATA_PROVIDER=mempool
BITCOIN_MEMPOOL_API_URL=https://mempool.space/api
BITCOIN_MEMPOOL_TIMEOUT_SECONDS=10
OPENAI_API_KEY=<OpenAI API key for natural-language chat>
```

Set `BITCOIN_DATA_PROVIDER=rpc` plus `BITCOIN_RPC_URL`, `BITCOIN_RPC_USER`, and `BITCOIN_RPC_PASSWORD` only when routing live Bitcoin reads through the private Bitcoin Core node.

## Local

Use:

```bash
./start.sh
```

This runs the API and active static pages together at:

```text
http://127.0.0.1:8000
```

`LOCAL_SITE_ROOT=true` currently mounts `assets/`, `shared/`, `about/`, `login/`, `stock-research/`, `poker/`, `craps/`, `blackjack/`, `bitcoin-chat/`, `casino/`, and `admin/` through FastAPI. The local `/docs` path is still FastAPI's generated API docs path; the static website docs page is served by production/static hosting at `/docs/`.
