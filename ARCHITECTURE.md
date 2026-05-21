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
- `/docs/` - website documentation from `docs/index.html`
- `/stock-research/` - stock research app
- `/poker/` - poker app
- `/craps/` - craps app
- `/blackjack/` - blackjack app
- `/bitcoin-chat/` - Bitcoin chat app
- `/admin/` - protected backend log dashboard

## Backend

The backend is a FastAPI service in `backend/app`.

Important routes:

- `/api/stocks/*`
- `/api/poker/*`
- `/api/bitcoin/*`
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
- `/`, `/docs/`, `/poker/`, `/craps/`, `/blackjack/`, and `/api/poker/*` are public. Stock research, Bitcoin chat, admin, FastAPI docs/OpenAPI JSON, and other API routes require Basic Auth. Protected backend routes return `503` when `APP_AUTH_PASSWORD` is missing.
