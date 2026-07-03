# Spec 6 — Craps Strategy Simulator v2

- **Quarter:** Q4 2026 (Oct–Dec)
- **Status:** draft
- **Depends on:** Spec 4 (translation fixtures), Spec 1 (theme)
- **Areas:** `craps-strategy/` (app.js, engine.js, strategy.js), `backend/app/routers/craps.py`, `backend/app/services/craps_ai.py`

## Summary

Build on the simulator's v1 foundation (plain-English strategy → LLM
`StrategyIntent` → deterministic `StrategySpec` → seeded client-side Monte
Carlo) with the three features that make it shareable and comparative:
side-by-side strategy comparison, shareable strategy links, and richer risk
metrics.

## Background / current state

v1 already ships (see `craps-strategy/FEATURES.md`):

- Two-stage contract: LLM returns a money-free `StrategyIntent`;
  deterministic client `normalize()` produces a `StrategySpec` with dollar
  amounts snapped to legal increments and a stored, overridable `baseSeed`.
- Seedable RNG (mulberry32), per-trial seeds mixed from `baseSeed` —
  results are reproducible for a given spec + seed.
- 1,000 trials, sampled balance-vs-roll line chart, ending-balance
  histogram, summary stats, expected edge + realized P/L.
- Built-in presets: Pass+Odds, Iron Cross, 3-Point Molly, Don't+Odds
  (also the no-LLM fallback).

## Goals

1. Compare two strategies on identical dice (same seeds) and see which
   holds up better, visually and numerically.
2. Any strategy + seed is shareable as a URL that reproduces the exact run.
3. Results answer the questions gamblers actually have: "how likely am I to
   walk away up?", "how bad is a bad night?", "how long does my buy-in
   last?"

## Non-goals

- No server-side simulation — the engine stays client-side and deterministic.
- No more than 2 strategies compared at once (2 keeps charts readable).
- No new bet types unless a preset needs one.

## Requirements

### Comparison mode (A/B)

- **R1.** UI toggle "Compare" adds a second strategy slot (B). Both run the
  same trial count over the *same dice sequences*: trial *i* uses the same
  per-trial seed for A and B, derived from a shared run seed — differences
  are then attributable to strategy alone, not luck.
- **R2.** Overlaid outputs: median balance-vs-roll lines with shaded
  interquartile bands per strategy (replace the current 100-line spaghetti
  in compare mode); side-by-side histogram; stats table with per-metric
  winner highlighting.
- **R3.** Any combination of sources: preset vs preset, preset vs described,
  described vs described.

### Shareable links

- **R4.** "Share" button serializes the *normalized `StrategySpec`(s)* +
  run seed + trial/roll settings into the URL fragment
  (`#s=<base64url(json)>`), so shared runs bypass the LLM entirely and
  reproduce exactly. Fragment (not query) keeps specs out of server logs.
- **R5.** On load with a fragment: validate against the existing spec schema,
  render the strategy in the form as read-only-with-edit affordance, and
  auto-run. Invalid/oversized payloads (cap ~8KB) show a friendly error and
  fall back to the default view.
- **R6.** Copy button + native share sheet on mobile.

### Risk metrics

- **R7.** Add to summary stats, per strategy: probability of finishing
  ahead; P5/P25/median/P75/P95 ending balance; probability of ruin
  (bankroll hits an untenable level before max rolls); median survival
  (rolls until ruin among ruined trials); max drawdown (median and worst).
- **R8.** Each metric gets a one-line plain-English gloss consistent with
  the site's beginner-copy voice ("In 1,000 simulated sessions, you ended
  the night ahead 41% of the time").

### Preset library growth

- **R9.** Add presets: Field-only, Place 6&8, All Hardways, and a
  "House Special" don't-side ladder — each defined as a `StrategyIntent`
  (reuses the existing preset mechanism) with a short description of the
  idea behind it and its expected edge.

## Technical design

- **Engine:** `engine.js` gains `runComparison(specA, specB, settings)` that
  reuses the existing per-trial loop, seeding trial *i* for both specs from
  `mix(runSeed, i)`. Percentile/drawdown metrics computed in one pass over
  per-trial results — no engine-internals change, only aggregation.
- **Serialization:** version the payload (`{v:1, specs:[...], seed, settings}`)
  so future schema changes can migrate or reject cleanly. The spec schema
  validator already exists in `strategy.js` — reuse it on load.
- **Charts:** extend the existing chart code for band rendering; keep the
  single-strategy view unchanged (v1 users see nothing move).
- **Tests (`craps-strategy/tests/`):** determinism test (same fragment →
  identical stats), A/B same-dice test (A==B strategies → identical
  results), percentile math against a hand-computed fixture, round-trip
  serialize/parse.

## Acceptance criteria

- [ ] Comparing a strategy against itself yields identical curves and stats
      (proves same-dice fairness).
- [ ] A shared link opened in a private window reproduces the exact stats
      of the original run, with no LLM/API call (verify network tab).
- [ ] All R7 metrics render with glosses for single and compare modes.
- [ ] New presets validate against the intent schema and run without LLM.
- [ ] Existing v1 tests still pass; new tests cover the four cases above.
- [ ] 375px mobile layout works in compare mode (stack, don't squeeze).

## Risks

- **URL length** on very complex described strategies — mitigated by the 8KB
  cap + graceful error (R5); normalized specs are compact in practice.
- **Chart readability** with two bands — resolved in design review before
  build; fall back to toggling one strategy visible at a time if bands
  overlap illegibly.

## Estimate

~4 weeks part-time: 1 week comparison engine + tests, 1 week share links,
1 week metrics, 1 week charts/polish.
