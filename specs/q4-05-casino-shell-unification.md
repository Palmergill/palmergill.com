# Spec 5 — Casino Shell Unification

- **Quarter:** Q3 2026 (Jul–Sep) — pulled forward from Q4 (decided Jul 2026; retheme close-out freed the time, and Q4's simulator/blackjack specs build on this)
- **Status:** in progress (R1/R2/R3/R8 shipped 2026-07-03; R4 partial; R6/R7 turned out to already be met; R5 deferred — see notes)
- **Depends on:** Spec 1 (warm chrome), Spec 4 (payout tests catch regressions)
- **Areas:** `shared/casino-profile.js`, `shared/casino-header.js` (new),
  `shared/casino-theme.css`, `casino/`, `poker/`, `craps/`, `blackjack/`

## Summary

Make the three casino games feel like one product: the existing shared
bankroll/profile becomes visible and consistent in every game's header, chip
and button styling unifies, and blackjack/poker reach the mobile-layout
quality bar craps already set.

## Background / current state

Much of the plumbing already existed — this pass was mostly about
surfacing it, plus two real discoveries made along the way:

- `shared/casino-profile.js` already persisted display name, a shared
  bankroll (blackjack + craps; poker server-managed by design), and
  per-game session stats. It had no change-notification mechanism, so
  nothing could react live to a bankroll/name update — added `onChange()`
  (additive, wraps every mutator; one listener throwing doesn't break
  others or the write that triggered it).
- **R6/R7 (mobile parity) were already met on inspection.** Verified via
  the browser preview at 375px before writing any code: blackjack's
  betting and in-hand views fit the viewport exactly with no scroll and
  70-83px touch targets; poker's table view (community cards, hand, pot,
  action bar) was already fully visible with 52-64px touch targets. The
  "blackjack/poker haven't had the craps treatment" premise this spec
  started from was stale by the time it was picked up — no mobile redesign
  work was actually needed for either.
- **R8 (lobby stats) was already fully built.** `/casino/` already had a
  "Your House" panel: bankroll, aggregate hands/net-P&L/biggest-win, an
  editable name field, a per-game breakdown line, and a reset-all button
  with a confirm dialog and a cross-tab `storage` listener. The only real
  gap versus the spec's literal wording: the breakdown didn't show
  last-played date — added that.
- Poker had **no shared-header integration at all**: it didn't include
  `casino-profile.js`, used a purely local name input, and had its own
  separate `StatsManager` (handsPlayed/won, biggest pot, hand history) with
  no bridge to `CasinoProfile.recordSession`.
- Craps had **no bankroll-recovery mechanism** — blackjack already had an
  always-visible "Reset bankroll" button, craps had nothing, so a busted
  craps player was stuck with no way to continue.
- All three games are PWAs (`manifest.json` + `sw.js`); shared-asset
  version bumps need matching cache-name bumps (`buildCacheName` hashes the
  `STATIC_ASSETS` list) or players get served stale JS/CSS after a deploy.
  Found and fixed stale `site-nav.js`/`style.css` version entries in two of
  the three `STATIC_ASSETS` lists while touching this (pre-existing drift,
  unrelated to this spec but adjacent and cheap to fix).
- **Structural surprise:** poker's `.screen` panels are `position: fixed`,
  full-viewport layers by design ("gameplay owns the viewport on phones" —
  an existing, deliberate comment in `poker/style.css`), which paint over
  any normal-flow content added before them. A naively-mounted header was
  invisible on poker until this was diagnosed. See R1 technical design.

## Goals

1. A player moving between games sees the same header: name, bankroll,
   session net P/L, link back to `/casino/`.
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

