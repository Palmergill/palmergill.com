# Codebase Bug Audit — Open Items

Original audit date: 2026-05-27. Scope: full source tree (excluding `node_modules/`, `backend/venv/`, generated/test fixtures).

The original audit listed 27 findings. The critical and high correctness bugs — plus most of the medium/low items — were resolved by the `Fix audit bugs`, `Fix bug audit regressions`, and `bugs` commits and verified against current code (e.g. the under-min all-in handling at `backend/app/poker_game.py:446`, the AI negative-raise guard at `backend/app/poker_ai.py:254`, queued analytics writes at `backend/app/main.py`, and timezone-stamped admin timestamps at `backend/app/routers/admin.py:114`).

This file now tracks only the findings still open as of 2026-05-30. Items personally verified by reading the code are marked **[verified]**; items surfaced by subagent scans that were not fully verified are marked **[unverified]**.

---

## High

### 1. `middleware.js:12` and `backend/app/main.py` — In-memory rate-limit store **[verified]**
- Both the Vercel edge middleware (`authFailureStore = new Map()`) and the FastAPI backend keep auth-failure counts in a process-local `Map`/`dict`. On serverless platforms (Vercel) instances are ephemeral and there is no cross-instance state, so `AUTH_RATE_LIMIT_MAX_ATTEMPTS` is enforced per cold start, not globally. An attacker can drive failed attempts arbitrarily high by causing the platform to spin up new isolates.
- Fix: back the counter with a shared store (Redis, KV) or, at minimum, document that the limit is best-effort.

---

## Medium

### 2. `backend/app/services/finnhub_client.py:95` — Fiscal-quarter mapping assumes calendar year **[unverified]**
- `quarter_months = {"1": "03-31", ...}` does not match retailers (e.g. fiscal year ending January). When merging with Polygon, mismatched dates drop the Finnhub EPS estimate.
- Fix: use the calendar-aligned `fiscal_period_end` from the upstream payload.

### 3. `craps/app.js` odds payouts use `Math.floor` for fractional ratios **[unverified]**
- Place / odds bets on 5/9 (3:2) and 6/8 (6:5) are floored (`Math.floor(bet.odds * getOddsPayout(...))`). Real casinos round to the nearest dollar but require even-multiples — the rule here is "you can bet any amount and you may quietly lose 1 unit on the round-down." This is acceptable if documented but should be validated against the rules block.

---

## Low

### 4. `backend/app/services/polygon_client.py` — Missing-revenue treated as zero **[unverified]**
- `.get("revenues", {})` then `latest.get("value")` returns `None` for *both* "field absent" and "field present but null", so YoY-growth callers can't distinguish "no data" from "no growth."

---

## Recommendations

1. The in-memory rate limit / session stores (#1) need a shared backend for any multi-instance deployment.
2. Validate the craps round-down behavior (#3) against the in-app rules block, and document the house-edge implication if it stays.
3. The poker engine carried multiple subtle correctness issues in the original audit (now fixed). Property-based tests around `_is_round_complete`, `_advance_phase`, side-pot splits, and tournament level transitions would guard against regressions.
</content>
</invoke>
