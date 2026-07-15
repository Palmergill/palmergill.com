# Bug Intake Queue

Open items use the format `- [ ] (area) description — found YYYY-MM-DD`.
Closed items are trimmed quarterly.

## High

- [ ] (backend rate limits) Auth, analytics, poker, and craps translation rate limits are still best-effort local stores unless backed by a shared service; back counters with Redis, Vercel KV, or a database table with TTL cleanup. — found 2026-05-27

## Medium

- [ ] (backend deploy) Railway persistence policy is unresolved; decide whether production must require Postgres or a durable volume instead of accepting the Docker SQLite `/data` fallback. — found 2026-05-27
- [ ] (poker API) `backend/app/routers/poker.py` duplicates client-IP parsing and trusts the spoofable leftmost `X-Forwarded-For` hop when `TRUST_PROXY_HEADERS` is enabled; use the hardened shared helper from `backend/app/main.py`. — found 2026-07-01
- [ ] (poker API) `POST /api/poker/games/{id}/buy-back` lacks a tournament guard, allowing eliminated tournament players to buy back into play and corrupt standings. — found 2026-07-01
- [ ] (craps strategy) Progression bet sizing in `craps-strategy/engine.js` bypasses legal-increment snapping after wins/losses; snap the new size through the bet rules before simulation continues. — found 2026-07-01
- [ ] (backend rate limits) Public per-IP rate-limit stores in craps, analytics, and poker prune timestamps but never evict expired IP keys, so many one-off IPs can grow memory for the life of the process. — found 2026-07-01
- [ ] (poker API) Showdown serialization reveals folded players' hole cards to state polling clients; reveal only the requesting player's cards or non-folded showdown hands. — found 2026-07-01

## Low

- [ ] (auth redirect) `safe_next_path` accepts backslash-schemed redirects against the FastAPI endpoint directly; reject any `next` value containing `\` before parsing. — found 2026-07-01
- [ ] (craps strategy) `everyRoll: false` is inert for one-roll bets because resolved stakes are zeroed before the re-arm check; either remove the flag or track one-time placement separately. — found 2026-07-01
- [ ] (craps) The `$5` floor in `legalOddsAmount` silently drops small odds bets that snap below the floor; allow one legal increment or surface that odds were not placed. — found 2026-07-01
- [ ] (frontend security) Chart.js loads from jsDelivr without SRI and is not cached for offline PWA flows; add integrity/crossorigin or vendor the file. — found 2026-07-01
- [ ] (poker API) `GET /api/poker/games/{game_id}` persists a DB snapshot on every poll even though it is read-only; skip persistence unless state changed. — found 2026-07-01
- [ ] (bitcoin chat) `_SESSION_MESSAGES` trims messages per session but never evicts sessions; add an LRU cap or timestamped sweep. — found 2026-07-01
- [ ] (auth) `GET /login/logout` is CSRF-able and clears the session cookie; keep POST and make GET confirm or remove it. — found 2026-07-01
- [ ] (admin analytics) Admin analytics summary endpoints load the full window into Python and aggregate in memory; move counts to SQL `GROUP BY` when traffic makes this slow. — found 2026-07-01
- [ ] (poker engine) Busted cash-game players can be dealt in with zero chips and occupy a live seat; skip zero-chip players at deal time. — found 2026-07-01

## Closed

- Shared nav cache version drift across poker and blackjack was resolved by bumping all shared nav stylesheet references to `?v=11`. — closed 2026-07-03
- Original 2026-05-27 audit findings not listed above were resolved by the `Fix audit bugs`, `Fix bug audit regressions`, and `bugs` commits.
- Follow-up review fixes through 2026-06-26 closed the Vercel `/api/craps/*` public-route drift, poker frontend raise-size contract bug, public analytics metadata validation, Bitcoin live-route event-loop blocking, stock compare day-change data fetching, EPS trend field drift, stale craps service-worker cache entries, Polygon zero-value earnings extraction, and poker WebSocket pre-subscribe authentication.
- (blackjack) Every completed round debited the bet regardless of outcome: `blackjack/app.js` recorded the session before persisting the round's ending balance, so its own `CasinoProfile.onChange` listener re-entered on the stale pre-round bankroll and clobbered the win. Fixed by persisting the bankroll first and adding an `isPersistingOwnBankroll` re-entrancy guard around both profile writes; added `blackjack/tests/appBankrollSync.test.js` as a regression test. Also fixed a related bug found while testing this: `CasinoProfile.setBankroll`/`getBankroll` floored to whole dollars, silently discarding the $0.50 from every 3:2 blackjack payout on a $5/$25 bet — changed to round to the nearest cent (`shared/casino-profile.js`, `shared/tests/casino-profile.test.js`). — closed 2026-07-09
- (docs) Dropped the `/README.md` link from `docs/index.html`'s source-docs list; it 404s in production (confirmed `ARCHITECTURE.md`/`DEPLOY.md` at the same root level serve fine, so this is specific to that filename) and nothing else in the page depended on it. — closed 2026-07-09
- (stock research) `initMagneticButtons` in `stock-research/app.js` now excludes buttons inside `.site-nav` so the shared hamburger button no longer shifts/ghosts under the cursor. — closed 2026-07-09
- (bitcoin chat) The manual "chat" toggle now scrolls `#chatPanel` into view on stacked (≤920px) layouts when opening, matching the existing behavior in `askChat()`. — closed 2026-07-09
- (bitcoin chat) Fixed demo-mode intent routing in `backend/app/services/bitcoin_ai.py`: `_looks_conceptual` excluded any message containing "block"/"blocks" from being treated as conceptual, so "How does mining work? Who adds new blocks..." matched the block-lookup keyword branch and returned a block data card instead of the existing canned mining explanation. Moved the conceptual check ahead of the block/latest/height branch and dropped "block" from the exclusion list. — closed 2026-07-09
- (poker) `.opponent-personality` style labels ("LOOSE-PASSIVE", "STANDARD", etc.) now truncate with an ellipsis instead of clipping mid-word ("LOOSE-PA", "STANDARI") — the parent `.opponent-name`'s `text-overflow: ellipsis` didn't apply to this nested `display: block` child, so it needed its own overflow/ellipsis rule. — closed 2026-07-09
- (repo) Deleted the orphaned `resume/Resume2026.html`; every résumé link on the site already points at `/assets/Resume2026.pdf`. — closed 2026-07-09