- **R1. Shipped.** `shared/casino-header.js` (`CasinoHeader.mount(opts)`,
  self-registering like `casino-profile.js`) renders: lobby link, game
  name, a clickable display-name badge (`window.prompt`-based edit — kept
  deliberately simple over a custom inline-edit UI given the time budget),
  session net P/L (measured from mount time via a baseline snapshot, not
  lifetime net profit), and bankroll. Poker mounts with `chips: true` and
  drives the number via `instance.setChips(n)` instead of reading the
  shared bankroll; blackjack/craps read `CasinoProfile` directly and
  re-render via `onChange`.
  - Poker-specific: because `.screen` is fixed and full-viewport, the
    header is pinned `position: fixed` (poker-only override in
    `poker/style.css`) and a `--casino-header-height` custom property (set
    by the header itself via `ResizeObserver`-free `offsetHeight` +
    `resize` listener) is subtracted from `.screen`/`#game-screen`'s
    top/height calc so content doesn't render underneath it.
- **R2. Shipped.** Bankroll value flashes green/up or red/down on change
  (`casinoHeaderFlashWin`/`Loss` keyframes in `shared/casino-theme.css`,
  the same visual pattern as craps' existing `.win-flash`/`.loss-flash`,
  reimplemented on the header's own element since craps' original classes
  turned out to be dead code — see Risks).
- **R3. Shipped.** Rebuy button appears only at bankroll `0` for
  blackjack/craps (never for poker/chips mode), calls
  `CasinoProfile.resetBankroll()` + records a `casino_rebuy` analytics
  event. Verified live in the browser: set bankroll to 0, button appeared,
  click reset to 1000 and hid the button again.

### Visual unification

- **R4. Partial.** The header's own chrome (lobby link, name badge, stat
  blocks, rebuy button, flash keyframes) is centralized in
  `shared/casino-theme.css` using only the existing shared tokens — no new
  per-game CSS needed for the header itself. **Not done:** consolidating
  each game's *pre-existing* chip/button/modal CSS (blackjack's chip
  buttons, craps' bet chips, poker's `ChipStackVisualizer`) into one shared
  system. All three already look visually coherent (same gold/felt palette
  from the retheme) and are independently well-tuned; unifying their actual
  markup/CSS is a separate, riskier pass than this session's time budget
  supported without live-testing three complex game UIs pixel-by-pixel.
  Left as explicit follow-up.
- **R5. Deferred, not started.** Shared card-rendering style (blackjack +
  poker) untouched. Both already use a similar white-card/corner-index
  look post-retheme; a literal shared component wasn't attempted this pass.

### Mobile parity

- **R6/R7. Already met — verified, no changes required.** See Background.
  One regression was introduced and fixed during this pass: adding the
  header in normal document flow pushed blackjack/craps content ~40-52px
  below a viewport that had zero prior slack (both were exactly
  scroll-free before). Fixed by hiding `.casino-header` below a 480px
  breakpoint in `blackjack/style.css` and `craps/style.css` specifically
  (both are single continuous felt-table pages with no idle/lobby screen
  to show it on, unlike poker) rather than compressing the header to
  illegibility or shrinking the already-tuned table layouts. Re-verified
  post-fix: blackjack back to ~4px of scrollHeight slack (was exactly 0;
  negligible, deal button fully visible), craps controls fully visible.
  Poker's mobile gameplay view hides the header via its existing
  `.poker-game-active` mechanism (same treatment already applied to the
  site nav on phones) — the header only shows on poker's pre-game
  start/lobby/stats screens, which was already slack-tolerant.

### Lobby

- **R8. Already shipped (found, not built).** Only addition: last-played
  date in the per-game breakdown line (`lastPlayedLabel()` helper,
  "today"/"yesterday"/"Nd ago").

## Technical design

- `shared/casino-header.js`: mountable component, no framework. Subscribes
  to `CasinoProfile.onChange` for live bankroll/name re-render; exposes
  `{ setChips(n), destroy() }`.
- `CasinoProfile.onChange(fn)`: additive pub/sub, returns an unsubscribe
  function, wraps `setBankroll`/`setDisplayName`/`recordSession`/
  `resetStats`/`resetAll`.
