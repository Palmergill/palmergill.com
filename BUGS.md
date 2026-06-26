# Codebase Bug Audit — Open Items

Original audit date: 2026-05-27. Scope: full source tree (excluding `node_modules/`, `backend/venv/`, generated/test fixtures).

The original audit listed 27 findings. The critical and high correctness bugs — plus most of the medium/low items — were resolved by the `Fix audit bugs`, `Fix bug audit regressions`, and `bugs` commits and verified against current code (e.g. the under-min all-in handling at `backend/app/poker_game.py:446`, the AI negative-raise guard at `backend/app/poker_ai.py:254`, queued analytics writes at `backend/app/main.py`, and timezone-stamped admin timestamps at `backend/app/routers/admin.py:114`).

Follow-up review fixes through 2026-06-26 also closed the Vercel `/api/craps/*` public-route drift, the poker frontend raise-size contract bug, public analytics metadata size/depth validation, Bitcoin live-route event-loop blocking, stock compare day-change data fetching, EPS trend field drift, stale craps service-worker cache entries, Polygon zero-value earnings extraction, and poker WebSocket pre-subscribe authentication.

This file now tracks only the findings still open as of 2026-06-26. Items personally verified by reading the code are marked **[verified]**; items surfaced by subagent scans that were not fully verified are marked **[unverified]**.

---

## High

### 1. Shared rate limits are not global **[verified]**
- Auth, analytics, poker, and craps translation rate limits are still best-effort local stores unless backed by a shared service. Auth paths document this directly in code; public API limits should use the same shared backend if these endpoints receive meaningful unauthenticated traffic.
- Fix: back counters with Redis, Vercel KV, or a small database table with TTL cleanup.

---

## Medium

### 2. Railway database durability depends on deployment env **[unverified]**
- The Docker image defaults to SQLite at `/data`, while docs list `DATABASE_URL` as a primary Railway variable. If Railway is not configured with Postgres or a durable volume, stock cache, analytics, logs, and poker snapshots are not durable across container replacement.
- Fix: choose the production persistence policy. If Postgres is required, fail startup in production when `DATABASE_URL` is the Docker SQLite default.

## Low

No low-severity open code findings are currently tracked here.

---

## Recommendations

1. The in-memory rate limit / session stores need a shared backend for any multi-instance deployment.
2. Decide whether Railway production must require Postgres rather than accepting the Docker SQLite fallback.
3. The poker engine carried multiple subtle correctness issues in the original audit (now fixed). Property-based tests around `_is_round_complete`, `_advance_phase`, side-pot splits, and tournament level transitions would guard against regressions.
