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
| `npm test` — new suites green | ☑ | 96/96 tests pass (28 new) |
| Preview: translate + run a strategy, screenshot charts + stats | ☑ | Preset → run → 100-line chart + histogram + stats; determinism confirmed |
| Preview: console + network clean | ☑ | No console errors |
| Preview: mobile-width layout holds | ☑ | 375px: fields stack, theme intact |

## Open questions (for Palmer to review)

1. **Auth scope of the new routes.** I added `/api/craps` and `/craps-strategy` to
   `PUBLIC_PATH_PREFIXES` in `backend/app/main.py` so the tool is fully open, like the
   existing `/craps` game. Bitcoin Chat (the other OpenAI-backed tool) instead lives in
   `DEMO_PATH_PREFIXES`. Do you want the simulator fully public, or gated like
   bitcoin-chat (demo mode / behind app auth)? This affects whether it works on the live
   site without login.
2. **OpenAI model + verification.** `CRAPS_STRATEGY_MODEL` defaults to `gpt-5.5` (matching
   bitcoin-chat). There was **no `OPENAI_API_KEY` in my environment**, so I could not run
   the real translate path end-to-end — only the graceful 503 fallback and input
   validation. Please run one live translation (or point me at a key) to confirm the
   `/v1/responses` `text.format` json_schema call shape and output parsing are right for
   the model you use.
3. **Casino card artwork.** The new "Strategy Lab" card reuses `craps.png` as a
   placeholder screenshot. Want a real screenshot of the simulator captured for
   `assets/project-screenshots/`?
4. **Hardway lifecycle.** `crapsRules.resolveHardwayBets` takes a hardway *down* on a win;
   my engine re-arms it on the next placement, so it effectively stays working. Is
   "hardways stay working until they 7-out" the behavior you want, or should a winning
   hardway be collected and left off?
5. **Press legality.** A `press` progression can grow a place-6/8 bet to a non-$6-legal
   amount (e.g. $26) because I don't re-snap on press. Acceptable for a sim, or should
   pressed amounts re-snap to legal increments?
6. **Come-bet odds on come-out.** Odds on established come points are left *off* on the
   come-out roll (table convention). `workingOnComeOut` currently only governs place/hard
   working state, not come odds. Want a separate control, or is the convention fine?

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
