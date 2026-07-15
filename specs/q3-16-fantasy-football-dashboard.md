# Spec 16 — Fantasy Football Dashboard

- **Quarter:** Q3 2026 (Jul–Sep), phases 3–4 spilling into early Q4
- **Status:** in progress — P1–P4 implemented (data, dashboard UI, betting, chat); awaiting live API keys (OpenAI, Odds) for full production verification
- **Depends on:** Spec 4 (backend test baseline, shipped); Spec 11 (backend
  hardening) is complementary but not blocking
- **Areas:** `fantasy/` (new), `backend/app/routers/fantasy.py` (new),
  `backend/app/services/fantasy_*.py` (new), `backend/app/database.py`,
  `backend/app/main.py`, `shared/site-nav.js`, `index.html`, `package.json`

## Summary

A league-agnostic NFL fantasy football dashboard at `/fantasy/`: weekly and
seasonal rankings, point projections, betting context (game lines, player
props, season futures — with line-movement history), and an LLM chat grounded
exclusively in the site's own collected data. All sources are free-tier;
everything fetched is persisted as timestamped snapshots so history
(projection drift, line movement, rank changes) accumulates from day one.

## Background / current state

- The site has an established "collect free data into SQLite, serve cached,
  demo mode for anonymous visitors" pattern: `stock_data_client.py`
  (DB-backed TTL cache), `DEMO_PATH_PREFIXES` in `main.py` (listed prefixes
  get `request.state.demo_mode = True` instead of 401).
- Background work is asyncio loops started in `lifespan()` in `main.py`,
  each iteration wrapped in a timeout guard. There is no external cron.
- The LLM pattern to clone is `backend/app/services/bitcoin_ai.py`: OpenAI
  Responses API via raw `urllib`, `SYSTEM_PROMPT` + `TOOL_SCHEMAS` +
  `TOOL_HANDLERS`, tool loop capped at 6 calls, keyword topic-scoping,
  in-process LRU session store, HttpOnly session cookie set in the router.
- SQLAlchemy models live in `database.py`; `Base.metadata.create_all` on
  startup creates new tables automatically, so no migration code is needed
  for net-new tables.
- Frontends are static dirs with no build step; nav items live in
  `shared/site-nav.js`, homepage cards in `index.html`, API origin from
  `shared/api-base.js`.
- It is July 2026; the NFL season starts in September. The design leans on a
  2025-season backfill so every view is real and demoable before Week 1.

## Goals

1. One page answers "who do I start this week?" — rankings + projections by
   position, refreshed automatically.
2. Betting context lives next to fantasy context: game lines, featured
   player props, season futures — with movement over time, not just current
   numbers.
3. Historical snapshots accumulate from day one; the data gets more
   interesting every week the collector runs.
4. Chat answers fantasy questions using only the collected data, in the
   bitcoin-chat mold.
5. Free-tier only; The Odds API credit budget is explicit and enforced in
   code.

## Non-goals

- No league integration (no Sleeper/ESPN/Yahoo login, rosters, matchups,
  waivers). League-agnostic only.
- No betting advice, bet tracking, or EV calculators — odds are displayed as
  information.
- No custom projection model; we aggregate and store others' projections.
- No live in-game scoring or streaming updates; collector cadence is hours,
  not seconds.
- No paid API plans. If a free source dies, the feature degrades visibly
  rather than getting a budget.

## Requirements

### Data collection & persistence

