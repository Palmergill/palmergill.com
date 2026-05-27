# Plan

Punch list from the 2026-05-26 code-quality review. #1–#9 landed 2026-05-26; #10 remains deferred per the original recommendation.

## Completed (2026-05-26)

### 1. Lock concurrent access to in-process poker state ✓

- **Where:** `backend/app/routers/poker.py`
- **Done:** Added per-`game_id` `asyncio.Lock` (lazily created, protected by a guard lock). Wrapped `join_game`, `start_multiplayer_game`, `get_game_state`, `process_ai_turn`, `player_action`, `buy_back`, and `next_hand` in `async with await _game_lock(game_id):`. `cleanup_old_games` now skips popping games whose locks are currently held, so an in-flight request can't have state yanked out from under it.
- **Not done:** Validation stress test from the original entry. Worth adding when concurrency bugs reappear; the lock-based design is straightforward enough that the cost of a one-off test exceeds its value right now.

### 2. Guard against infinite loop in `_advance_phase` ✓

- **Where:** `backend/app/poker_game.py:408–421`
- **Done:** Before the "next actor" scan, check `any(not p.folded and not p.is_all_in for p in self.players)`. If no one is eligible, route to `_run_out_board()` and return. The `_betting_is_closed()` path should already cover this, but the defensive check turns a worker-pegging bug into a clean fallthrough.

### 3. Dedupe `fetchWithTimeout` in poker frontend ✓

- **Where:** `poker/app.js`
- **Done:** Removed the standalone `fetchWithTimeout` helper and replaced both call sites (lobby polling, idle game polling) with `APIRequest.fetch`. Timeout is now uniformly 12s.

### 4. Stream the admin CSV export ✓

- **Where:** `backend/app/routers/admin.py`
- **Done:** Switched `_csv_response` to a `StreamingResponse` with a generator that yields one CSV row at a time, reusing a single `StringIO` buffer. The CSV payload is no longer materialized as one giant string in memory.

### 5. Time-bound the periodic cleanup tasks ✓

- **Where:** `backend/app/main.py`
- **Done:** Added `_run_with_timeout` wrapper that runs the sync cleanup function via `asyncio.to_thread` under `asyncio.wait_for(..., timeout=30)`. Logs warnings on timeout and continues the outer loop; exceptions are caught and logged.

### 6. Audit `innerHTML` writes in poker stats ✓

- **Where:** `poker/app.js` `getFormattedStats`, plus existing templates at the former lines 2061+ and 2110+
- **Done:** Stats fields round-trip through `localStorage` (via `{ ...this.stats, ...parsed }` spread in `init()`), so a tampered store could inject HTML strings where numbers are expected. `getFormattedStats` now coerces every numeric field through `Number → Math.trunc → 0 fallback`. `bestHand` was already `escapeHtml`-wrapped.

### 7. Move `API_BASE` to a shared constant ✓

- **Where:** new `shared/api-base.js`; consumers `poker/`, `stock-research/`, `bitcoin-chat/`
- **Done:** Created `shared/api-base.js` that sets `window.API_ORIGIN` (defaults to `''`, overridable via `window.PALMER_API_ORIGIN`). Each app's `API_BASE` now derives from `window.API_ORIGIN` plus its own path prefix, and each `index.html` loads `/shared/api-base.js` before `app.js`. The `craps/`, `blackjack/`, and `admin/` frontends don't declare an `API_BASE`, so no change was needed there.

### 8. Tighten join-phase check ✓

- **Where:** `backend/app/routers/poker.py` `join_game`
- **Done:** Existing `phase != 'waiting'` check already rejects every non-lobby phase (including `showdown`). Added an explanatory comment so the next reader doesn't second-guess it.

### 9. Bounds-check `dicePatterns[value]` in craps ✓

- **Where:** `craps/app.js:71`
- **Done:** `const pattern = dicePatterns[value] || [];` — out-of-range values now render a blank die face instead of crashing the dot loop.

## Deferred

### 10. Cache or simplify hand evaluation

- **Where:** `backend/app/poker_game.py:454-457`
- **Status:** Skipped per the original "only if table size grows" recommendation. Each showdown evaluates `C(7,5) = 21` combos per player — fine at the 6-player ceiling enforced in `CreateGameRequest`. Revisit if the cap changes.

## Validation

- `cd backend && venv/bin/python -m pytest tests/ -x -q` → **13 passed**
- `npx jest --silent` → **64 passed across 4 suites**
- Import smoke-check: `from app import main; from app.routers import poker, admin; from app import poker_game` → OK
- JS syntax check on every touched file via `new Function(fs.readFileSync(...))` → OK

