# Code Review — 2026-07-04

- **Scope:** `9963f44..HEAD` (21 commits) — repo cleanup, warm-theme flip,
  backend test baseline, and the shared casino header (Spec 5 partial).
- **Effort:** high (8 finder angles × up to 6 candidates, 1-vote verify)
- **Resolution note:** Findings 1-6 and 9 were fixed in commit
  `bf2efaa` (`Fix casino header review findings`) and pushed to `main` on
  2026-07-04. Findings 7, 8, and 10 remain follow-up cleanup opportunities.
- **Method note:** 7 of 8 parallel finder subagents hit the session usage
  limit and returned nothing; the finder and verification passes were
  re-run inline against the full diff instead (all 72 changed files read
  directly, findings verified against current code with `grep`/`git show`,
  not from memory). Only the conventions angle completed via subagent
  (result: no `CLAUDE.md` files exist anywhere in scope, so no findings
  there).

## Findings (most severe first)

### 1. Rebuy button doesn't work while a game page is open — CONFIRMED
- **File:** `shared/casino-header.js:138`
- The rebuy button resets the localStorage bankroll, but the running
  game's in-memory balance stays at 0 and overwrites the rebuy on its next
  write.
- **Failure scenario:** Player busts to $0 in craps → clicks Rebuy → header
  shows $1,000, but craps/app.js's module-level `balance` (read once at
  load, no `onChange` subscription) is still 0 — the table still shows $0
  and no bets are possible. The next roll/bet calls
  `casinoProfile.setBankroll(balance)` (craps/app.js:47), writing 0 back
  over the 1,000. Same mechanism via `profile.setBankroll(state.balance)`
  in blackjack/app.js:504. Rebuy only "works" if the player reloads the
  page first.
- **Fix direction:** craps/app.js and blackjack/app.js need to subscribe to
  `CasinoProfile.onChange` (or the header needs to call into the game
  directly) so an external bankroll change is reflected in the game's own
  `balance`/`state.balance`, not just overwritten by it.

### 2. Craps has no reachable bust-recovery UI on phones — CONFIRMED
- **File:** `craps/style.css:1484`
- Hiding the casino header under 480px removes the only rebuy affordance,
  and craps has no bankroll-reset button of its own (blackjack does).
- **Failure scenario:** Craps is a phone-column game (~430px design
  width) — a player on a 375–480px phone busts to $0 →
  `.casino-header { display: none }` hides the rebuy button, and grep
  confirms craps/app.js has no reset/rebuy of its own → the player is
  stuck at $0 with no in-game recovery path except clearing localStorage
  manually or navigating to `/casino/`'s reset-all.
- **Fix direction:** give craps its own always-visible reset control (like
  blackjack's), or keep a minimal rebuy-only affordance visible on mobile
  even with the rest of the header hidden.

### 3. Poker records gross pot as net profit, inflating shared stats — CONFIRMED
- **File:** `poker/app.js:2060`
- `recordSession('poker', { netProfit: myWin.amount })` uses the full pot
  awarded, not the player's actual gain (pot minus their own contribution).
- **Failure scenario:** Player contributes 100 to a 300 pot and wins;
  `_award_pot` credits the full 300 as `winners[].amount`, which includes
  the player's own 100 coming back. Recording `netProfit: 300` overstates
  the true net (+200) by exactly the player's contribution on every
  winning hand, so the shared lobby's aggregate "Net P/L" drifts upward
  systematically. Blackjack/craps record true balance deltas; poker does
  not.
- **Fix direction:** `netProfit: myWin.amount - (myPlayer.total_bet || 0)`.

### 4. craps-strategy's service worker precaches a stale site-nav version — CONFIRMED
- **File:** `craps-strategy/sw.js:16`
- Still lists `/shared/site-nav.js?v=10`; the page itself was bumped to
  `?v=11` along with every other game, but this one `STATIC_ASSETS` entry
  was missed.
- **Failure scenario:** Offline/PWA visit to `/craps-strategy/` — the
  app-shell cache holds `site-nav.js?v=10` (a URL the page never
  requests), while the page's real request for `?v=11` misses the
  precache. Offline, the nav script fails to load entirely; online, the
  `v=10` precache fetch is simply wasted bandwidth.
- **Fix:** one-line version bump, matching blackjack/craps/poker's `sw.js`.

### 5. Duplicated DB-isolation env var can silently no-op — PLAUSIBLE
- **File:** `backend/tests/conftest.py:12`
- `os.environ.setdefault("DATABASE_URL", ...)` means an already-exported
  `DATABASE_URL` defeats the test-isolation this line exists for.
- **Failure scenario:** A developer has `DATABASE_URL` exported locally
  (e.g. pointed at a Railway Postgres instance for ad-hoc queries) and
  runs `pytest` — `setdefault` is a no-op, the app connects to the real
  database, and `test_security_regressions.py`'s `setup_function` issues
  `db.query(...).delete()` against `PokerGameState`/`AnalyticsEvent`/
  `LogEntry` — against production data. Pre-existing exposure, but this
  line's stated purpose is isolation, so it should assign unconditionally.
- **Fix:** `os.environ["DATABASE_URL"] = ...` (unconditional), or fail
  loudly if a real-looking `DATABASE_URL` is already set.

### 6. Desktop blackjack/craps now scroll where they used to fit exactly — PLAUSIBLE
- **File:** `craps/style.css:62` (also applies to blackjack)
- The in-flow casino header adds ~46px to layouts whose height math
  (`calc(100vh - var(--site-nav-height))`) assumed no header existed.
- **Failure scenario:** On desktop, nav (52px, compensated via body
  padding) + header (~46px, in normal flow) + page
  (`100vh − 52px`) totals `100vh + 46px` — the page now scrolls by
  roughly the header's height where it previously fit exactly (measured
  during development: 997.9px document height vs 900px viewport at
  1280×900 on blackjack). Only the *mobile* regression was fixed in this
  branch; desktop was not re-verified.
