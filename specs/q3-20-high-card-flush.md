# Spec 20 — High Card Flush

- **Quarter:** Q3 2026 (Jul–Sep)
- **Status:** shipped — written retroactively; the feature was built Aug 6–22 2026
- **Depends on:** Spec 5 (casino shell: shared header, profile, bankroll, rules viewer)
- **Areas:** `high-card-flush/`, `casino/index.html`, `shared/casino-header.js`,
  `shared/casino-profile.js`, `middleware.js`, `vercel.json`

> **Written after the fact.** This documents what was built rather than what was
> planned; the work shipped without a spec. It is recorded here so the casino
> roadmap (specs 5–8) reflects the games that actually exist.

## Summary

A single-player High Card Flush table at `/high-card-flush/`: a fully
client-side casino game on the shared casino shell, with the two side bets, a
simplified strategy hint, and offline support through a service worker. No
backend involvement.

## Background

The casino had poker, craps, and blackjack. High Card Flush is a good fit for
this site specifically because it is almost entirely a *counting* game — the
decision is "how many cards of my longest suit do I hold, and is that enough" —
so it is honest to implement, easy to explain in the rules viewer, and its
strategy compresses to one comparison a player can actually learn.

## Goals

1. A correct High Card Flush table, including both bonus bets.
2. Reuse the casino shell rather than growing a fourth bespoke one.
3. Offer optional strategy guidance without playing the hand for the player.
4. Work offline like the other casino apps.

## Non-goals

- No multiplayer, no backend state, no persistence beyond the shared bankroll.
- No configurable paytables. The two tables below are the ones the game ships.
- No progressive or envy bonuses.

## Rules implemented

Seven cards each to player and dealer. A hand's "flush" is its longest
same-suit subset, compared first on length, then card-by-card on rank.

- **Ante / Raise.** After seeing their seven, the player folds or raises. The
  maximum raise scales with flush length: 3× at six or more cards, 2× at five,
  otherwise 1×.
- **Dealer qualification.** A non-qualifying dealer pays the Ante and pushes
  the Raise. Otherwise the two flushes are compared.
- **Flush Bonus** — 4 cards 1:1, 5 cards 10:1, 6 cards 100:1, 7 cards 300:1.
- **Straight Flush Bonus** — 3 cards 7:1, 4 cards 60:1, 5 cards 100:1,
  6 cards 1000:1, 7 cards 8000:1.

Defaults: $1,000 bankroll, $25 ante, $5 min, $500 max.

## Strategy hint

`strategyAdvice` implements the simplified published threshold rather than a
full solver: raise the maximum on any four-card-or-better flush; raise 1× on a
three-card flush of T-8-6 or better; otherwise fold. It is surfaced as optional
guidance and never auto-plays.

## Presentation

Both hands are grouped by suit with the high card first, because deal order
hides the very thing the game is about. The dealer's hand is revealed after a
fold as well as a raise, labelled "would have qualified" / "would not have
qualified" — seeing what you dodged is most of the fun of folding.

## Architecture

- `highCardFlushGame.js` — pure rules and settlement, no DOM. UMD wrapper so
  jsdom tests import it directly.
- `app.js` — DOM controller. Builds every node with `createElement`; no
  `innerHTML` interpolation anywhere.
- `sw.js` — app shell offline, navigations network-first, assets
  stale-while-revalidate. `CACHE_NAME` is a hash of `STATIC_ASSETS`, so bumping
  an asset's `?v=` is what invalidates the cache.

Bankroll is shared with the other casino games through
`shared/casino-profile.js`. An external bankroll change (a rebuy from the header,
or another tab) patches the balance in place rather than rebuilding state, so it
cannot delete a dealt hand or an unread settlement.

## Testing

`high-card-flush/tests/highCardFlushGame.test.js` — flush and straight-flush
evaluation, comparison edges, qualification, both paytables, raise limits, and
settlement for every outcome.

`high-card-flush/tests/app.test.js` — DOM regressions: decision panel states,
suit-grouped rendering, dealer reveal on a fold, strategy hint, and mid-round
bankroll changes.

`shared/tests/asset-versions.test.js` — the page and its service worker agree on
every versioned asset.

## Known follow-ups

- The rules text lives at `casino/high card flush rules and strategy.txt`,
  matching the other games' spaced filenames.
- Chip and card CSS is still per-app; consolidating it is spec 5's remaining
  work.
