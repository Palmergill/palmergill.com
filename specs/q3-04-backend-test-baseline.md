# Spec 4 — Backend Test Baseline

- **Quarter:** Q3 2026 (Jul–Sep)
- **Status:** shipped
- **Depends on:** Spec 3 (clean repo) for CI hygiene
- **Areas:** `backend/` (new `backend/tests/`), GitHub Actions

## Summary

Stand up pytest for the FastAPI backend with focused coverage of the money
math — poker payouts, craps strategy translation, stock/bitcoin response
shaping — plus a CI workflow that runs backend tests and the existing
frontend game tests on every push.

## Background / current state

- Shipped 2026-07-03: discovered mid-implementation that a real test suite
  already existed at `backend/tests/test_security_regressions.py` (973
  lines, 251 tests) with `pytest.ini` already configured — a substantial
  security/auth/analytics/poker regression suite the original spec draft
  didn't know about. Rather than duplicate it, this pass filled the actual
  gaps: hand evaluation, pot math, and craps translation had zero coverage.
- The frontend games already have `tests/` directories (`blackjack/tests`,
  `craps/tests`, `craps-strategy/tests`, `poker/tests`) run via Jest.
- A CI workflow already existed at `.github/workflows/ci-cd.yml` running
  backend pytest and frontend Jest on every push/PR — R8 was already done.
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

- Actual layout shipped: `backend/tests/test_poker_hand_evaluation.py`
  (R1, all 9 `HandRank` categories + kicker tiebreaks + best-of-seven),
  `test_poker_pot_math.py` (R1, side pots, odd-remainder splits with folded
  contributors, blind rotation incl. heads-up), `test_craps_translation.py`
  (R2, `StrategyIntent` validation + the `/api/craps/translate` endpoint
  with `craps_ai.translate_strategy` always monkeypatched), and
  `test_poker_ai_legality.py` (R3, dispatches `make_decision` output
  through the engine's own `action_*` methods across all 5 personalities ×
  facing-a-bet / checked-to / short-stack-forced-all-in). R4/R5 (API
  contracts, analytics bounds) turned out to already be substantially
  covered by the pre-existing `test_security_regressions.py`; only the
  stocks-router gap was added, in `test_api_contracts.py`.
- `conftest.py` redirects `DATABASE_URL` to a fresh tmp SQLite file per test
  run (module-level env var, set before `app.database` is ever imported)
  and creates the schema once per session — this satisfies R9, which the
  pre-existing suite didn't: it was writing to a persistent
  `backend/stock_data.db` on every run.
- Known-correct payout values are asserted as literal expected numbers with
  the odds/ranking written in a comment so a reviewer can check the math
  without running anything.
- CI: the pre-existing `.github/workflows/ci-cd.yml` already runs backend
  pytest and frontend Jest on push/PR — satisfies R8 as-is, no new workflow
  needed.

## Acceptance criteria

- [x] `cd backend && pytest` passes locally in <30s with no network access
      (328 tests in ~2.6s, verified with a bogus proxy that fails any real
      outbound call).
- [x] Deliberately breaking a payout constant fails a test (mutation
      spot-check on 3 constants: `HandRank.FULL_HOUSE` ordinal, the craps
      odds-multiplier upper bound, and the pot remainder-chip split — each
      mutation was applied, confirmed to fail the relevant test, then
      reverted).
- [x] CI runs on PRs and blocks merge on failure (`.github/workflows/ci-cd.yml`,
      pre-existing).
- [x] README documents how to run backend and frontend tests.

## Risks

- **`poker_game.py` may not be import-clean** (module-level side effects,
  DB access on import). If so, the first task is a mechanical refactor to
  make the engine importable without I/O — keep it separate from any logic
  change and land it as its own PR.

## Estimate

~2 weeks part-time: 2–3 days infrastructure + fixtures, the rest writing the
R1–R5 suites.