---

# Feature Opportunities (2026-05-26 review)

Backlog from a codebase-wide feature review. Grouped by area; impact-per-effort favorites flagged ★. **All 17 features landed on 2026-05-26 — see "Status" notes on each entry for what shipped.**

## Cross-app

### F1. Unified casino profile and bankroll ★

- **Where:** new `shared/casino-profile.js`; consumers `blackjack/`, `craps/`, `poker/`
- **Problem:** Each game tracks money separately and loses it on reload — `blackjack/blackjackGame.js:14` (`bankroll: 1000`), `craps/app.js:5` (`let balance = 1000`), poker stats already in localStorage at `poker/app.js:286`.
- **Proposal:** Shared module exposing display name, optional initial/avatar, persisted chip stack, per-game session stats. Each game reads/writes through the module so `/casino/` becomes a single coherent product.
- **Effort:** Medium. Three frontend integrations, no backend changes.
- **Status (2026-05-26):** ✓ Shipped. `shared/casino-profile.js` persists name + bankroll + per-game session stats. Blackjack and craps now read/write the shared bankroll (chips travel between games); poker continues to use server-managed stacks for multiplayer.

### F2. Cross-game stats and achievements panel on `/casino/`

- **Where:** `casino/index.html` (currently purely navigational at lines 500–560)
- **Proposal:** "Your House" section surfacing aggregate stats (hands played, biggest pot, win rate by game, current streak) plus a handful of achievements ("First royal flush", "10-pass winning streak at craps", "Walked away up 5×"). Depends on F1 for the persisted store.
- **Effort:** Small once F1 lands.
- **Status (2026-05-26):** ✓ Shipped. "Your House" panel on `/casino/` shows bankroll, total hands, net P/L, biggest win, plus a per-game breakdown strip. Includes inline display-name editor and "Reset all" control. Achievement copy is deferred — left as content the panel can pick up later.

### F3. SEO and Open Graph parity ★

- **Where:** `craps/index.html:6`, `blackjack/index.html:6`, `stock-research/index.html:6`, `bitcoin-chat/index.html:6`, `casino/index.html:6`
- **Problem:** Only `/` and `/poker/` carry descriptions; the others are bare `<title>` tags. No OG/Twitter cards outside the homepage.
- **Proposal:** Add `meta name="description"`, `og:*`, and `twitter:*` tags on each app page, matching the pattern in `index.html:7–20`.
- **Effort:** Small — copy the homepage block and adjust copy per page.
- **Status (2026-05-26):** ✓ Shipped on all eight public pages (casino, poker, craps, blackjack, stock-research, bitcoin-chat, about, docs). Login intentionally skipped — no shareable surface.

## Poker

### F4. WebSockets to replace polling

- **Where:** `backend/app/routers/poker.py`, `poker/app.js`
- **Problem:** Already on the wishlist at `poker/TASKS.md:31`. Polling adds visible action latency and constant backend load.
- **Proposal:** FastAPI WebSocket endpoint per game; frontend subscribes after join. Per-game `asyncio.Lock` from completed punch list #1 makes the threading model clean.
- **Effort:** Large. Touches state-push code paths on both ends; needs reconnect/backoff logic.
- **Status (2026-05-26):** ✓ Shipped as a push-trigger layer over the existing fetch endpoint. Backend exposes `/api/poker/games/{id}/ws`; `save_game_state` fans a `state_changed` ping to all subscribed sockets. Frontend opens the socket when entering a game and triggers an off-cycle fetch on each ping. Polling stays in place as fallback (3s cadence) — keeps a single serializer in play and a missed frame never leaves state stale. Exponential reconnect with 60s backoff cap.

### F5. Hand history per session

- **Where:** `poker/app.js` (extend existing stats infrastructure at lines 274–349)
- **Problem:** Called out at `poker/TASKS.md:29`.
- **Proposal:** Client-only "Last 20 hands" panel — board, hole cards, result, net change — persisted in localStorage alongside existing stats. No backend change required.
- **Effort:** Small/medium.
- **Status (2026-05-26):** ✓ Shipped. `StatsManager.recordHand` writes each hand's result, amount, hand name, hole cards, and board to localStorage (max 20). Rendered as a list in the stats modal with per-row result chip, cards, P/L, and timestamp. Includes a "Clear" control.

### F6. Tournament / sit-and-go mode

