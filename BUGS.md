# Codebase Bug Audit

Date: 2026-05-27
Scope: full source tree (excluding `node_modules/`, `backend/venv/`, generated/test fixtures).

Each finding lists file:line, a short description, the underlying cause, and a severity (critical / high / medium / low). Items I personally verified by reading the code are marked **[verified]**; items surfaced by subagent scans that I could not fully verify are marked **[unverified]** so the reader can apply judgment.

---

## Critical

### 1. `backend/app/poker_game.py:439-466` — `action_raise` mishandles under-min raises and resets acted set **[verified]**
- Guard: `if amount < self.min_raise and player.chips > total_needed: return False`. When `player.chips <= total_needed`, an "under-min raise" is accepted as an all-in (correct), but two things go wrong:
  - Line 443: `self.acted_this_round = {player_id}` runs **before** the all-in branch, so even an incomplete all-in (one that does not increase `current_bet`) wipes the acted set, forcing other players who already acted to act again. In standard hold'em, an under-the-min all-in does NOT reopen the action.
  - Line 456: `self.min_raise = actual_raise` after an all-in updates the min_raise to a smaller value, letting subsequent players "raise" by an amount that violates the original min raise.
- Result: chip-stack-driven exploits — a short stack can shove for a few sats and reopen action against players who had already checked behind.

### 2. `backend/app/poker_ai.py:252-255` — AI can call `action_raise` with a negative amount **[verified]**
```python
elif decision['action'] == 'all-in':
    to_call = self.game.current_bet - current.bet
    all_in_amount = current.chips - to_call
    success = self.game.action_raise(current.id, all_in_amount)
```
- When the bot's chips are less than `to_call`, `all_in_amount` is negative and is forwarded to `action_raise`. In `action_raise` (`backend/app/poker_game.py:439`), the validation `amount < self.min_raise` is true (negative is always less), and `player.chips > total_needed` becomes `chips > chips` (false) because `total_needed = call_amount + (chips - call_amount) = chips`. The raise is accepted, but the operation is semantically a call. `last_action` is mis-labelled "raise/all-in", and `acted_this_round` is reset, reopening action incorrectly.
- Fix: route to `action_call` when the bot cannot cover the call.

---

## High

### 3. `middleware.js:7` and `backend/app/main.py:107` — In-memory rate-limit store **[verified]**
- Both the Vercel edge middleware and the FastAPI backend keep auth-failure counts in a process-local `Map`/`dict`. On serverless platforms (Vercel) instances are ephemeral and there is no cross-instance state, so `AUTH_RATE_LIMIT_MAX_ATTEMPTS` is enforced per cold start, not globally. An attacker can drive failed attempts arbitrarily high by causing the platform to spin up new isolates.
- Fix: back the counter with a shared store (Redis, KV) or, at minimum, document that the limit is best-effort.

### 4. `backend/app/routers/poker.py:783-806` — `to_dict` calls `get_current_player()` twice, and that helper mutates state **[verified]**
- `PokerGame.to_dict` (`backend/app/poker_game.py:786`) does:
  ```python
  'current_player': self.get_current_player().id if self.get_current_player() else None,
  ```
- `get_current_player()` (`poker_game.py:350-366`) advances `self.current_player_index` past folded players. Calling it twice is wasteful, but more importantly, calling a state-mutating method from a serializer is fragile — any future change to the helper (e.g. logging the advancement, side effects) can leak into responses. The double-call also produces two distinct results if the state changes between calls (it cannot today, but the contract is undefined).
- Fix: cache the value: `cur = self.get_current_player(); 'current_player': cur.id if cur else None`.

### 5. `backend/app/poker_game.py:798-805` — `next_level_in` is wrong on level boundaries **[verified]**
```python
'next_level_in': max(0, hands_per_level - (self.hand_number % hands_per_level))
```
- After the 6th hand of a 6-hand level the next hand is the start of a new level, so `next_level_in` should be `0` (or "this hand is the last at this level"). The formula returns `6` because `6 % 6 == 0` and `6 - 0 == 6`. The UI then misreports that the player has another full level before blinds rise.
- Fix: `(hands_per_level - hand_number % hands_per_level) % hands_per_level`.

