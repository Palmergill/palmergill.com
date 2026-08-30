# Bug Intake Queue

Open items use the format `- [ ] (area) description — found YYYY-MM-DD`.
Closed items are trimmed quarterly.

## High

- [ ] (backend rate limits) Auth, analytics, poker, and craps translation rate limits are still best-effort local stores unless backed by a shared service; back counters with Redis, Vercel KV, or a database table with TTL cleanup. — found 2026-05-27

## Medium

- [ ] (backend deploy) Railway persistence policy is unresolved; decide whether production must require Postgres or a durable volume instead of accepting the Docker SQLite `/data` fallback. — found 2026-05-27

## Low

- [ ] (fantasy API) Three fantasy endpoints have no caller on the site, and two of them were found 500ing only because someone looked: `GET /api/fantasy/trending` (fixed 2026-08-22), `GET /api/fantasy/games/{id}/lines/history` (fixed 2026-08-30), and `POST /api/fantasy/chat`, whose panel moved to the members-only league hub in the dashboard redesign so the demo-mode local router built for spec 16 R16 is now unreachable through the UI. Decide as one question whether these are public API surface worth keeping and testing, or dead code to delete. — found 2026-08-22, widened 2026-08-30
- [ ] (repo) `fourth-and-fortune-kickoff.html` is a tracked deck at the repository root rather than under a directory; move it under `fantasy/` or `docs/`. — found 2026-08-22
- [ ] (fantasy) `formatAsOf` is duplicated between `fantasy/format.js` and `fantasy/league/format.js`. Per-page format modules are the deliberate convention (`formatPoints`, `sparkline`, `injuryBadge` are duplicated the same way), so this is only worth revisiting if a genuinely shared module ever appears. — found 2026-08-22
- [ ] (frontend offline) Chart.js now has SRI, but the CDN script is still unavailable when craps strategy or stock research starts fully offline; vendor the pinned script if first-load offline support becomes a requirement. — found 2026-07-01
- [ ] (admin analytics) Admin analytics summary endpoints load the full window into Python and aggregate in memory; move counts to SQL `GROUP BY` when traffic makes this slow. — found 2026-07-01

## Closed

- The 2026-08-30 fantasy review closed three findings (`reviews/2026-08-30-fantasy.md`).
  (1) `GET /api/fantasy/players/search` ordered a substring match over the whole
  Sleeper catalog alphabetically, so "Allen" returned five first-name Allens and
  never Josh Allen inside the dashboard's 8-result limit, and "Hill" returned Andy
  Phillips but no Tyreek Hill; it now ranks on a word-boundary match then
  season-long projected points, and escapes LIKE wildcards.
  (2) The market board's `partial_pairs` caveat only fired when *half* a category
  was quoted, so a category with no market at all was silently dropped from the
  implied total while the projection still counted it — 23 of 38 RBs scored on
  rushing alone with no warning, making the Edge column read as market
  disagreement when it was missing data. Added `missing_pairs`/`edge_is_qualified`
  with an asymmetric per-position expectation, distinct copy for the two states,
  and a marked Edge cell.
  (3) `_consensus_price` was defined twice in `fantasy_data.py`; the later
  1-argument definition shadowed the earlier 3-argument one, so
  `GET /api/fantasy/games/{id}/lines/history?market=h2h` raised a TypeError on
  every call. Renamed to `_consensus_price_for_outcome` and delegated to the
  probability-space consensus; contract test now walks all three markets. This is
  the second dead-endpoint 500 found this way after `/trending` — see the open
  item below. — closed 2026-08-30

- The 2026-08-23 complete-project review closed fail-open schema migrations/readiness, member-session revocation, 24-hour stale stock quotes, missing live company profiles, immutable unversioned PWA manifests, and release-version drift. Regression coverage was added for each production-only path. — closed 2026-08-23
- Reconciled the July intake against the implementation: shared hardened client-IP parsing, tournament buy-back guards, legal progression snapping, expired rate-limit key eviction, folded-card privacy, backslash redirect rejection, one-roll placement state, small legal odds, read-only poker polling, bounded chat-session LRU storage, POST-only logout, and zero-chip deal filtering were already shipped and are no longer listed as open. — closed 2026-08-23
- (fantasy API) `GET /api/fantasy/trending` returned a 500 on every call: the route's `-> Dict[str, List[Dict[str, Any]]]` return annotation is used by FastAPI as the response model, but the body echoes `kind` back as a string. Nothing on the site called the route, so it failed silently since it was written. Annotation widened to `Dict[str, Any]`; regression test in `backend/tests/test_fantasy_api.py`. — closed 2026-08-22
- (backend) Naive-UTC timestamps were serialized without a `Z` outside the draft-order game, so `new Date()` parsed them as local time. Worst case was the rankings board: `formatSavedAt` clamps negative ages to zero, so every board read "Saved just now" for the first ~5 hours in US Central. Added `iso_utc` beside `utc_now` in `backend/app/database.py` and routed `fantasy_rankings_board.py`, `fantasy_league_data.py`, `fantasy_data.py` and the admin log rows through it; `draft_order_game._iso_utc` and `admin._iso` now delegate to it rather than reimplementing it. Regression tests walk whole response payloads so a newly added timestamp field is covered too. — closed 2026-08-22
- (casino PWAs) Service-worker `STATIC_ASSETS` drifted from the versions the pages request, so those assets were never actually precached: `/shared/casino-theme.css` (pages v=3, workers v=2) across poker/craps/blackjack/craps-strategy, plus `blackjack/style.css` (v=15 vs v=13), `craps/style.css` (v=28 vs v=26) and `craps-strategy/style.css` (v=3 vs v=2). This is the third time this drift has shipped. Realigned every worker and added `shared/tests/asset-versions.test.js` to fail the build on any future mismatch. — closed 2026-08-22
- (high card flush) `da64cb7` changed `app.js` without bumping its `?v=1`, so the stale-while-revalidate worker served the old script on the first load after deploy and the dealer-reveal fix appeared only on a second visit. Bumped to `?v=2` in both the page and the worker. — closed 2026-08-22
- (admin) The Members metric tiles were computed from the filtered query, so filtering to "active" made the Inactive tile read 0 as though no deactivated accounts existed. `total`/`active`/`inactive` are now roster-wide and a new `matched` field carries the filter count for the "N of M" status line. — closed 2026-08-22

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
