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
- `/casino/` - casino landing page linking poker, craps, and blackjack
- `/poker/` - poker app
- `/craps/` - craps app
- `/blackjack/` - blackjack app
- `/admin/` - protected backend log dashboard

## Backend

The backend is a FastAPI service in `backend/app`.

Important routes:

- `/api/stocks/*`
- `/api/poker/*` (includes the `GET /api/poker/games/{game_id}/ws` WebSocket push channel)
- `/api/craps/*`
- `/api/bitcoin/*`
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
- Vercel rewrites `/api/*` to the Railway API.
- Railway runs the Dockerized FastAPI backend from `backend/`.
- `/`, `/docs/`, `/login/`, `/casino/`, `/poker/`, `/craps/`, `/craps-strategy/`, `/blackjack/`, `/api/poker/*`, `/api/craps/*`, `/stock-research/`, `/bitcoin-chat/`, `/api/stocks/*`, `/api/bitcoin/*`, and `/api/analytics/*` are public. Stock and Bitcoin routes serve demo data when unauthenticated; valid app credentials unlock live provider-backed data. Admin, FastAPI docs/OpenAPI JSON, and other API routes require authentication. Protected backend routes return `503` when `APP_AUTH_PASSWORD` is missing.
