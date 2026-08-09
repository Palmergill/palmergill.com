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
- `high-card-flush/`
- `bitcoin-chat/`
- `fantasy/`
- `admin/`

Production static hosting should serve those files directly. `vercel.json` rewrites `/api/*` requests to the Railway backend, along with `/login/session`, `/login/signup`, and `/login/logout`.

### Two roles

| Role | Comes from | Gets |
| --- | --- | --- |
| `admin` | `APP_AUTH_USERNAME` / `APP_AUTH_PASSWORD` env vars | Everything, including `/admin/*`, `/api/admin/*`, `/api/fantasy/admin/*`, and FastAPI docs |
| `member` | A row in the `app_users` table, created at `/signup/` with a site invite or open draft-room code | Live (non-demo) stock, Bitcoin, and fantasy data plus a seat in league draft rooms. No admin surfaces. |

There is deliberately no admin row in the database: nothing that can write to `app_users` can mint an account that reads the logs.

Sign-in, sign-up, and sign-out are served by the API service, not the edge, because member accounts live in its database. Vercel middleware normally verifies the `pg_session` cookie locally and enforces the role gate. Both platforms should agree on the token signing secret — they already do when both fall back to `APP_AUTH_PASSWORD`, while setting the same `APP_SESSION_SECRET` in both places decouples sessions from the password. If those settings temporarily drift during a deployment, the edge asks the API's no-store session-status endpoint to validate an otherwise unrecognized cookie; this prevents a successful sign-in from looping back to the login page while keeping the API service authoritative.

Vercel middleware keeps `/` public and requires a session (or Basic Auth) for:

- `/admin/*` — admin role only
- `/api/*`, except `/api/poker/*`, `/api/craps/*`, `/api/stocks/*`, `/api/bitcoin/*`, `/api/fantasy/*`, and `/api/analytics/*`; `/api/admin/*` and `/api/fantasy/admin/*` are admin role only

`/docs/*`, `/login/*`, `/signup/*`, `/stock-research/*`, `/bitcoin-chat/*`, `/fantasy/*`, `/poker/*`, `/craps/*`, `/craps-strategy/*`, `/blackjack/*`, `/high-card-flush/*`, `/api/poker/*`, `/api/craps/*`, `/api/stocks/*`, `/api/bitcoin/*`, `/api/fantasy/*`, and `/api/analytics/*` are public. Unauthenticated stock, Bitcoin, and fantasy API requests run in demo mode; any signed-in account unlocks the live provider-backed paths, but only the admin can trigger the fantasy admin refresh. Basic Auth remains supported for direct scripted admin access.

Configure these environment variables in Vercel:

```text
APP_AUTH_USERNAME=palmer
APP_AUTH_PASSWORD=<secret password>
```

If `APP_AUTH_PASSWORD` is missing in Vercel, protected routes return `503` so the apps do not accidentally publish without auth.

### Turning member sign-ups on

Set the invite code on **Railway** (the API service creates accounts, so Vercel does not need it):

```text
APP_SIGNUP_INVITE_CODE=<code you hand out>
```

When this is unset, general sign-ups are closed. An open Fourth & Fortune room code remains a narrowly scoped account invite so the host only has to share one code with league managers; it stops creating accounts as soon as the roster is locked. Rotating the site invite immediately invalidates any copy already handed out; existing accounts are unaffected. Passwords are hashed with scrypt, and there is no self-serve password reset: to reset one, delete the row from `app_users` and have the person sign up again.

## API Backend

Railway builds from the root `Dockerfile`, which installs `backend/requirements.txt` and runs:

```bash
uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}
```

Health check:

```text
/health
```

The backend owns the auth model: it authenticates sign-ins, creates member accounts, mints the `pg_session` cookie, and enforces the same path rules for locally served app folders. Poker, craps, craps-strategy, blackjack, High Card Flush, login, signup, `/api/poker/*`, `/api/craps/*`, and `/api/analytics/*` remain public in the backend. Stock research, Bitcoin chat, the fantasy dashboard, `/api/stocks/*`, `/api/bitcoin/*`, and `/api/fantasy/*` allow unauthenticated demo-mode responses and use live providers for any signed-in account. Admin, `/api/admin/*`, `/api/fantasy/admin/*`, and FastAPI docs/OpenAPI JSON require the admin role and return `403` for members. Protected routes return `503` if `APP_AUTH_PASSWORD` is missing, so set the same `APP_AUTH_USERNAME` and `APP_AUTH_PASSWORD` values in Railway to keep direct backend access usable and protected.

The root Railway deployment uses the root `Dockerfile`, which copies only `backend/`.

Stock Research uses Polygon in production. Configure:

```text
USE_REAL_DATA=true
POLYGON_API_KEY=<secret Polygon key>
```

`USE_REAL_DATA` defaults to `true` in the app and Docker image; set it to `false` only for local development with synthetic stock data.

Bitcoin Dashboard uses mempool.space as the default live provider. Configure:

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

`LOCAL_SITE_ROOT=true` currently mounts `assets/`, `shared/`, `about/`, `login/`, `stock-research/`, `poker/`, `craps/`, `craps-strategy/`, `blackjack/`, `high-card-flush/`, `bitcoin-chat/`, `fantasy/`, `casino/`, and `admin/` through FastAPI. The local `/docs` path is still FastAPI's generated API docs path; the static website docs page is served by production/static hosting at `/docs/`.
