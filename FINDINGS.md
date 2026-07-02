# Full-Repo Review Findings — 2026-07-01

Scope: entire first-party source tree at commit `a4ce530` — FastAPI backend (`backend/app`), Vercel edge middleware, all static frontends (admin, login, stock-research, bitcoin-chat, poker, craps, craps-strategy, blackjack, casino, shared), service workers, and deploy config (Dockerfile, railway.json, vercel.json, start scripts). Excludes `node_modules/`, `backend/venv/`, mockup folders.

Verification state: every finding below was confirmed by reading the code directly. Test suites run clean: **114/114 Jest tests pass** (poker, craps, craps-strategy, blackjack) and **34/34 backend pytest tests pass** (`backend/tests/test_security_regressions.py`).

Items still open from the prior audit in [BUGS.md](BUGS.md) are listed at the end rather than duplicated.

---

## Medium

### M1. Poker rate limiter trusts the spoofable end of X-Forwarded-For
[poker.py:131](backend/app/routers/poker.py:131) — `_client_ip` takes the **leftmost** X-Forwarded-For hop when `TRUST_PROXY_HEADERS` is on. The shared helper it duplicates ([main.py:225](backend/app/main.py:225)) was deliberately hardened to take the rightmost trusted hop, with a comment explaining that the leftmost entry is client-controlled. Consequence: on the production deployment (behind Vercel/Railway proxies) an attacker can evade the 60 req/min poker rate limit by rotating fake XFF values, or deliberately fill another IP's bucket. Fix: delete the local copy and call `app.main.client_ip`, as `analytics.py` and `craps.py` already do.

### M2. Tournament buy-back loophole resurrects eliminated players
[poker.py:757](backend/app/routers/poker.py:757) — `POST /games/{id}/buy-back` checks only phase and `chips <= 0`; it has no `game_type` guard. In a tournament, an eliminated player can buy back 1,000 chips between hands and re-enter play (`_eligible_player_indices` keys off `chips > 0`). Their id also stays in `tournament["eliminated"]`, so [`tournament_standings`](backend/app/poker_game.py:205) lists them twice (once as a survivor, once in the eliminated tail) and every rank below is shifted. Fix: reject buy-back when `game.tournament` is set.

### M3. Craps-strategy progressions bypass legal-increment snapping
[engine.js:491](craps-strategy/engine.js:491) — `applyProgressions` presses by `size + max(base, round(profit))` and doubles on loss, with no re-snap to the bet's legal increment. Example: $6 place-6 wins $7 → next bet is $13, which `snapAmount` would never allow ($6 units), and `resolvePlaceBetWins` then floors the payout (`floor(13·7/6) = $15` instead of a legal $12→$14). Press-on-win strategies for place 4/5/6/8/9/10 therefore simulate slightly worse (or just different) results than any real table would allow. Fix: run the new size through `CrapsStrategy.snapAmount(type, newSize, baseUnit)` when applying progressions (requires exposing baseUnit or a snap callback to the engine).