### 6. `backend/app/routers/analytics.py:95-109` — Rate limit ignores `TRUST_PROXY_HEADERS` **[verified]**
- `_analytics_client_key` uses `request.client.host` directly, so behind a proxy every visitor looks like the same IP. The 120/min limit then throttles *all* users together. Other modules (`backend/app/main.py:151`, `backend/app/routers/poker.py:123`) correctly honor the env flag.
- Fix: route through a shared `client_ip(request)` helper that respects `TRUST_PROXY_HEADERS`.

### 7. `stock-research/app.js:724` — `parseInt` of a stale dataset value silently produces `NaN` **[unverified]**
- `clearInterval(parseInt(overlay.dataset.heartInterval))` — if the dataset value was lost / removed / replaced by a non-numeric prefix, `parseInt` returns `NaN`, which `clearInterval(NaN)` accepts silently. The original interval keeps firing forever.
- Fix: use `Number(overlay.dataset.heartInterval)` with finite-check, or store the id in a closure rather than the DOM.

### 8. `bitcoin-chat/app.js:606` — Session id stored in `localStorage` **[verified]**
- Session ids are usable to resume conversations. Storing them in `localStorage` means any XSS, browser extension, or third-party script can read them. For a chat that may contain personal data, prefer an HttpOnly cookie issued by the backend.
- Fix: backend issues an opaque cookie; frontend never sees the id.

### 9. `shared/casino-profile.js:56-64` — Silent stats reset on corrupt JSON **[unverified]**
- `JSON.parse` failure returns `{}` (loss of all history). The next write persists `{}` plus the new session, permanently overwriting the user's stats with no warning.
- Fix: on parse error, keep the corrupt string under a `corrupt_` key (or skip the write) so the user can recover.

---

## Medium

### 10. `backend/app/main.py:341-380` — Sync DB write inside async middleware **[verified]**
- `record_request_analytics` opens a synchronous SQLAlchemy session in `finally` for every request. With SQLite (default), this serializes the event loop on a write lock. Under load the request-handling loop blocks behind the analytics writes.
- Fix: queue events and flush in a worker task, or use an async-friendly client.

### 11. `backend/app/routers/poker.py:271-297` — `save_game_state` holds the per-game lock during blocking DB write **[verified]**
- The per-game `asyncio.Lock` is acquired around the entire critical section including a synchronous SQLAlchemy commit. While the session is small, slow disk or a busy SQLite writer can keep the lock held tens or hundreds of milliseconds, throttling all subsequent actions for that game.
- Fix: serialize the snapshot, drop the lock, then write.

### 12. `backend/app/routers/poker.py:325-357` — `cleanup_old_games` DB-deletes games that may still be live in another worker **[verified]**
- The cutoff uses `updated_at < cutoff`. If two workers run, worker A may have a freshly active game in memory while worker B's `cleanup_old_games` (no in-memory presence on B) deletes the DB row because B's `updated_at` reflects the last *B-side* write. Next access on B reloads from DB and finds nothing.
- Fix: only delete rows that are both stale *and* not in any worker's in-memory map — but that map is per-process. A safer approach: don't auto-delete persisted snapshots; rely on TTL or a separate sweeper that respects a `live_until` field.

### 13. `backend/app/routers/poker.py:323-405` — `process_ai_turn_if_needed` can race with player action **[verified]**
- It is invoked from `POST /process-ai`. The per-game lock is held while it runs, which is correct — but it returns after at most one AI turn even when several bots could act before the next human turn. The client must loop, paying RTT each time and giving the human a chance to act *between* bot turns when they should not be able to.
- Fix: advance AI turns in a loop while the current player is a bot and ≥ `AI_TURN_MIN_INTERVAL_SECONDS` has elapsed, or move bot turns to a background task that batches them.

### 14. `backend/app/services/finnhub_client.py:94-96` — Fiscal-quarter mapping assumes calendar year **[unverified]**
- `quarter_months = {"1": "03-31", ...}` does not match retailers (e.g. fiscal year ending January). When merging with Polygon, mismatched dates drop the Finnhub EPS estimate.
- Fix: use the calendar-aligned `fiscal_period_end` from the upstream payload.

### 15. `backend/app/routers/admin.py:108-109` — `_iso` drops timezone info **[verified]**
- All timestamps come from `utc_now()` (naive UTC). `.isoformat()` then produces strings without a `Z` or offset; the admin frontend's `new Date(value)` parses them as **local** time.
- Fix: append `'Z'` (or call `.isoformat() + 'Z'`) consistently.

