# Spec 5 — Casino Shell Unification

- **Quarter:** Q4 2026 (Oct–Dec)
- **Status:** draft
- **Depends on:** Spec 1 (warm chrome), Spec 4 (payout tests catch regressions)
- **Areas:** `shared/casino-profile.js`, `shared/casino-theme.css`, `casino/`, `poker/`, `craps/`, `blackjack/`

## Summary

Make the three casino games feel like one product: the existing shared
bankroll/profile becomes visible and consistent in every game's header, chip
and button styling unifies, and blackjack/poker reach the mobile-layout
quality bar craps already set.

## Background / current state

Much of the plumbing already exists — this spec is mostly about surfacing it:

- `shared/casino-profile.js` (185 lines) already persists display name,
  a shared bankroll (default 1000, shared between blackjack and craps;
  poker is server-managed and excluded by design), and per-game session
  stats (`recordSession`, `getAggregateStats`) in localStorage.
- `shared/casino-theme.css` exists but is thin (45 lines).
- Craps recently got a dedicated mobile table design (see commits
  "Implement mobile craps table design" and follow-ups); blackjack and poker
  have not had the same treatment.
- `casino/` is a landing page linking the three games.
- All three games are PWAs (`manifest.json` + `sw.js`).

## Goals

1. A player moving between games sees the same header: name, bankroll,
   session P/L, link back to `/casino/`.
2. Chips, action buttons, and modals share one visual language via
   `casino-theme.css`.
3. Blackjack and poker are fully playable one-handed on a 375px phone.
4. `/casino/` becomes a real lobby: per-game stats from
   `CasinoProfile.getAggregateStats()`, not just three links.

## Non-goals

- No server-side accounts or cross-device sync (bankroll stays in
  localStorage; poker chips stay server-managed).
- No real-money anything, ever.
- No new games.

## Requirements

### Shared casino header

- **R1.** A `shared/casino-header.js` component renders: game name, bankroll
  (live-updating), session net P/L, display-name affordance (first visit
  prompts once, dismissible), and a lobby link. All three games include it;
  poker shows its server chip stack in place of the shared bankroll, with the
  shared name still used.
- **R2.** Bankroll changes animate (count up/down) and flash win/loss color —
  reuse the pattern from craps' win/loss animations.
- **R3.** Bankruptcy flow: at bankroll 0, blackjack and craps offer a single
  "rebuy" that resets to the default 1000 via `CasinoProfile.resetBankroll()`
  and records the event in session stats.

### Visual unification

- **R4.** Grow `shared/casino-theme.css` into the single source for: chip
  denominations/colors, action buttons (deal/hit/stand/roll/bet), bet-amount
  steppers, and win/loss toasts. Per-game CSS keeps only table-specific
  layout.
- **R5.** Card rendering (blackjack + poker) uses one shared card style
  (same face design, corner indices, back pattern).

### Mobile parity

- **R6.** Blackjack at 375px: cards, bet controls, and actions visible
  without scrolling during a hand; touch targets ≥44px.
- **R7.** Poker at 375px: playable table view — community cards, own hand,
  pot, and action bar visible simultaneously; opponent detail collapses to
  compact seats.

### Lobby

- **R8.** `/casino/` shows per-game cards with hands played, net P/L, and
  last-played date from `getAggregateStats()`, plus the shared bankroll and
  a reset-all affordance (confirm dialog; calls `resetAll()`).

## Technical design

- Header ships as a self-registering script like `casino-profile.js`
  (`window.CasinoHeader.mount(opts)`), no framework, consistent with
  `site-nav.js`. It subscribes to bankroll changes via a small pub/sub added
  to `CasinoProfile` (`onChange(cb)`) — additive, no behavior change to
  existing getters/setters.
- Ensure every game calls `recordSession` at consistent boundaries (end of
  hand/shooter round) — audit current call sites first; the lobby stats (R8)
  are only as good as ingestion.
- Mobile work is per-game CSS + layout in `blackjack/style.css` and
  `poker/style.css`, modeled on the craps mobile approach in git history.
- Bump `sw.js` cache versions in all three games when shared assets change
  (service workers will otherwise serve stale CSS).

## Acceptance criteria

- [ ] Play a blackjack hand, walk to craps, see the same bankroll continue;
      lobby reflects both sessions.
- [ ] Poker shows shared display name and server chips; never reads or
      writes the shared bankroll (assert in code review + manual test).
- [ ] Bankruptcy rebuy works in blackjack and craps.
- [ ] 375px screenshots of all three games showing full play surfaces.
- [ ] No game-local chip/button CSS overriding the shared theme (grep for
      duplicated chip color values).
- [ ] Existing game tests still pass; `recordSession` boundaries covered by
      at least one test per game.

## Risks

- **Service-worker staleness** shipping shared CSS/JS changes — mitigated by
  cache-version bumps (in technical design) and verifying with a hard-reload
  test on a previously-visited game.
- **Poker's server-managed chips** conflicting with shared-bankroll UX
  expectations — handled by explicit R1 carve-out; label the poker stack
  "table chips" to distinguish it.

## Estimate

~4 weeks part-time: 1 week header + lobby, 1 week theme consolidation,
2 weeks mobile parity (poker is the hard one).
