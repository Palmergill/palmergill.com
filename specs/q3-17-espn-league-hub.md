# Spec 17 — ESPN League Hub

- **Quarter:** Q3 2026 (Jul–Sep)
- **Status:** in progress — P1–P4 implemented; model-backed overview still needs a live `OPENAI_API_KEY`
- **Depends on:** Spec 16 (fantasy data, player crosswalk, chat plumbing), site member accounts
- **Areas:** `fantasy/league/`, `backend/app/services/fantasy_league_*.py`,
  `backend/app/routers/fantasy_league.py`, `backend/app/services/fantasy_ai.py`,
  `backend/app/services/fantasy_tools.py`, `backend/app/database.py`,
  `backend/app/main.py`, `middleware.js`

## Summary

A members-only hub at `/fantasy/league/` for ESPN league 225965: historical
and current standings, seven-method power rankings, weekly scoreboards, team
results, roster snapshots enriched with the site's projections/rankings/props,
and context-grounded team overviews and chat. ESPN is a keyless collection
source; page loads read only the local database.

## Background

Spec 16 deliberately shipped a public, league-agnostic NFL dashboard. Palmer
also commissions a long-running private ESPN league and wants its history and
current rosters connected to the richer player data already collected by the
site. A standalone `fantasyfootball` prototype supplied useful ESPN response
shapes and seven ranking algorithms, but its database held fake seeded teams
rather than real league data.

The configured league is readable without cookies when its ESPN visibility is
public. Some historical seasons remain private; those are stable expected
gaps, not collector failures. The hub is about real managers, so it uses the
site's member gate even though its URL lives below the otherwise-public
`/fantasy` demo prefix.

## Goals

1. Give league members one durable view of standings, results, power movement,
   rosters, and past readable seasons.
2. Make the site's player crosswalk pay off by placing projections, rankings,
   props, injuries, and recent actuals on league rosters.
3. Preserve roster history without storing redundant standings snapshots.
4. Add useful grounded summaries and league-aware chat without weakening
   anonymous demo isolation or requiring an OpenAI key.
5. Keep collection network-only and reads local, testable, and fast.

## Non-goals

- No ESPN login, `espn_s2`/`SWID` cookie storage, or support for leagues other
  than configured league 225965.
- No lineup changes, waiver claims, trades, commissioner actions, or writes
  back to ESPN.
- No live scoring stream; the existing background collector cadence applies.
- No new front-end framework, build step, or second model client.
- No deletion or relocation of the standalone `SampleFantasyApp/`; its owner
  will preserve and move that repository separately.

## Requirements

- **R1. ESPN collection:** Read configured public seasons through a thin
  `urllib` client and pure parsers. An explicit `ESPN_LEAGUE_ID` enables
  collection anywhere; the Railway deployment also enables this site's built-in
  default league through its platform project marker. Unconfigured local and
  test environments disable league scheduling without touching the network.
- **R2. Private-season handling:** Record unreadable ESPN seasons as
  `unauthorized`, close their run as `skipped`, surface them as labeled gaps,
  and continue collecting other seasons.
- **R3. Persistence semantics:** Upsert seasons, members, teams, and matchups;
  snapshot rosters and power rankings. Skip unchanged roster snapshots using
  a content digest in `ff_meta`.
- **R4. Player crosswalk:** Resolve ESPN roster entries through D/ST team,
  ESPN id, normalized name plus pro team, then unambiguous normalized name.
  Preserve every unmatched entry with its raw ESPN name.
- **R5. Standings and results:** Recompute records from completed regular-
  season matchups, excluding playoff/consolation tiers and byes, and match
  ESPN's reported records.
- **R6. Power rankings:** Produce composite, record, point-differential,
  strength-of-schedule, consistency, recent-form, and head-to-head ranks for
  every completed week, including rank movement and per-team history.
- **R7. Member-only boundary:** Require any signed-in site member for page and
  API access. Anonymous API reads return JSON 403 without a Basic-auth
  challenge; page navigation redirects to login with the full next URL.
- **R8. League UI:** Render season selection, private-season labels,
  preseason mode, standings, power rankings, scoreboards, team pages, results,
  and starter/bench/IR roster groups in static HTML/CSS/vanilla JavaScript.
- **R9. Enriched rosters:** Join matched roster players to the consensus
  projection map, newest PPR ranking snapshot, collected props, injury status,
  and three latest actual game lines. Keep unmatched rows visibly plainer.
- **R10. League-aware chat:** Add compact, row-capped league tools to the
  existing fantasy assistant. Construct tool schemas and handlers from a
  `league_access` flag so anonymous/demo model turns contain no private tool
  definitions at all.
