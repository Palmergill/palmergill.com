# Spec 4 — Backend Test Baseline

- **Quarter:** Q3 2026 (Jul–Sep)
- **Status:** draft
- **Depends on:** Spec 3 (clean repo) for CI hygiene
- **Areas:** `backend/` (new `backend/tests/`), GitHub Actions

## Summary

Stand up pytest for the FastAPI backend with focused coverage of the money
math — poker payouts, craps strategy translation, stock/bitcoin response
shaping — plus a CI workflow that runs backend tests and the existing
frontend game tests on every push.

## Background / current state

- The frontend games already have `tests/` directories (`blackjack/tests`,
  `craps/tests`, `craps-strategy/tests`, `poker/tests`).
- The backend (`backend/app`: 6 routers, 12 services, game logic in
  `poker_game.py` / `poker_ai.py`) has no test suite.
- Git history shows repeated payout-bug fixes ("Fix craps payout and bet
  unit bugs", "Fix craps sim: come-out odds, hardway-only resolution,
  duplicate bets") — regressions in money math are the recurring failure
  mode, and they currently reach production before being caught.

## Goals

1. Any change to payout/odds/translation logic runs against assertions on
   known-correct values before merge.
2. CI is the gate: a red check on the PR, not a manual step.
3. The suite runs fast (<30s) so it never gets skipped.

## Non-goals

- Not chasing a coverage percentage; coverage targets invite filler tests.
- No end-to-end browser tests (Spec 13 handles page-level verification).
- No load/performance testing.

## Requirements

### Test targets, in priority order

- **R1. Poker engine (`poker_game.py`):** hand evaluation (all 9 ranks +
  kicker tiebreaks), pot math including side pots, blind rotation.
- **R2. Craps strategy translation (`routers/craps.py` + `craps_ai.py`
  contract):** the `StrategyIntent` validation path — legal bet vocabulary,
  odds multipliers, `null` optional fields (a past production bug), and
  rejection messages for malformed intents. Use recorded fixtures, not live
  LLM calls.
- **R3. Poker AI (`poker_ai.py`):** decision function returns a legal action
  for every game state category (facing bet / checked to / all-in) — legality,
  not strategy quality.
- **R4. API contracts:** FastAPI `TestClient` smoke tests per router: happy
  path + auth-required routes reject anonymous calls + demo mode returns
  well-formed data with no credentials set.
- **R5. Analytics ingest (`routers/analytics.py`):** accepts valid events,
  bounds/rejects oversized or malformed payloads (it is a public endpoint).

### Infrastructure

- **R6.** `backend/tests/` with pytest + `pytest-asyncio`; test deps in a
  `requirements-dev.txt`; runnable via `cd backend && pytest`.
- **R7.** External services (CoinGecko, mempool.space, Finnhub, Polygon,
  LLM) are never called in tests — route through `mock_client.py` patterns
  or fixture JSON.
- **R8.** GitHub Actions workflow: on push/PR, run backend pytest and each
  game's existing JS test suite (whatever runner `*/tests` uses today —
  document it in the workflow).
- **R9.** SQLite test database created per-run in tmp; tests never touch
  `stock_data.db`.

## Technical design

- Layout: `backend/tests/test_poker_engine.py`, `test_craps_translation.py`,
  `test_poker_ai.py`, `test_api_contracts.py`, `test_analytics.py`,
  `conftest.py` (app fixture with auth + demo-mode env vars, mock service
  injection).
- Known-correct payout values sourced from standard references and asserted
  as literal expected numbers with the odds written in a comment
  (e.g. hardway 8 pays 9:1) so a reviewer can check the math without running
  anything.
- CI: single workflow `.github/workflows/test.yml`, Python 3.12 + Node LTS
  matrix not needed — one job each.

## Acceptance criteria

- [ ] `cd backend && pytest` passes locally in <30s with no network access
      (verify by running with networking disabled).
- [ ] Deliberately breaking a payout constant fails a test (mutation
      spot-check on 3 constants).
- [ ] CI runs on PRs and blocks merge on failure.
- [ ] README documents how to run backend and frontend tests.

## Risks

- **`poker_game.py` may not be import-clean** (module-level side effects,
  DB access on import). If so, the first task is a mechanical refactor to
  make the engine importable without I/O — keep it separate from any logic
  change and land it as its own PR.

## Estimate

~2 weeks part-time: 2–3 days infrastructure + fixtures, the rest writing the
R1–R5 suites.