- **R1. Sleeper players sync:** nightly fetch of the full player dump
  (`api.sleeper.app/v1/players/nfl`, ~5MB, once/day per Sleeper's guidance)
  upserts `ff_players` including cross-IDs (`gsis_id`, `espn_id`,
  `yahoo_id`) — this is the primary free ID crosswalk between sources.
- **R2. NFL state:** `/v1/state/nfl` (season, week, season_type) polled
  hourly; drives all "current week" logic and collector cadence.
- **R3. Projections:** weekly projections snapshotted from Sleeper's
  undocumented `api.sleeper.com/projections/nfl/{season}/{week}` behind a
  source-adapter interface with response-shape validation; FantasyPros
  (free prototype key, optional) and the ESPN hidden fantasy API are
  pluggable fallback adapters. Every fetch is a new snapshot row set, never
  an overwrite.
- **R4. Rankings:** FantasyPros ECR (weekly + preseason) when
  `FANTASYPROS_API_KEY` is set; otherwise a derived ranking computed from
  projection snapshots (sort by projected points within position), so the
  rankings UI never depends on the optional key.
- **R5. nflverse:** schedules weekly; weekly player stats (actuals) Tuesdays
  in-season; injuries + depth charts daily in-season. One-time backfill of
  the 2025 season populates the app with real data during the offseason.
- **R6. The Odds API:** game lines (h2h/spreads/totals) snapshotted 3×/week;
  season futures (Super Bowl + conference winners) weekly; player props for
  up to 4 featured games, ≤5 markets, 2×/week. All rows carry `fetched_at`
  so movement is a query, not a feature.
- **R7. Run log + credit guard:** every collector run writes an
  `ff_collection_runs` row (job, season/week, status, rows written, credits
  used, error detail). Month-to-date Odds API spend is summed from this
  table before any call; jobs skip with a logged `skipped` row when the
  projected cost would exceed `ODDS_API_MONTHLY_BUDGET` (default 450 of the
  500 free credits).
- **R8. Manual refresh:** `POST /api/fantasy/admin/refresh?job=`
  (admin-authed, same gate as `/api/admin/*`) triggers any single job on
  demand — needed for offseason development and deliberate,
  credit-conscious props pulls.
- **R9. Trending:** Sleeper trending adds/drops snapshotted daily.

### Dashboard

- **R10. Main view:** current-week rankings table (position filter
  QB/RB/WR/TE/K/DST + FLEX, PPR/half/standard scoring toggle, sortable),
  games strip with latest lines, trending adds/drops, and "as of" staleness
  stamps sourced from the collection-run log.
- **R11. Player detail:** clicking a player opens a panel with bio/team/
  injury status, current rank + projection with week-over-week and
  intra-week movement (sparkline), last 5 games of actual stats, any
  collected props for them, and recent articles about them (ESPN player
  news via the stored espn_id, fetched lazily on first view and cached
  in ff_meta for 6h — never snapshotted wholesale).
- **R12. Props & futures:** props board showing featured games with
  per-market tables (best line per market per book) and movement vs. the
  first snapshot of the week; futures table with top ~15 outcomes per
  market and price history on demand.
- **R13. Offseason behavior is explicit, not broken:** when `season_type`
  is off/pre, the page defaults to season-long rankings for the upcoming
  season (Sleeper's full-year projections, stored as week 0) with a banner
  ("showing season-long rankings for the upcoming 2026 season"), and
  futures (live year-round) lead the page. If no season-long snapshot has
  been collected yet, fall back to the most recent snapshot (e.g. the last
  completed season's final week).

### Chat

- **R14. Endpoint:** `POST /api/fantasy/chat` clones the bitcoin chat
  contract (message/session → answer/tools_used/data/warnings, HttpOnly
  `pg_fantasy_session` cookie). Tools read only the local DB — the model
  can never trigger an external fetch, so chat can't burn Odds API credits.
- **R15. Guardrails:** topic-scoped to NFL fantasy football + the collected
  betting data; refuses other sports/topics; every numeric claim comes from
  a tool result and is attributed with its week/source/as-of time; standing
  framing that odds are informational, not betting advice.

### Demo mode

- **R16.** `/api/fantasy` and `/fantasy` join `DEMO_PATH_PREFIXES`. Read
  endpoints serve the same real DB-cached data in demo mode (it's free
  public data); demo chat answers via a deterministic local router (no
  OpenAI spend), like `bitcoin_ai.answer_demo_chat`. A small fixture
  dataset covers the empty-DB fresh-clone case.

## Technical design

### Data model (`database.py` additions, all tables prefixed `ff_`)

- `ff_players` — Sleeper ID as canonical PK; name + normalized
  `search_name` (indexed), team, position, status, injury_status, and
  cross-IDs (`gsis_id` indexed, `espn_id`, `yahoo_id`).
- `ff_collection_runs` — job, source, season, week, started/finished,
  status (`success|partial|error|skipped`), rows_written, credits_used,
  error detail. The run log is both observability and the credit-budget
  source of truth.
- Snapshot tables, all carrying `run_id` FK + `fetched_at` (indexed):
  `ff_projections` (per player/source/week: pts by scoring format +
  component `stats_json`), `ff_rankings` (source, scoring, position, rank,
  ecr/tier), `ff_odds_snapshots` (game lines by bookmaker/market/outcome),
  `ff_prop_snapshots` (player props; keeps `player_name_raw` and a nullable
  `player_id`), `ff_futures_snapshots`, `ff_trending_snapshots`.
- Upsert tables: `ff_games` (nflverse game_id PK, teams, kickoff, scores,
  matched `odds_event_id`), `ff_player_stats` (actuals, unique per
  season/week/player), `ff_meta` (key/value: NFL state cache, per-job
  next-due schedule, Odds API `x-requests-remaining`).
- **Snapshot keying convention:** "latest" = rows for the newest successful
  run for that (job, season, week, source) — one indexed lookup on the run
  log, no `MAX(fetched_at)` group-bys. Movement queries filter a snapshot
  table by (season, week, …) ordered by `fetched_at`.
- **ID mapping:** Sleeper ID is canonical. nflverse joins on `gsis_id`
  (present in Sleeper's dump). The Odds API returns only display names, so
  props match via normalized name (lowercase, strip punctuation and
  Jr/Sr/II–IV) scoped to the two teams in that event; unmatched names
  persist with NULL `player_id` so no data is dropped, and the admin
  summary lists them. Fallback if the crosswalk proves gappy: one-time
  import of the dynastyprocess `db_playerids.csv` (documented, not built).

### Collection (`services/fantasy_collector.py` + per-source clients)

- Thin urllib clients per source (`fantasy_sleeper.py`,
  `fantasy_nflverse.py`, `fantasy_odds.py`, optional
  `fantasy_fantasypros.py`); `fantasy_collector.py` owns run-log
  bookkeeping, upserts, and scheduling.
- One lifespan task beside the existing ones: a 15-minute tick reads NFL
  state and a per-job next-due schedule persisted in `ff_meta` (so
  redeploys don't re-run everything), then runs due jobs through the
  existing timeout-guard pattern. In-season vs offseason cadences per
  R1–R9 (e.g. projections 2×/day Tue–Sun in-season, weekly offseason;
  odds_props Thu + Sun mornings in-season, off otherwise).
- **Odds API credit budget** (free tier 500/mo; cost = markets × regions
  per call, `regions=us`; the `/events` list is free): lines 3 credits ×
  3/wk ≈ 39/mo; futures 3 keys × 1/wk ≈ 13/mo; props 5 markets × 4 games ×
  2/wk ≈ 172/mo. **Total ≈ 224/mo**, guarded at 450. Featured games =
  primetime slots plus tightest spreads from the latest lines snapshot.
- **Failure handling:** a job failure writes an `error` run row and the
  loop moves on; the API serves the last successful snapshot with its
  `fetched_at`; the UI shows a stale badge past 2× expected cadence. Shape
  validation on the undocumented Sleeper endpoints marks bad responses
  `error` and falls through the adapter chain.
- **Env additions** (`backend/.env.example`): `ODDS_API_KEY`,
  `ODDS_API_MONTHLY_BUDGET=450`, `FANTASYPROS_API_KEY` (optional),
  `FANTASY_CHAT_MODEL`, `FANTASY_FEATURED_GAMES=4`. The collector runs
  unconditionally (decision 2026-07-15: no enable flag); per-job next-due
  timestamps in `ff_meta` keep restarts and local dev from hammering
  sources, and odds jobs self-skip without `ODDS_API_KEY`.

### API surface (`routers/fantasy.py`, prefix `/api/fantasy`)

`GET /state`, `GET /dashboard` (one-call summary: top-8 per position, this
week's games + lines, trending, biggest line moves, as-of stamps),
`GET /rankings` (`?season&week&position&scoring&source`, `&history=1` for
rank series), `GET /projections`, `GET /players/search`,
`GET /players/{id}`, `GET /games` + `GET /games/{id}/lines/history`,
`GET /props` + `GET /props/history`, `GET /futures` +
`GET /futures/history`, `POST /chat`, `POST /admin/refresh`. Pydantic
request/response models throughout, per `routers/bitcoin.py` conventions;
all GETs are plain DB reads identical in demo and authed modes.

### LLM chat (`services/fantasy_ai.py` + `fantasy_tools.py`)

- Structural clone of `bitcoin_ai.py`: system prompt scopes the assistant
  to the site's collected fantasy + odds data, requires as-of attribution
  on every number, and forbids betting-advice framing; keyword topic guard
  (`_is_fantasy_related`, plus player-name hits via a `search_name` DB
  lookup); non-streaming; ≤6 tool calls; LRU sessions; local deterministic
  router when no `OPENAI_API_KEY` or in demo mode.
- Tools (strict schemas, pure DB reads, row-capped so each result stays
  ≈≤2KB JSON): `get_nfl_state`, `search_players`, `get_player_card`,
  `get_rankings`, `compare_players`, `get_player_props`, `get_game_lines`,
  `get_futures`, `get_trending`.

### Frontend (`fantasy/`)

`index.html`, `style.css`, `app.js` + `rankings.js`, `props.js`, `chat.js`
(multi-file like `stock-research/`). Warm light theme via shared tokens; no
build step; sparkline/movement charts drawn dependency-free (reuse the
craps client-side chart approach). Layout top to bottom: week header with
offseason banner → rankings table → player slide-over panel → games/lines
strip → props board (featured-game tabs) → futures section → chat panel
with suggested prompts. Wiring: nav item in `shared/site-nav.js`, homepage
card in `index.html`, `/fantasy` added to the path-prefix lists and local
static mounts in `main.py`, `fantasy/tests` added to jest roots in
`package.json`.

### Testing

- **pytest:** collector clients with monkeypatched urllib returning
  recorded fixture payloads (no network, per convention); snapshot
  semantics (two runs → two sets, "latest" = newest successful run);
  credit-guard skip behavior; name-matching (suffixes, initials,
  unmatched → NULL retained); endpoint contract tests in the
  `test_api_contracts.py` style; chat topic guard + tool loop with a
  stubbed model response; demo path never touches OpenAI.
- **Jest:** rankings sort/filter, movement-arrow computation, odds
  formatting (American odds, spread signs), chat rendering — jsdom as in
  existing suites.

## Acceptance criteria

- [ ] Collector runs for a week unattended; `ff_collection_runs` shows the
      scheduled cadence with no crash-looping; Odds API month-to-date spend
      is visible and under budget.
- [x] Read API (`/state`, `/dashboard`, `/rankings`, `/projections`,
      `/players/*`, `/trending`, `/admin/refresh`) serves collected data;
      verified end-to-end against live Sleeper (P1).
- [x] Rankings table renders the current week (or 2025 backfill in
      offseason) with position/scoring filters (P2; verified desktop +
      mobile against live data). Player slide-over + trending panels ship
      alongside it.
- [ ] Player panel shows projection movement across ≥2 intra-week
      snapshots once two collector runs have occurred.
- [x] Odds API client + credit guard + lines/props/futures jobs and read
      endpoints (`/games`, `/props`, `/futures` + histories) shipped (P3);
      credit-budget skip, event↔game matching, and prop name-matching
      (unmatched → NULL retained) covered by tests. Betting UI (game-lines
      strip, props board, futures) verified with fixture data.
- [ ] A game line snapshotted Tuesday and Sunday shows movement in the
      games strip and the history endpoint. *(needs a live ODDS_API_KEY +
      two in-season snapshots to confirm end-to-end.)*
- [x] Props map returned player names to Sleeper IDs via team-scoped
      normalized matching; unmatched names are stored with a NULL player_id
      (verified against fixture data with real names incl. "A.J. Brown").
- [x] Chat (P4) answers rankings/futures/player/props from tool data with
      as-of attribution and a "not betting advice" note; refuses off-topic
      questions; demo chat works with no `OPENAI_API_KEY` (local router).
      The OpenAI tool-loop is unit-tested with a stubbed model; a live key
      is still needed to confirm the model-backed path end-to-end.
- [ ] Fresh clone with empty DB and no keys: page loads on fixture data
      with no errors.
- [ ] All pytest + Jest suites green; new endpoints covered in contract
      tests; README/ARCHITECTURE updated.

## Risks

- **Undocumented Sleeper endpoints vanish or change shape** — adapter
  interface with shape validation, FantasyPros/ESPN fallbacks, and derived
  rankings keep the UI alive; already-collected snapshots are unaffected.
- **Season starts in September** — 2025 nflverse backfill makes every view
  demoable now; R13 offseason banner; futures lead the page until Week 1.
- **Odds API credit exhaustion** — enforced monthly guard from the run
  log, `x-requests-remaining` tracking, props scoped to featured games,
  chat cannot trigger external calls.
- **Player-name mapping across sources** — Sleeper's built-in cross-IDs
  for nflverse; team-scoped normalized matching for props; NULL-mapped
  rows retained + admin surface; dynastyprocess crosswalk as fallback.
- **SQLite growth on the Railway volume** — snapshot rows are small, but
  add a retention job (thin odds snapshots older than ~2 seasons) to the
  P3 checklist rather than discovering it later.

## Estimate

~9–10 weeks at 15 hrs/week; each phase independently shippable:

- **P1 — Data foundation (~3 wks):** models + run log, Sleeper
  players/state/trending, projections adapter + fallback interface,
  nflverse schedule/stats + 2025 backfill, collector loop + admin refresh,
  read endpoints, pytest suite. Ships a working API with real data.
- **P2 — Dashboard UI (~2–2.5 wks):** `fantasy/` page (header, rankings,
  player panel, games strip), nav + homepage card, demo fixtures, Jest
  tests. Target: live before NFL Week 1 (early Sep).
- **P3 — Betting layer (~2 wks):** Odds API client + credit guard,
  lines/futures/props jobs, event↔game matching, props/futures/movement UI.
- **P4 — Chat (~2 wks):** `fantasy_ai.py`/`fantasy_tools.py`, guardrails,
  local demo router, chat panel, chat tests.