- **R11. Team overviews:** Generate Markdown from team facts, results, power
  history, and enriched roster context; cache on `(season, team, week)` plus a
  SHA-256 context digest. Use the existing Responses API path when configured
  and a deterministic local template otherwise. Reads (`GET`) never generate —
  writing there would put a paid model call behind an ordinary page view — so
  a miss returns `status: "missing"` and the client offers to write one. A
  stored *local* overview is treated as stale once a model becomes available,
  so a transient model failure cannot pin the fallback template permanently.
- **R12. Operational safety:** Collection tests never reach the network; the
  auth prefix lists in FastAPI and Vercel middleware stay synchronized; season
  is accepted and echoed by manual league refreshes.

## Technical design

Seven `ff_league_*` SQLAlchemy tables hold league seasons, members, teams,
matchups, roster snapshots, ranking snapshots, and team overviews. The
collector owns all ESPN calls. `fantasy_league_data.py` is a synchronous read
layer resolving snapshot tables through successful collection runs. Standings
and historical results are deterministic reductions of the matchup table,
while roster rows remain tied to a collection run because past membership
cannot be reconstructed after ESPN changes it.

`PlayerCrosswalk` uses the site's Sleeper-keyed `ff_players` table. D/ST ids
are synthetic in ESPN and therefore cross by normalized NFL team abbreviation;
Washington is normalized from ESPN's `WSH` to the site's `WAS`. Other players
fall through progressively safer id/name matching rules. Enrichment reuses
`fantasy_data._consensus_projection_map` and `fantasy_data._player_props`, plus
the latest relevant `ff_rankings` run and recent `ff_player_stats` rows.

The front end follows the site's UMD-pure-logic plus IIFE-controller pattern.
`format.js` owns formatting and dependency-free SVG sparkline paths; `app.js`
owns fetch/state/DOM work. The wide standings table scrolls inside its board.

League chat extends `fantasy_tools.py` with compact standings, scoreboard, and
team reads. `fantasy_ai.tool_schemas(league_access)` and
`tool_handlers(league_access)` make access structural: a demo request cannot
ask the model to call a tool it never received. Team overviews reuse
`_openai_response`, `_extract_output_text`, `OpenAIModelError`, and
`DEFAULT_MODEL` with an empty tool list. Canonical context JSON—not elapsed
time—drives invalidation.

The topic guard also matches league team and owner names, but only for a
member turn: gating it on `league_access` stops an anonymous caller using the
refusal boundary as an oracle for whether a string names one of the teams.
League chat tools default to the newest *played* season rather than the hub's
landing season, so a preseason question about power rankings answers from last
year instead of reporting that none exist.

### Ranking prior art and corrected defects

`fantasy_league_rankings.py` was ported from
`github.com/Palmergill/fantasyfootball`, specifically
`backend/app/utils/ranking_algorithms.py`. The port retained the seven methods
and weights but fixed five defects, each locked by a regression test:

1. Recent form now orders by week before taking four games, rather than taking
   the four highest scores.
2. Head-to-head treats `0.0` as a real score instead of dropping it by a
   truthiness check.
3. A team with zero completed games reports `0.0` rather than treating
   season-total points as a one-game average.
4. Playoff and consolation matchups no longer contaminate regular-season
   metrics.
5. Byes no longer count as games or phantom opponents.

## Testing

- **pytest:** pure ESPN parser fixtures; unauthorized-season and no-network
  scheduler behavior; roster digest snapshots; crosswalk fallbacks including
  D/ST; all ranking algorithms and five port regressions; members-only route
  contracts; roster enrichment; overview digest reuse/invalidation; model
  tool loop with stubbed responses; structural demo isolation.
- **Jest:** record/percentage/points formatting, division grouping, roster
  grouping, matchup outcomes, movement labels, and sparkline path generation.
- **Live preview:** member and signed-out flows, public `/fantasy/` regression,
  2024/2026/private-season states, enriched roster including D/ST, local and
  model overview paths, cache hits, clean console/logs, and mobile overflow.

## Acceptance criteria

- [x] Public readable seasons collect real teams, schedules, rosters, and
      rankings; private seasons remain visible as non-error gaps.
- [x] Standings derived from 2024 matchups match ESPN records for every team.
- [x] Seven ranking methods exclude byes and postseason tiers and expose
      weekly movement/history.
- [x] Every league API route returns 403 to anonymous callers and 200 to a
      normal member; public fantasy reads remain anonymous.
- [x] The hub renders preseason, live, private-season, league, and team views.
- [x] Matched roster rows include consensus projection, current ranking,
      props, injury state, and recent actuals; unmatched ESPN rows remain.
- [x] Team detail renders a power-rank history sparkline.
- [x] Demo chat schemas contain no league tools; authenticated member chat can
      read compact league standings, scoreboards, and teams.