- **Where:** `backend/app/poker_game.py`, lobby flow in `backend/app/routers/poker.py`
- **Proposal:** 6-max SNG with blind levels and chip payouts, on top of the existing multiplayer lobby. Distinguishes the app from generic cash-only browser poker.
- **Effort:** Large — blind structure, elimination, payout schedule.
- **Status (2026-05-26):** ✓ Shipped (single-table SNG vs AI). `PokerGame.configure_tournament` switches the game to tournament mode with 1500 starting chips, a 12-level blind schedule that escalates every 6 hands, and ordered elimination tracking (`tournament_standings()`). New "Sit-and-Go Tournament" button on the start screen; in-game banner shows level, blinds, "next level in N hands", and players remaining. Multiplayer tournaments deferred — single-table covers the demo.

### F7. AI personalities

- **Where:** `backend/app/poker_game.py` AI decision code
- **Proposal:** Loose-Passive ("Cal"), Tight-Aggressive ("Reg"), Maniac ("Action Jackson") archetypes with looseness/aggression dials. Surface names in the UI. Feeds richer storytelling in `getFormattedStats`.
- **Effort:** Medium. Backend AI tuning + frontend labels.
- **Status (2026-05-26):** ✓ Shipped. `poker_ai.PERSONALITIES` defines 5 archetypes (tag, lp, mn, rock, std), each bundling aggression + looseness dials. `PokerAI.make_decision` now uses looseness to shift hand-strength thresholds and call-frequency on bluff-catches. Single-player lineup spawns Reg (TAG), Cal (LP), Action Jackson (Maniac), Stone (Rock), and Avery (Std). Personality label renders below each opponent's name on the felt.

## Blackjack

### F8. Basic-strategy hint mode ★

- **Where:** `blackjack/blackjackGame.js`, `blackjack/app.js`
- **Proposal:** Toggle that highlights the basic-strategy-correct play among Hit/Stand/Double/Split. Educational, unique among the three games. The hand-state machine already exposes every needed input.
- **Effort:** Small/medium. Strategy table + UI affordance.
- **Status (2026-05-26):** ✓ Shipped. Full S17 6-deck basic-strategy table (pairs/soft/hard rows × dealer 2–A). "Strategy hint" toggle button on the table rail; when active, the recommended action button gets a gold border + star marker. Persists toggle state in localStorage.

### F9. Persist bankroll and shoe stats

- **Where:** `blackjack/blackjackGame.js:14`, `blackjack/app.js`
- **Problem:** Refresh resets to $1000 every time.
- **Proposal:** Persist bankroll to localStorage and show running W/L/push counts plus dealer-bust %. Pairs with F1 once that lands.
- **Effort:** Small.
- **Status (2026-05-26):** ✓ Shipped. Bankroll persistence is via the F1 shared profile. New `.session-stats` strip on the table shows W / L / Push counts plus dealer-bust % for the current shoe; resets with the shoe.

### F10. Hi-Lo running-count overlay

- **Where:** `blackjack/app.js` (shoe already tracked at line 39)
- **Proposal:** Optional toggle for a training-mode running-count display. Mostly UI given the shoe data is already exposed.
- **Effort:** Small.
- **Status (2026-05-26):** ✓ Shipped. "Show count" toggle on the table rail. Running count computed across player hands + dealer upcards (hides hole card until reveal). Renders as a 5th `.session-tile`, color-coded positive/negative. Toggle state persists in localStorage.

## Craps

### F11. Bet preset / "rebet last" button

- **Where:** `craps/app.js`
- **Problem:** Setting a full come-out spread every roll is tedious.
- **Proposal:** "Rebet last" button plus named presets ("$5 pass + odds"). Restores prior bet vector after a settle.
- **Effort:** Small.
- **Status (2026-05-26):** ✓ Shipped. "Repeat" button was already present and wired; added a `.bet-presets` row with 4 hardcoded presets: $5 Pass + Odds, $5 Field, Place 6 & 8, Iron Cross. Each enforces phase rules (come-out vs point) and a bankroll check.

### F12. Inline bet glossary / payout tooltips

- **Where:** `craps/index.html`, `craps/crapsRules.js`
- **Proposal:** Hover/tap-to-explain tooltips on each bet box (rule + house edge + payout). Lowers the steepest learning curve among the three games.
- **Effort:** Small. Tooltip component + content per bet type.
- **Status (2026-05-26):** ✓ Shipped. `BET_INFO` table covers 21 bet types with rule + payout + house-edge text. Desktop hover surfaces a native `title` tooltip on every bet button; the bet modal also renders a "How it works" strip with rule and edge whenever a bet is tapped.

