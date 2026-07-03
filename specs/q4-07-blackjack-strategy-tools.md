# Spec 7 — Blackjack Strategy Tools

- **Quarter:** Q4 2026 (Oct–Dec)
- **Status:** draft
- **Depends on:** Spec 5 (shared header/theme) for UI placement
- **Areas:** `blackjack/` (app.js, blackjackGame.js, new strategy module)

## Summary

Add a basic-strategy hint mode and a card-counting practice drill to
blackjack, extending the game from "play for fun" to "learn the math" — the
same positioning that makes the craps simulator the site's most
differentiated feature.

## Background / current state

- `blackjack/blackjackGame.js` holds the game engine; `app.js` the UI; a
  `tests/` directory exists.
- The game is a PWA with its own service worker.
- Rule set to confirm from the engine before building the strategy table:
  number of decks, dealer hits/stands soft 17, double-after-split, surrender.
  The hint table must match the implemented rules exactly.

## Goals

1. A player can toggle hints and see the basic-strategy-correct action for
   every decision, with a one-line "why".
2. A session accuracy score shows how closely the player follows basic
   strategy.
3. A separate practice drill teaches Hi-Lo counting with graded feedback.

## Non-goals

- No betting-spread/true-count betting advice beyond showing the count
  (educational line to keep the feature clearly a trainer).
- No strategy-table variations for rule sets the game doesn't implement.
- No multiplayer or dealer-AI changes.

## Requirements

### Basic strategy hints

- **R1.** A strategy module (`blackjack/strategy.js`) encodes the full basic
  strategy matrix for the game's exact rules: hard totals, soft totals,
  pairs — actions hit/stand/double/split/surrender (as available).
- **R2.** Hint mode toggle (persisted in localStorage). When on, the
  recommended action's button is highlighted before the player acts, with a
  short reason ("Dealer 6 is weak — double your 11").
- **R3.** Whether hints are on or off, every player decision is scored
  against the matrix. End-of-hand feedback marks deviations; a session
  accuracy percentage lives in the header area.
- **R4.** A "strategy chart" view renders the full matrix as a color-coded
  table (the classic chart), reachable from the game and usable standalone;
  the player's current situation is highlighted when opened mid-hand.

### Counting practice drill

- **R5.** Drill mode (separate screen, `/blackjack/#drill` or in-page mode
  switch): cards flash one at a time at an adjustable pace; player keeps the
  running Hi-Lo count and enters it when prompted (after N cards or on
  demand). Feedback: correct count, player's count, per-card replay of where
  they drifted.
- **R6.** Difficulty levels: pace (1s/0.7s/0.4s per card), single cards vs
  pairs vs full dealt hands, deck count for true-count conversion questions
  at the hardest level.
- **R7.** Drill stats (best streak, accuracy by pace) persist locally;
  surfaced in the drill screen, not mixed into casino session stats.
- **R8.** In the main game, an optional "show count" toggle displays the
  running count and true count of the shoe as dealt — off by default,
  labeled as a learning aid.

### Copy & framing

- **R9.** A short intro blurb on both features: what basic strategy is
  (house edge ~0.5% when followed), what counting is, and a note that this
  is math education — consistent with the craps simulator's expected-edge
  framing.

## Technical design

- The strategy matrix is data, not code: a literal lookup table keyed by
  `(playerTotal|pair|soft, dealerUp)` → action, with the rule assumptions
  written at the top of the file. Deviations from any published chart are
  bugs; the table is unit-tested against a fixture of ~30 canonical
  decisions (16 vs 10 → hit; 11 vs 6 → double; A,8 vs 6 → stand/double per
  rules; 8,8 vs 10 → split; etc.).
- Scoring hooks into the existing action dispatch in `app.js` — one
  interception point where `(gameState, chosenAction)` is compared to
  `strategy.recommend(gameState)`.
- Count tracking wraps the engine's deal function; the drill reuses the same
  card-render components as the game (per Spec 5's shared card style).
- All new logic gets tests in `blackjack/tests/` alongside the existing
  suite.

## Acceptance criteria

- [ ] Matrix fixture tests pass; rules stated in `strategy.js` header match
      the engine's actual rules (verified by reading `blackjackGame.js`, and
      asserted where the engine exposes them).
- [ ] Hints highlight the correct action for the 30 fixture scenarios played
      manually or via test harness.
- [ ] Session accuracy updates per decision and survives a page reload
      mid-session.
- [ ] Drill: a deliberately wrong count is caught and the per-card replay
      identifies the drift point.
- [ ] Hint mode off by default; zero visual change for players who ignore
      the feature.
- [ ] Service worker cache version bumped; new module loads offline.

## Risks

- **Rules mismatch:** publishing a chart that doesn't match the engine's
  rules teaches players wrong strategy. Mitigation: the engine-rules audit
  is task one, and the matrix file states its assumptions next to the data.
- **Engine entanglement:** if `blackjackGame.js` doesn't expose clean game
  state for `recommend()`, do a small extraction refactor first (with tests)
  rather than reaching into UI state.

## Estimate

~3 weeks part-time: 1 week matrix + hints + scoring, 1 week drill,
1 week chart view, copy, and polish.
