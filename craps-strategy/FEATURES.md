# Craps Strategy Simulator — Features & Progress

Living tracker for the craps strategy simulator. Update the **Status** column as work
lands. Status legend: ☐ not started · ◧ in progress · ☑ done · ⊘ blocked.

Plan of record: `/Users/palmer/.claude/plans/craps-strategy-simulator.md`

## Overview

A tool on palmergill.com where the user describes a craps betting strategy in plain
English, sets bet sizes + buy-in, and runs a Monte Carlo experiment (100 trials × up to
1000 rolls). Results: a 100-line balance-vs-roll chart, an ending-balance histogram, and
summary stats.

Contract is two-stage: the LLM returns a money-free **`StrategyIntent`** (bet types +
relative `units`); a deterministic client **`normalize()`** step turns that + the user
form into a concrete **`StrategySpec`** (final dollar amounts snapped to legal increments,
plus a stored/overridable `baseSeed`). The simulation then runs entirely client-side and
reproducibly (per-trial RNG seeded from `baseSeed`).

## Feature checklist

| # | Feature | Area | Status | Notes |
|---|---------|------|--------|-------|
| 1 | `StrategyIntent` schema + validation (`strategy.js`) | Frontend | ☑ | Bet vocab, `units`, `when`, `everyRoll`, odds, progression |
| 2 | `normalize(intent, form)` → `StrategySpec` (money + seed) | Frontend | ☑ | Overrides beat units; snap to legal increments; deterministic |
| 3 | Seed contract: `baseSeed = hashCanonical(spec)`, per-trial `mix(baseSeed, i)` | Engine | ☑ | Stored, displayed, user-overridable |
| 4 | Built-in preset intents (Pass+Odds, Iron Cross, 3-Point Molly, Don't+Odds) | Frontend | ☑ | Also the no-LLM fallback |
| 5 | Seedable RNG + `rollDice` (`engine.js`) | Engine | ☑ | mulberry32, deterministic per spec+seed |
| 6 | Bankroll accounting invariants + helper wrapping | Engine | ☑ | balance=cash only; `onFelt` accumulator; place win = profit-only; ending=cash+felt |
| 7 | Bet lifecycle categories (contract/travels/persistentUntilSeven/oneRoll/odds) | Engine | ☑ | working/off on come-out; `workingOnComeOut` flag |
| 8 | Line + odds resolution (pass/don't pass, come-out + point) | Engine | ☑ | New logic, not in crapsRules |
| 9 | Come / Don't-Come bets (travel to come-points) | Engine | ☑ | `maxActive` cap; flats + traveled points + odds |
| 10 | Place / hardway / field / prop resolution | Engine | ☑ | Reuse `crapsRules.js` helpers, wrapped per #6 |
| 11 | Progressions (press / regress / martingale / resetOnSevenOut) | Engine | ☑ | Applies to listed bets |
| 12 | `runTrial` + `runSimulation` + summary stats | Engine | ☑ | Survival %, median/mean, house edge |
| 13 | Page shell + casino theme + service worker (`index.html`, `sw.js`, `manifest.json`) | Frontend | ☑ | Mirrors `craps/` conventions |
| 14 | Strategy input UI (textarea, buy-in, base unit, overrides, seed field, preset dropdown) | Frontend | ☑ | Per-bet amount inputs override LLM units |
| 15 | Translate button → `/api/craps/translate`, normalize, confirm view | Frontend | ☑ | Returns intent; client makes the spec; 503 → preset fallback |
| 16 | 100-line balance chart (Chart.js, perf config) | Charts | ☑ | survivors green / busts red, gold buy-in ref line |
| 17 | Ending-balance histogram (Chart.js bar) | Charts | ☑ | 12 buckets |
| 18 | Summary stats panel | Frontend | ☑ | survival, median/mean, best/worst, edge, avg-rolls, seed |
| 19 | Analytics event `craps_strategy_simulated` | Frontend | ☑ | via `pgAnalytics.track` |
| 20 | Backend router `POST /api/craps/translate` (`routers/craps.py`) | Backend | ☑ | Pydantic `StrategyIntent` (no $), 400/502/503/429 |
| 21 | OpenAI translation helper (`services/craps_ai.py`) | Backend | ☑ | Raw urllib `/v1/responses`, json_schema, valid-JSON example |
| 22 | Register router in `main.py` **+ add `/craps-strategy` static mount** | Backend | ☑ | Verified route + mount present on boot |
| 23 | Env keys in `.env.example` | Backend | ☑ | `CRAPS_STRATEGY_MODEL`, rate-limit vars |
| 24 | Rate limiting on translate endpoint | Backend | ☑ | Mirrors `routers/analytics.py` (proxy-aware client IP) |
| 25 | Jest tests for `strategy.js` + `engine.js`; wire `package.json` roots | Tests | ☑ | 28 tests; EV over fixed sequences; progressions; bust; wide-band smoke |
| 26 | Link to tool from casino/landing index | Frontend | ☑ | "Strategy Lab" J♦ card in `casino/index.html` |

## Verification checklist

| Step | Status | Notes |
|------|--------|-------|
| Backend: `curl POST /api/craps/translate` returns valid spec or 503 fallback | ◧ | Reaches handler: 503 (no key here) + 422 on bad input verified. **Live LLM path untested — no OPENAI_API_KEY in this env.** |
| `npm test` — simulator + root suites green | ☑ | 139/139 tests pass as of 2026-07-04; simulator coverage remains in `craps-strategy/tests/` |
| Preview: translate + run a strategy, screenshot charts + stats | ☑ | Preset → run → 100-line chart + histogram + stats; determinism confirmed |
| Preview: console + network clean | ☑ | No console errors |
| Preview: mobile-width layout holds | ☑ | 375px: fields stack, theme intact |

## Open questions (for Palmer to review)

1. **OpenAI model + verification.** `CRAPS_STRATEGY_MODEL` defaults to `gpt-5.5` (matching
   bitcoin-chat). There was **no `OPENAI_API_KEY` in my environment**, so I could not run
   the real translate path end-to-end — only the graceful 503 fallback and input
   validation. Please run one live translation (or point me at a key) to confirm the
   `/v1/responses` `text.format` json_schema call shape and output parsing are right for
   the model you use.
2. **Casino card artwork.** The new "Strategy Lab" card reuses `craps.png` as a
   placeholder screenshot. Want a real screenshot of the simulator captured for
   `assets/project-screenshots/`?
3. **Hardway lifecycle.** ~~`crapsRules.resolveHardwayBets` takes a hardway *down* on a
   win; my engine re-arms it on the next placement.~~ **Resolved 2026-06-23:** hardways now
   resolve on *every* roll (matching their default `when: "always"`), so hardway-only
   strategies work and a winner is re-armed next placement. Open sub-question: should a
   hardway with `when: "pointOn"` be turned *off* on the come-out? Currently hardways
   always work regardless of `when`.
4. **Press legality.** A `press` progression can grow a place-6/8 bet to a non-$6-legal
   amount (e.g. $26) because I don't re-snap on press. Acceptable for a sim, or should
   pressed amounts re-snap to legal increments?
5. **Come-bet odds on come-out.** **Resolved 2026-06-23:** odds on established come/don't-come
   points are now *off and returned* on the shooter's come-out (the flat still resolves),
   matching standard table convention. No separate control exposed — flag if you want one.

## Decisions

- **2026-07-04** — Auth scope is intentionally public. `/craps-strategy/`
  and `/api/craps/*` remain in the public route lists alongside the main
  craps game; translation rate limiting is the guardrail.

## Decisions log

- **2026-06-23** — English→strategy via OpenAI (existing key); flat + simple
  progressions; full table of bets; results = line chart + stats + histogram.
- **2026-06-23** — LLM only *translates*; user form dollar amounts override any
  LLM-suggested amounts. Simulation is fully client-side + reproducible (seedable RNG).
- **2026-06-23** — Review fixes folded into plan:
  - Split contract into `StrategyIntent` (LLM, money-free) → `normalize()` →
    `StrategySpec` (client, deterministic money). Removes the dual source of truth.
  - Seed contract: `baseSeed = hashCanonical(spec)`, per-trial `mix(baseSeed, i)`; seed is
    stored/displayed/overridable so the same spec reproduces exactly.
  - Bankroll accounting invariants defined (balance = cash only; place wins add
    profit-only since the helper keeps the bet on the felt; ending balance = cash + felt
    value). Each crapsRules helper is wrapped to this model.
  - Explicit bet lifecycle categories (contract / travels / persistentUntilSeven /
    oneRoll / odds) with come-out working/off rules.
  - Tests use deterministic EV over fixed roll sequences; the statistical house-edge check
    is a wide-band smoke test, not a CI convergence gate.
  - Contract JSON examples are valid JSON (no inline `//` comments) for structured-output
    safety.
  - Must add `"/craps-strategy": "craps-strategy"` to the `LOCAL_SITE_ROOT` static-mount
    dict in `backend/app/main.py` (line ~616) or local verification can't load the page.

## Changelog

- **2026-06-23** — Bumped the run to **1,000 trials** (from 100) for more stable stats.
  The simulation of up to 1M rolls runs in ~0.5s. To keep the line chart fast and
  readable, it plots a representative **250-path sample** (stride-sampled), each thinned
  to ≤200 points on a linear x-axis; stats and the histogram still use all 1,000 trials.
  Chart title notes "N sample paths of 1,000 trials". Bumped app.js to ?v=4. UI copy
  updated to "1,000".


- **2026-06-23** — Reworked the edge stats. Replaced the noisy, easy-to-misread
  "Realized house edge" with two clearer stats: **Expected house edge** (the
  wager-weighted theoretical edge — stable, e.g. pass-line 1.41%, dropping to 0.33% with
  5× odds) and **Avg profit/loss per run** (the realized dollar outcome). Engine now
  tracks `expectedLoss` per resolution via a per-bet `HOUSE_EDGE` table and a `kind` tag
  on `settle`; odds count as 0% edge so they correctly dilute the blended edge. Bumped
  engine.js/app.js to ?v=3. Suite green at 105.


- **2026-06-23** — Review fixes (3): (P1) come/don't-come odds are now off and returned on
  the shooter come-out instead of lost on a 7 (`settleComeOdds` in engine.js); (P1)
  hardways resolve every roll so hardway-only strategies work (split `resolveHardways`
  from place resolution); (P2) duplicate bet types are rejected in both `strategy.js`
  `validateIntent` and the backend Pydantic model. 4 regression tests added; suite green
  at 101.


- **2026-06-23** — `strategy.js` (intent schema, validation, `normalize`, seed hash,
  presets) + `engine.js` (mulberry32 RNG, cash-only accounting via `onFelt`, lifecycle
  placement, line/odds/come/place/hard/field/prop resolution, progressions,
  `runTrial`/`runSimulation`/stats) implemented. 28 Jest tests added and passing; full
  repo suite green (96 tests). `package.json` jest roots/coverage wired.
- **2026-06-23** — Backend `services/craps_ai.py` (OpenAI `/v1/responses` json_schema
  translation) + `routers/craps.py` (`POST /api/craps/translate`, Pydantic `StrategyIntent`,
  rate limit, 400/502/503/422). Registered in `main.py`; added `/craps-strategy` static
  mount and `/api/craps` + `/craps-strategy` to `PUBLIC_PATH_PREFIXES` (see Q1). Env keys
  documented.
- **2026-06-23** — Frontend (`index.html`, `style.css`, `app.js`, `sw.js`,
  `manifest.json`): casino-themed page, plain-English + preset input, translate→normalize
  →confirm with editable bet amounts, Chart.js 100-line chart + histogram + stats, seed
  display, analytics event. Linked from `casino/index.html` ("Strategy Lab" card).
  Verified in preview (preset run, determinism, mobile, clean console).