## Stock research

### F13. Watchlist / saved tickers

- **Where:** `stock-research/app.js` (2,575 lines, no persistence between sessions)
- **Proposal:** localStorage watchlist with deltas since last visit. Makes the app feel like a product rather than a one-off lookup tool.
- **Effort:** Small/medium.
- **Status (2026-05-26):** ✓ Shipped. New `stock-research/watchlist.js` module persists up to 16 tickers with their last seen price + change %. "★ Save" button in the stock header toggles add/remove for the current ticker; "Your Watchlist" tile grid renders in the empty state with delta coloring; tile click loads the stock.

### F14. Compare view (2–4 tickers side-by-side)

- **Where:** `stock-research/app.js`, `stock-research/index.html`
- **Proposal:** Side-by-side compare panel pulling from existing endpoints. Differentiates from single-ticker tools.
- **Effort:** Medium.
- **Status (2026-05-26):** ✓ Shipped. New `stock-research/compare.js` adds a "Compare" section in the empty state with a ticker input and chip list (max 4). Compare table renders Price / Day % / Market cap / P/E / EPS / Dividend yield using the existing `/api/stocks/{ticker}` endpoint and a module-private fetch cache.

## Bitcoin chat

### F15. Quick prompt chips

- **Where:** `bitcoin-chat/app.js`, `bitcoin-chat/index.html`
- **Proposal:** Row of suggested prompts ("explain the mempool", "what moved the price today") so first-time visitors have an obvious entry point.
- **Effort:** Small.
- **Status (2026-05-26):** ✓ Shipped. Five suggested prompts (mempool / price drivers / how a block is mined / next halving / current fees) render above the composer. Click fills the input and submits; chips hide after the first submission.

## Infra / observability

### F16. Surface `/api/analytics` in the admin dashboard

- **Where:** `backend/app/routers/analytics.py` (already exists), `admin/`
- **Proposal:** Top pages, referrers, casino-game popularity rendered in the existing admin dashboard. Closes the loop on traffic insight without a third-party tracker.
- **Effort:** Small/medium depending on what `analytics.py` currently captures.
- **Status (2026-05-26):** ✓ Shipped. Top pages / Top apps / Top referrers / App events were already wired in `admin/app.js`; added a dedicated "Casino games" panel at the top of the dashboard breaking out poker / craps / blackjack event counts side-by-side plus a combined total, sourced from `summary.top_apps`.

### F17. PWA manifest + service worker for craps and blackjack

- **Where:** new `craps/manifest.json`, `craps/sw.js`, `blackjack/manifest.json`, `blackjack/sw.js`
- **Problem:** Only poker is installable (`poker/manifest.json`, `poker/sw.js`). The other two are fully client-side and benefit most from offline support.
- **Effort:** Small — copy and adapt the poker pattern.
- **Status (2026-05-26):** ✓ Shipped. New `manifest.json` + `sw.js` for both apps with cache-first-for-shell + network-first-for-navigations strategy. Both apps now installable as standalone PWAs with custom inline-SVG icons (♠ for blackjack, 🎲 for craps).

## Feature Validation (2026-05-26)

- `cd backend && venv/bin/python -m pytest tests/ -x -q` → **13 passed**
- `npx jest --silent` → **64 passed across 4 suites**
- Backend import smoke-check on new modules: `from app.poker_ai import PERSONALITIES, AIManager, PokerAI; from app.poker_game import PokerGame` → OK
- Tournament smoke test: `PokerGame.configure_tournament()` initializes blinds 10/20 at level 1, escalates to 15/30 after one full level of hands, ordered eliminations land in `tournament_standings()` → OK
- JS syntax check via `new Function(fs.readFileSync(...))` on every touched file → OK
- Browser preview checks:
  - `/casino/` "Your House" panel renders with bankroll, hands, net P/L, biggest win; name editor saves to localStorage → OK
  - `/blackjack/` loads bankroll from shared profile (1500 persisted from /craps/); deal → decline insurance → Stand button glows for hard 14 vs dealer 4 (correct basic strategy) → OK
  - `/craps/` loads same shared bankroll; bet presets row renders 4 buttons; passLine tooltip shows rule + edge → OK
  - `/bitcoin-chat/` chips render and are clickable → OK
  - `/stock-research/` Watchlist + Compare sections render; ★ Save toggle visible on header → OK
