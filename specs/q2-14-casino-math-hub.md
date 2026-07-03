# Spec 14 — Casino Math Hub

- **Quarter:** Q2 2027 (Apr–Jun)
- **Status:** draft
- **Depends on:** Spec 6 (simulator v2), Spec 7 (blackjack strategy tools); direction gated on a traction check (see Risks)
- **Areas:** new `casino-math/` (or expansion of `craps-strategy/`), `casino/`, `shared/`

## Summary

Expand the craps simulator's "learn the math" positioning into a
cross-game casino-math hub: a house-edge explorer covering every bet on the
site's three games, backed by the simulator for craps and closed-form math
elsewhere — one place that answers "what does this bet actually cost me?"

## Background / current state

- By Q2 2027 the site will have: the craps simulator with A/B comparison,
  risk metrics, and shareable runs (Spec 6); blackjack basic-strategy and
  counting tools with the ~0.5% house-edge framing (Spec 7); expected-edge
  copy already established in the craps app.
- The roadmap's premise: by spring the analytics (Spec 8's usage panel)
  show which app has traction; the working assumption is the strategy/math
  tooling. This spec is the "one new bet" for the year — deliberately an
  expansion of the strongest thing rather than a fourth game.

## Goals

1. One page ranks every bet across craps, blackjack, and video-poker-style
   basics by house edge, each with a plain-English "cost per $100 wagered"
   framing.
2. Interactive: pick a bet, see the payout table, the true odds, where the
   edge comes from, and (for craps bets) a one-click "simulate it" jump
   into the simulator with that bet preloaded.
3. The hub becomes the natural landing page for the site's educational
   identity — linkable, shareable, the thing that gets posted in a forum
   thread.

## Non-goals

- No fourth game build.
- No gambling encouragement mechanics — the entire framing is "here is
  what bets cost"; no "best bets to win" language.
- No roulette/baccarat/slots coverage in v1 (games the site doesn't have;
  possible later).

## Requirements

### House-edge explorer

- **R1.** A sortable, filterable table of bets: game, bet name, house edge
  %, expected cost per $100 wagered, payout, true odds, variance bucket
  (low/med/high). Craps rows cover every bet the game implements (pass,
  don't, come, field, place, hardways, props, odds at 1x–5x); blackjack
  rows cover rule/strategy scenarios (perfect basic strategy, common
  mistakes like never-bust play, insurance).
- **R2.** Every edge number is *sourced in the page*: an expandable
  derivation showing the math (probabilities × payouts), not just an
  asserted percentage. This is the differentiator over the hundred static
  house-edge tables online.
- **R3.** Edge values are data with tests: a `bets.js` dataset where each
  entry carries the derivation inputs, and the displayed edge is *computed*
  from them at render/test time — a wrong probability fails a test rather
  than shipping a wrong table.

### Interactivity

- **R4.** Bet detail view: payout vs true odds visual (the gap *is* the
  edge), the derivation (R2), variance explanation ("low edge, high
  variance — hardways lose slowly on average but swing hard").
- **R5.** Craps bets link into the simulator: "simulate $10 on this for
  1,000 sessions" deep-links using Spec 6's URL-fragment spec format with a
  single-bet strategy prefilled.
- **R6.** Blackjack scenarios link to the strategy chart / drill from
  Spec 7 where relevant ("insurance is a −7.4% bet — the counting drill
  shows when that changes").
- **R7.** A comparison widget: pick any two bets (cross-game allowed) and
  see cost-per-$100 side by side over a night of play (e.g. 100 resolved
  bets).

### Placement & framing

- **R8.** Lives at `/casino-math/` with a card on `/casino/` and a nav
  entry; the intro states the site-wide stance: all play money, the house
  always has an edge, this page shows exactly how much.
- **R9.** Copy voice: the established beginner-gloss register; every
  percentage paired with the dollars-per-$100 framing.

## Technical design

- Static page + `bets.js` dataset + a small render module; derivations
  computed client-side from probability/payout primitives (dice outcome
  counts for craps; published composition-dependent values for blackjack
  scenarios, with sources cited in the data file).
- Deep links: craps → Spec 6 fragment format (versioned, validated on the
  receiving end already); blackjack → anchor/param into the chart/drill.
- Tests: recompute every edge from derivation inputs and assert against
  the stated value (catching both math and data-entry errors); fragment
  deep-link round-trip test against the simulator's parser.
- Reuse: warm tokens, `site-nav`, the shared chart helper for the payout
  visuals.

## Acceptance criteria

- [ ] Table covers all implemented craps bets + ≥6 blackjack scenarios;
      sorts and filters work.
- [ ] Every edge value's derivation expands and the computed value matches
      the displayed one (enforced by test).
- [ ] Simulator deep link from a craps bet opens with the strategy
      prefilled and runs (verify Spec 6 parser accepts it).
- [ ] Two-bet comparison renders cross-game.
- [ ] Page meets Spec 13's perf/a11y bars from day one (table is real
      `<table>` markup, keyboard sortable).
- [ ] Shared/posted link unfurls with a proper OG card.

## Risks

- **The traction assumption is wrong.** Gate: check Spec 8's usage panel at
  quarter start. If the strategy tools aren't what people use, replace this
  spec with a push on whatever is (stock research being the likely
  alternative) — the quarter's slot is "double down on traction," not
  "build this page regardless."
- **Blackjack edge values are composition-dependent and easy to get
  subtly wrong** — cite the source for each scenario in the data file and
  keep the scenario list small and defensible over exhaustive.

## Estimate

~4 weeks part-time: 1 week dataset + derivation engine + tests, 1 week
table/detail UI, 1 week deep links + comparison widget, 1 week copy and
polish.