- Poker also gained: `casino-profile.js` include (previously missing),
  `CasinoProfile.setDisplayName()` called from both `startGame()` call
  sites, `CasinoProfile.recordSession('poker', ...)` called alongside the
  existing `StatsManager` calls at the hand-result hook (bridges poker into
  the shared aggregate stats without touching its richer local stats/hand-
  history system), and `pokerCasinoHeader.setChips()` called at the same
  site `elements.yourChips.innerHTML` already updates.
- Service workers: bumped `casino-profile.js`/`casino-theme.css` to `?v=2`
  everywhere referenced (content changed); added `casino-header.js?v=1` to
  all three `STATIC_ASSETS` lists; bumped each game's own `app.js`/
  `style.css` version query to match its actual edits; corrected two
  stale `site-nav.js`/`style.css` version entries found in the process.
  `buildCacheName`'s list-hash means any of these bumps alone invalidates
  the old cache — verified in the browser preview by unregistering stale
  service workers and confirming a fresh load picks up the new markup.

## Acceptance criteria

- [x] Play a blackjack hand, walk to craps, see the same bankroll continue;
      lobby reflects both sessions. (Verified live: blackjack bet reduced
      shared bankroll to $975; craps header and craps' own balance card
      both showed $975 on navigation; lobby's "Your House" panel matched.)
- [x] Poker shows shared display name and server chips; never reads or
      writes the shared bankroll. (Verified live: header showed "TABLE
      CHIPS $1,000" driven by `setChips`, unaffected by a subsequent
      `CasinoProfile.setBankroll(9999)` call in the same test; also covered
      by a unit test.)
- [x] Bankruptcy rebuy works in blackjack and craps. (Verified live in
      browser: set bankroll to 0, rebuy button appeared, click reset to
      1000, button hid again. Blackjack additionally keeps its pre-existing
      always-visible manual reset button, unchanged.)
- [x] 375px screenshots of all three games showing full play surfaces —
      captured for blackjack (betting + in-hand), craps, and poker (start
      screen + in-hand); all confirmed scroll-free with the mobile-hide
      fix applied.
- [ ] No game-local chip/button CSS overriding the shared theme — **not
      attempted**; per-game chip/button CSS is unchanged (see R4).
- [x] Existing game tests still pass (137 Jest + 328 pytest, all green);
      `recordSession` boundaries covered for the new/changed integration
      surface (20 new Jest tests in `shared/tests/casino-profile.test.js`
      and `casino-header.test.js` covering `recordSession` accumulation,
      `onChange` firing, rebuy, and chips-mode isolation). Pre-existing
      blackjack/craps `recordSession` call sites were not newly
      unit-tested (they're unchanged, already-shipped code, not part of
      this session's diff) — noted as a real gap versus the letter of this
      criterion, not silently marked done.

## Risks

- **Service-worker staleness** shipping shared CSS/JS changes — mitigated
  by cache-version bumps; hit this directly during verification (blackjack
  and poker both served stale pre-header markup from an old cache until
  service workers were manually unregistered) — confirms the risk was real
  and the mitigation necessary, not theoretical.
- **Poker's server-managed chips** conflicting with shared-bankroll UX
  expectations — handled by the `chips: true` mode; labeled "Table chips"
  in the header to distinguish it from "Bankroll".
- **Newly discovered: craps' win/loss flash CSS (`.win-flash`/
  `.loss-flash`) is dead code** — classes and keyframes exist, JS only ever
  *removes* them, never adds them. Unrelated to this spec's diff; flagged
  separately rather than fixed here to keep this change's scope honest.

## Estimate

~4 weeks part-time: 1 week header + lobby, 1 week theme consolidation,
2 weeks mobile parity (poker is the hard one).

**Actual:** ~1 session. Came in well under estimate because R6/R7/R8 were
already done and didn't need to be built — only R1/R2/R3 (header +
rebuy) and the mobile-regression fix were genuinely new work. R4
(full chip/button consolidation) and R5 (shared card rendering) remain
and would need their own dedicated pass; do not assume they're quick
just because this spec came in early.