### 16. `blackjack/app.js:509` — `animateDealerTurn` is not awaited **[unverified]**
- Animation errors become unhandled promise rejections and the dealer's reveal can finish in an indeterminate UI state.
- Fix: `await animateDealerTurn()` and catch the error.

### 17. `craps/app.js:1094` — Odds payouts use `Math.floor` for fractional ratios **[unverified]**
- Place / odds bets on 5/9 (3:2) and 6/8 (6:5) are floored. Real casinos round to the nearest dollar but require even-multiples — the rule here is "you can bet any amount and you may quietly lose 1 unit on the round-down." This is acceptable if documented but should be validated against the rules block.

### 18. All three service workers (`poker/sw.js`, `blackjack/sw.js`, `craps/sw.js`) — Cache version not bumped when assets change **[unverified]**
- `CACHE_NAME = 'poker-app-v16'` etc. is hand-bumped; if an `app.js` ships without a corresponding bump, returning visitors see the previous JS until they hard-refresh.
- Fix: include an auto-bumped build hash in `CACHE_NAME` (CI step or `version` field in `package.json`).

### 19. `stock-research/app.js:165-170` — Ripple listeners added per button, never removed **[unverified]**
- When buttons are re-rendered (filter changes, search), new listeners are attached on top of the existing ones. Memory drifts upward and ripple callbacks fire multiple times.
- Fix: event-delegate from the document root, or use `addEventListener` once on a stable parent.

### 20. `bitcoin-chat/app.js:114-183` — Code block toggle relies on alternating fences **[verified]**
- An unmatched ```` ``` ```` (e.g. AI returns a trailing fence) means subsequent paragraphs are consumed into the code block until end-of-text. Cosmetic but breaks output. The final `if (codeBlock) parent.appendChild(codeBlock);` is correct, but the contents will look wrong.
- Fix: detect malformed input and close the block at the next blank line.

---

## Low

### 21. `backend/app/poker_game.py:439` — Min-raise validation strict inequality **[verified]**
- `if amount < self.min_raise and player.chips > total_needed`. If the player has *exactly* `total_needed` chips, the validation allows any tiny raise, which is the intended all-in behavior, but the boundary is a single `>` away from the all-in branch. A future refactor that flips this to `>=` would silently start rejecting legitimate all-ins. Worth a comment.

### 22. `backend/app/log_handler.py:70` — Silently swallows logging errors **[unverified]**
- If the `logs` table doesn't exist (e.g. test env before migration), the handler logs nothing and discards the message rather than degrading to stderr.

### 23. `craps/app.js:1276` — Orphan `setTimeout` for point-popup queue **[unverified]**
- IDs aren't tracked. Rapidly opening/closing modals can fire stale popups.

### 24. `backend/app/services/bitcoin_tools.py:407` — `Decimal -> float` precision drop **[unverified]**
- `btc_to_sats(float(fee_btc))` converts a Decimal-derived amount to float before scaling. Acceptable for display but unprincipled for fee math.

### 25. `backend/app/services/polygon_client.py:543` — Missing-revenue treated as zero **[unverified]**
- `.get("revenues", {})` then `latest.get("value")` returns `None` for *both* "field absent" and "field present but null", so YoY-growth callers can't distinguish "no data" from "no growth."

### 26. `poker/app.js:208` — Swipe handler dereferences `gameState?.phase` before load **[unverified]**
- Premature swipe pre-load triggers a no-op fold attempt against `gameState === null`; harmless today but masks intent.

### 27. `admin/app.js:778-784` — Dataset index lookup not bounded **[unverified]**
- After pagination, `data-analytics-index` may point past the rendered rows. The `querySelector` returns `null`; the detail row never expands and there is no log of the mismatch.

---

## Recommendations

1. The poker engine has multiple subtle correctness issues (#1, #2, #4, #5, #11, #12, #13, #21, #26). Add property-based tests around `_is_round_complete`, `_advance_phase`, side-pot splits, and tournament level transitions.
2. The in-memory rate limit / session stores (#3, #8) need a shared backend for any multi-instance deployment.
3. Make `client_ip()` a single, shared helper (#6) — multiple modules currently re-implement it with subtle drift.
4. Tighten datetime output so stored naive UTC values are serialized with an explicit UTC marker before frontend parsing (#15).
5. Add lightweight UI smoke tests for the remaining animation, cache, and dynamic-DOM findings (#16, #18, #19, #20, #23, #27).