### M4. Public per-IP rate-limit stores never evict keys
[craps.py:22](backend/app/routers/craps.py:22), [analytics.py:21](backend/app/routers/analytics.py:21), [poker.py:111](backend/app/routers/poker.py:111) — each store prunes old *timestamps* per key on access, but keys themselves are never deleted (poker's is even a `defaultdict` that materializes a key per lookup). These endpoints are unauthenticated, so a scanner or botnet sweeping from many IPs grows process memory without bound for the life of the container. `main.py`'s auth store shows the intended pattern (it pops empty keys); the public stores also need periodic sweeping of expired keys — e.g. from the existing cleanup loops in `main.py`.

### M5. Showdown serializes every player's hole cards, including folded ones
[poker_game.py:788](backend/app/poker_game.py:788) — `to_dict` uses `show_cards = (for_player == p.id or phase == 'showdown')`. At showdown all hands go over the wire — including players who folded pre-flop. In multiplayer games this leaks real strategic information (opponents learn what you folded) to anyone polling the state endpoint, even though the UI may not display it. Fix: at showdown, reveal only non-folded players (`show_cards = for_player == p.id or (phase == 'showdown' and not p.folded)`).

---

## Low

### L1. Backend `safe_next_path` accepts backslash-schemed redirects
[main.py:396](backend/app/main.py:396) — Python's `urlsplit` leaves `\` in the path, so `next: "/\\evil.com"` passes the netloc/scheme checks and is echoed as `redirect`. Browsers treat `\` as `/` in URLs, so `location.assign("/\\evil.com")` navigates to `https://evil.com`. In production this is mitigated twice (Vercel middleware handles `/login/session` with an origin check, and [login/app.js:8](login/app.js:8) validates via `new URL`), so it is only reachable against the FastAPI endpoint directly (local dev, or the Railway hostname). Fix for defense in depth: reject any `next` containing `\` before parsing, matching the middleware's `new URL`-based check.

### L2. `everyRoll: false` is inert in the craps-strategy engine
[engine.js:203](craps-strategy/engine.js:203) — one-roll bets are zeroed on every resolution, so the `!state.oneRoll[bet.type]` re-arm condition is always true on the next placement; the `everyRoll` gate can never suppress a re-bet. A strategy that says "bet the field once" still bets it every roll. Either remove the flag from the vocabulary (strategy.js, backend schema, AI prompt) or track "already placed once" separately from the live stake.

### L3. `$5` floor in `legalOddsAmount` silently kills small odds bets
[crapsRules.js:135](craps/crapsRules.js:135) — amounts under $5 always return 0. A $5 pass-line bet with 1× odds on point 5/9 requests $5, gets floored to the $2 increment → $4 → under the floor → **no odds at all**. Table-minimum players with low multipliers simulate as flat-only without any signal to the user. Consider dropping the floor to one increment, or surfacing "odds not placed" in the UI.

### L4. `site-nav.css` version drift across apps
[poker/index.html](poker/index.html) and [blackjack/index.html](blackjack/index.html) pin `/shared/site-nav.css?v=9` while craps, craps-strategy and their own service workers reference the same nav *JS* at `?v=10` (craps pins CSS `v=10`). The `?v=` only busts caches, so returning visitors on poker/blackjack can keep a stale cached stylesheet after nav changes. Bump the two stragglers (HTML + matching sw.js entries).

### L5. Chart.js CDN: no SRI hash, and broken offline
[craps-strategy/index.html:23](craps-strategy/index.html:23), plus stock-research, bitcoin-chat, admin — `chart.umd.min.js` is loaded from jsDelivr with no `integrity` attribute, so a CDN compromise executes arbitrary script on every app including the authenticated admin dashboard. Separately, the PWAs' service workers only cache same-origin assets, so an offline launch renders the shell but throws `Chart is not defined` at results time. Add `integrity` + `crossorigin`, or vendor the file (which also fixes offline).

### L6. Read-only poker GET persists a DB snapshot on every poll
[poker.py:675](backend/app/routers/poker.py:675) — `GET /games/{game_id}` calls `save_game_state_deferred` even though nothing changed, so every polling client rewrites the full game payload row (per poll, per player). With WS-assisted polling this is a steady write load on SQLite for zero benefit. Skip persistence on GET, or persist only when `hand_number`/state version actually changed.

### L7. Bitcoin chat session history never evicts sessions
[bitcoin_ai.py:573](backend/app/services/bitcoin_ai.py:573) — `_SESSION_MESSAGES` trims each session to 12 messages but never drops sessions. Only the authenticated model path writes to it, so growth is slow, but it is an unbounded dict in a long-lived process. Add an LRU cap or timestamped sweep.

### L8. Logout is a CSRF-able GET
[main.py:564](backend/app/main.py:564) — `GET /login/logout` clears the session cookie, so any third-party page can log the admin out via an `<img>` tag. Nuisance-level; keep the POST variant, make GET render a confirmation or drop it.

### L9. Admin analytics aggregation loads the full window into Python
[admin.py:389](backend/app/routers/admin.py:389) — `/analytics/summary`, `/timeseries`, and `/error-groups` do `.all()` over up to 90 days of events and aggregate in Python. Fine at current traffic; will degrade into multi-second admin loads if request analytics grow. Move counts to SQL `GROUP BY` when it starts to hurt.

### L10. Busted players are dealt in with $0 in cash games
[poker_game.py:249](backend/app/poker_game.py:249) — non-tournament `start_hand` deals cards to zero-chip players and marks them all-in via `_post_blind(min(blind, 0))`. They can't win anything (total_bet 0 never reaches a side-pot tier) but they occupy a seat and appear live at showdown. Harmless with the buy-back flow, but skipping `chips == 0` players at deal time would be cleaner.

---

## Notes / accepted trade-offs (no action expected)

- **Poker shuffling uses `random.shuffle`** (Mersenne Twister, [poker_game.py:53](backend/app/poker_game.py:53)) — fine for a free entertainment game; would be unacceptable for real stakes.
- **Poker WS notifications are per-process** ([poker.py:46](backend/app/routers/poker.py:46)) — in a multi-worker deployment, subscribers on worker B don't hear mutations on worker A. Clients fall back to polling, so this degrades gracefully.
- **Hardways work on come-out rolls** in the craps-strategy engine — documented deliberate choice ([engine.js:249](craps-strategy/engine.js:249)); real casinos default them off.
- **Don't-pass "max" odds use the 3-4-5× table on the lay stake** rather than lay-to-win sizing — a simplification, documented behavior.
- **Seed `0` silently means "auto"** — the seed input allows `min="0"` ([index.html:62](craps-strategy/index.html:62)) but `isPositiveInt(0)` fails in [strategy.js:325](craps-strategy/strategy.js:325), so 0 falls through to the derived seed.
- **Failed-auth requests never reach analytics** — the auth middleware short-circuits before the analytics middleware, so 401s from protected paths aren't in the dashboard (they are counted in the auth-failure store).

## What looked good

- **XSS discipline is consistent**: admin, poker, craps, craps-strategy and blackjack all escape interpolated data (including attribute positions); bitcoin-chat renders model output through a DOM-based mini-markdown that only creates `https?://` links; player names are validated server-side too.
- **Auth stack is thoughtful**: HMAC session tokens with an optional dedicated signing secret, constant-time comparisons on both edge and origin, proxy-aware client IPs in `main.py`, login redirect validation at three layers, rate-limited sign-in.
- **Analytics ingest is defensive**: metadata size/depth/key caps, sensitive-key redaction, CSV formula-injection neutralization on export, bounded write queue off the event loop.
- **The craps-strategy money model is coherent**: `balance`/`onFelt` invariant is documented and consistently applied; payout tables in `crapsRules.js` are correct (verified against standard odds); expected-edge accounting matches per-resolution house-edge definitions.
- **Poker concurrency is handled**: per-game asyncio locks, versioned snapshot persistence that can't roll state backwards, deferred DB flushes off the lock.
- Repo hygiene: build artifacts, DBs, logs and venvs are all gitignored; security regression tests exist and pass.

---

## Carried over from BUGS.md (still open)

1. **[High] Shared rate limits are per-process, not global** — all limiter/session stores are in-memory; a multi-instance deployment or isolate churn on Vercel weakens them. Needs Redis/KV or a DB table.
2. **[Medium] Railway persistence policy unresolved** — the Docker image defaults to SQLite at `/data`; if Railway isn't attached to a volume or Postgres, poker snapshots, analytics, and logs die with the container.