- [x] Team overviews work without an OpenAI key and reuse the digest cache when
      factual context is unchanged.
- [ ] Model-backed overview is verified live with an `OPENAI_API_KEY`.
- [x] Signed-out/member desktop and mobile preview checklist is complete with
      no console errors or page-level horizontal scroll.
- [x] Full pytest and Jest suites are green after final implementation.

## Risks

- **ESPN changes or re-privatizes the league:** visible unauthorized states and
  stored history keep the hub understandable; no expiring personal cookie is
  introduced.
- **Cross-source identity drift:** layered crosswalk rules, retained raw rows,
  and explicit unmatched styling make misses diagnosable without data loss.
- **Accidental demo leakage:** member prefixes override demo prefixes in both
  auth layers, and chat tool availability is constructed before the model
  call.
- **Stale or costly model prose:** context digests regenerate only on factual
  movement; local deterministic prose is always available.
- **Snapshot growth:** unchanged rosters skip writes; ranking snapshots remain
  bounded to small team/week/algorithm sets.

## Estimate

~5–6 weeks at 15 hrs/week, split into independently testable phases:

- **P1 — Data foundation (~2 wks):** ESPN client/parsers, seven models used by
  the hub, crosswalk, collection jobs, digest semantics, rankings port/tests.
- **P2 — Read API and hub (~1.5 wks):** member gate, read layer/endpoints,
  static league/team views, routing, Jest and API contracts.
- **P3 — Crosswalk payoff (~0.75 wk):** roster enrichment and team power
  history visualization.
- **P4 — AI layer and close-out (~1–1.5 wks):** league tools, structural chat
  isolation, digest-cached team overviews, no-key template, specs and live QA.
- **P5 — Start/sit (Sep 2026, ~0.5 wk):** `GET /teams/{id}/lineup` and the card
  above the roster.
- **P6 — Free agents (Sep 2026, ~0.3 wk):** `GET /free-agents` and the league
  board that subtracts the league's own rosters from the ranked pool.

## Amendments

- **Sep 2026 — start/sit.** The roster read already joined every spot to the
  week's consensus projection (P3), and `ff_league_seasons` already stored the
  league's `lineupSlotCounts`, so the best legal lineup is arithmetic on data
  the hub was fetching anyway — no new collection and no second source of truth
  about who is on the team. `GET /api/fantasy/league/teams/{team_id}/lineup`
  returns the lineup as set against that best one, and the card states the
  actionable sets independently: players to start and players to sit, plus the
  total value of applying the complete change.

  **The assignment is provably optimal, not a heuristic.** Seats are filled
  with an exact dynamic program over the small set of lineup seats. This is a
  general assignment problem: ESPN's RB/WR and WR/TE slots partially overlap,
  so a narrowest-first greedy pass can strand the only RB or TE that could have
  completed the lineup. `test_fantasy_league_lineup.py` pins the implementation
  against brute force over randomized rosters and includes that overlap as an
  explicit regression.

  Three silences are deliberate. A player on IR is never started whatever he
  is projected for. When any current starter has no projection, the current
  total and aggregate gain are unknown rather than treating that starter as
  zero. And when the selected league season differs from the projection season,
  or the lineup settings were never collected, advice is unavailable and the
  card stays hidden. Historical rosters may still show current player context,
  but that enrichment cannot become current-week advice for a past team. The
  card is fetched alongside the roster and fails independently: it is the one
  part of the page that can be missing without the page being broken.

- **Sep 2026 — free agents.** Every waiver list on the internet ranks the
  player pool; the only version of the question anybody asks is "who can I
  actually get". That is a fact about these twelve rosters, and the hub stores
  all twelve, so `GET /api/fantasy/league/free-agents` is a set difference:
  the derived rankings for the week, minus every player on a roster in the
  latest `league_rosters` snapshot. Sleeper's add counts ride along as a
  measure of how contested a pickup is — the market's opinion, not a
  recommendation, and blank rather than zero when nobody is adding him.

  The board inherits the start/sit boundary and its reasons vocabulary
  (`available` / `unavailable_reason`): no rankings, a league season that does
  not match the projection season, or no roster snapshot to subtract all mean
  there is no claim to make, and the board hides rather than printing a list
  that would read as "nobody is rostered". The reasons are ordered by how
  fundamental the gap is, so an empty database reports missing rankings rather
  than sending someone after a season mismatch.

  Staleness is the load-bearing caveat and is printed, not hidden: the
  exclusion is only as fresh as the last league sync, so the note carries the
  roster timestamp beside the count. A player claimed an hour ago still reads
  as free, and the board says when it last looked.