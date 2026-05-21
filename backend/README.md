# Backend

FastAPI service for the Palmer Gill project site.

## Setup

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

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

Protected local app routes and API routes require Basic Auth. Run:

```bash
APP_AUTH_USERNAME=palmer APP_AUTH_PASSWORD=your-password ./start.sh
```

Poker, craps, and `/api/poker/*` remain public. Stock research, Bitcoin chat, admin, FastAPI docs, OpenAPI JSON, and other `/api/*` routes are protected. Protected routes return `503` if `APP_AUTH_PASSWORD` is missing.

## Useful URLs

- `http://127.0.0.1:8000/` - local site root when `LOCAL_SITE_ROOT=true`
- `http://127.0.0.1:8000/about/` - about page
- `http://127.0.0.1:8000/stock-research/` - stock app
- `http://127.0.0.1:8000/poker/` - poker app
- `http://127.0.0.1:8000/craps/` - craps app
- `http://127.0.0.1:8000/blackjack/` - blackjack app
- `http://127.0.0.1:8000/bitcoin-chat/` - Bitcoin chat app
- `http://127.0.0.1:8000/admin/` - protected admin/log dashboard
- `http://127.0.0.1:8000/health` - health check
- `http://127.0.0.1:8000/docs` - protected FastAPI docs

## Routers

- `/api/stocks/*` - stock lookup, summary, earnings, and price history.
- `/api/poker/*` - active integrated poker game API.
- `/api/bitcoin/*` - Bitcoin provider status, block/transaction/mempool lookups, and chat.
- `/api/admin/*` - protected structured log and file-tail endpoints.

The root deployment runs this shared backend. `poker/backend/` is a separate standalone poker service and is not imported here.
