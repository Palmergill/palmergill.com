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