- **Fix direction:** subtract `--casino-header-height` from the same
  height calc on desktop too (the mechanism already exists for poker).

### 7. Friendly 503 page duplicated verbatim across two runtimes — CONFIRMED
- **File:** `middleware.js:181` (mirrored in `backend/app/main.py`)
- The exact HTML/CSS for the "temporarily unavailable" page is copied
  byte-for-byte into both the Vercel edge middleware and the FastAPI
  backend.
- **Cost:** any future copy or style tweak must be made in two files in
  two languages; the first edit that touches only one will make Vercel-
  edge visitors and Railway-direct visitors see different unavailable
  pages. Two runtimes justify two artifacts but not necessarily two
  independent sources of truth.
- **Fix direction:** generate both from one template at build/deploy time,
  or at minimum add a comment in each file pointing at its counterpart so
  a future edit doesn't miss the pair.

### 8. Shared header's per-consumer CSS surgery, copy-pasted across games — CONFIRMED
- **File:** `poker/style.css:3068` (pattern also in `blackjack/style.css`,
  `craps/style.css`)
- Poker needed a `position:fixed` override plus `--casino-header-height`
  subtracted in three separate rules; blackjack and craps each carry an
  identical `@media (max-width:480px){ .casino-header{display:none} }`
  block.
- **Cost:** the next surface that mounts `CasinoHeader` (craps-strategy,
  or a future screen) has to rediscover and re-implement the same fixes
  rather than opting into them. A `mode:'fixed'` / `hideBelow:480` mount
  option (or shared classes in `casino-theme.css`) would centralize
  behavior that currently drifts across four files.

### 9. Every bankroll write triggers a full header re-render, even no-ops — PLAUSIBLE
- **File:** `blackjack/app.js:504` (and craps/app.js's equivalent)
- `applyAction` calls `profile.setBankroll(state.balance)` unconditionally
  on every action; each call now fires `notify()` → `CasinoHeader`
  re-renders with a localStorage read + `JSON.parse` of the stats blob,
  plus a bankroll read.
- **Cost:** small in absolute terms (tiny blob), but pure waste on the
  hottest input path in both games — every hit/stand/deal or every craps
  roll re-parses stats even when the balance didn't change.
- **Fix direction:** guard with `if (state.balance !== profile.getBankroll())`
  before writing, or have `notify()` no-op when the written value is
  unchanged.

### 10. `--casino-header-height` measured before webfonts settle — PLAUSIBLE
- **File:** `shared/casino-header.js:155`
- Height is published once at mount (plus on `window resize`), using
  whatever font is active at that instant.
- **Failure scenario:** On a cold font cache, mount measures
  `offsetHeight` with fallback fonts, publishes
  `--casino-header-height`, then the Playfair/Inter webfont swap reflows
  the header taller or shorter. Poker's fixed `.screen` top/height calc
  uses the now-stale value, producing a small gap or overlap under the
  header until the next resize.
- **Fix direction:** also re-publish via `document.fonts.ready.then(publishHeight)`,
  or use a `ResizeObserver` on the header root instead of a manual
  measure-once-plus-resize approach.

## Suggested priority for fixing

1. **#1 and #2 together** — the rebuy feature (the main new capability for
   craps) doesn't actually solve the bust-recovery problem it was built
   for. Fix both before calling Spec 5's R3 "shipped."
2. **#3** — silent stat corruption; cheap one-line fix.
3. **#4** — one-line fix, ships with the next craps-strategy deploy.
4. **#6** — cosmetic but visible on every desktop visit; same mechanism as
   the mobile fix already applied, just needs extending.
5. **#5, #7, #8, #9, #10** — lower urgency; good follow-up items, not
   blocking.
