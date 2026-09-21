# Spec 17 — ESPN League Hub

- **Quarter:** Q3 2026 (Jul–Sep)
- **Status:** in progress — P1–P4 implemented; model-backed overview still needs a live `OPENAI_API_KEY`
- **Depends on:** Spec 16 (fantasy data, player crosswalk, chat plumbing), site member accounts
- **Areas:** `fantasy/` (the hub; `fantasy/league/` until Sep 2026),
  `backend/app/services/fantasy_league_*.py`,
  `backend/app/routers/fantasy_league.py`, `backend/app/services/fantasy_ai.py`,
  `backend/app/services/fantasy_tools.py`, `backend/app/database.py`,
  `backend/app/main.py`, `middleware.js`

## Summary

A members-only hub at `/fantasy/` (at `/fantasy/league/` until Sep 2026)
for ESPN league 225965: historical
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

- **Sep 2026 — your team, first.** The hub knew all twelve teams and not which
  one was yours: start/sit is advice about one specific roster, and it was
  reachable only by recognising your own name in the Teams grid. The landing
  page now opens with a strip naming your team, its record, this week's
  opponent and power rank, and what the lineup is leaving on the bench —
  linking into the team page for the detail. It reuses `GET /league/me`, which
  already stored the account → team mapping for the dashboard hero, plus the
  P5 lineup read; no new endpoint. The advice line follows the same rule as the
  card it summarises: when the lineup payload is `available: false`, the strip
  keeps the shortcut and drops the claim. The free-agent board also carries an
  `id`, so the dashboard's Waiver Pulse can link straight to it.
- **Sep 2026 — draft recap.** The draft is the one event in a fantasy season
  everybody has an opinion about and nobody has evidence for, so the hub grew a
  room for it at `/fantasy/league/draft/`.

  Two data additions carry it. ESPN's `mDraftDetail` view is public on this
  league and returns every pick with `playerId`, `overallPickNumber`, `teamId`,
  `keeper` and `autoDraftTypeId`; it is requested alongside `mRoster` because
  the draft payload names nobody — a pick is a bare id, and
  `ff_players.espn_id` is null for a large share of players, which is the same
  gap `PlayerCrosswalk` already exists to close. And ADP, which the site had
  never held, now comes from Fantasy Football Calculator: keyless, and the only
  free source that publishes a standard deviation alongside the mean.

  **Reach is measured in standard deviations, not picks.** FFC's superflex
  proxy is its 2QB board, and 2QB is not superflex — a 2QB league forces a
  second quarterback where superflex merely permits one — so a raw `pick - adp`
  carries a systematic bias. Dividing by the spread of the drafts that produced
  the ADP normalises it. The floor on that divisor grows with the pick number
  (5% of ADP): a thinly drafted late-rounder can come back with a stdev under
  one pick, and dividing by that turns an ordinary 25-pick reach into a
  25-sigma one that would win every award forever.

  **Replacement level is derived from the league's own `lineupSlotCounts`,**
  not from `fantasy_rankings_board.BASELINE_RANK`. Those baselines describe a
  12-team, one-QB, 3WR league; this one is 10 teams with an OP seat and two
  FLEX. Filling all ten starting lineups from the projection board and reading
  off the best player who missed a seat puts QB replacement around 215 points
  against RB's 139 — the superflex premium, which a generic baseline erases.

  **Grades are a curve and say so on the page.** Ten managers split the same
  180 players, so the total value in the room is fixed and an absolute grade
  would be a fiction. Four sub-scores (value vs ADP 35%, starting lineup 30%,
  bench 15%, roster construction 20%) are z-scored across the league, weighted,
  and then *re-standardised* before the curve is applied: a weighted sum of
  z-scores has a spread well under one sigma, so reading the curve off it
  directly parked every team in the middle letters regardless of how the draft
  went.

  **The accolades are the headline, not the grades.** Eighteen awards, each
  naming a winner, the number that won it, and the runner-up, with the full
  ordering behind a disclosure so a card can be argued with. The three that
  matter most are Vegas's, ESPN's and Sleeper's favourite rosters — three
  independent valuations the site already collects, whose disagreement is the
  most interesting thing the page can say. The Vegas award is the only one with
  a real coverage gap: the season-prop market prices a few hundred players
  against Sleeper's few thousand, so it is computed over starters only, and a
  roster under 60% priced is listed as unrankable rather than quietly finishing
  last. Awards nobody earned are omitted rather than handed to whoever scored a
  zero.

  Written recaps clone the `ff_league_team_overviews` machinery exactly —
  context digest, cached row, model or deterministic local fallback — so the
  page reads properly with `OPENAI_API_KEY` unset, and generation stays behind
  an explicit POST so no schedule can bill for it.

  Cadence: `league_draft` gets its own trigger rather than riding the
  `league_sync` tick, and polls every scheduler pass while ESPN reports the
  draft in progress. A league that has not drafted closes the run as `skipped`,
  for the same reason a private season does — it is the answer eleven months of
  the year, and logging it as an error would make the run log read like a crash
  loop.

- **Sep 2026 — weekly recap.** The draft recap gave the season one loud
  argument and then went quiet for four months. The hub now has a room for the
  weekly one at `/fantasy/league/week/`, built from data it already stores:
  no new collection, no new external source.

  **A week grades on three things, and one of them is not the manager's.**
  Points scored (45%), the share of the roster's best legal lineup that
  actually started (30%), and the margin against whoever the schedule handed
  you (25%). The last is the smallest slice on purpose and the method card
  says why. As with the draft, the composite is z-scored across the league and
  re-standardised before the curve, because ten managers splitting one week is
  zero-sum the same way one draft board is.

  **The lineup half reuses the manager rating exactly.** Same roster
  snapshots, same actual-points join, same optimiser filling this league's own
  seats — pointed at one week instead of the season. It inherits both of that
  code's silences: a team whose starters the stat feed cannot all cover gets
  no efficiency rather than a short one, and a benched player with no stat row
  is never treated as a missed opportunity. D/ST is excluded from both sides
  and named in the response instead of invalidating every week.

  **A component that cannot be measured leaves the grade rather than scoring
  average.** Before roster snapshots exist — the first week of a freshly
  collected season, or a season collected only at its end — the management
  component is dropped and the remaining weights renormalise around it. The
  page prints the reason under the table. Handing an unmeasured team a
  league-average z would have been the quiet alternative, and it would have
  read as a manager who set an ordinary lineup.

  **Fifteen awards, and the ones nobody earned are omitted.** Team of the
  week, the cold shower, best lineup set, left on the bench, over- and
  under-achiever, best against the field, the blowout, the nail-biter, player
  of the week, the best player nobody started, the smash and the bust. The two
  luck awards — the win that beat only the schedule, the loss that beat
  everyone but its opponent — appear only when the all-play record actually
  supports the claim, so a week in which every winner deserved it hands out
  neither. Busts are measured only against a projection of at least eight
  points, so the award cannot be won every week by a kicker.

  Written recaps clone the draft-note machinery a third time
  (`ff_league_week_notes`, keyed on season/week/team): context digest, cached
  row, model or deterministic local fallback, generation behind an explicit
  POST so no page load and no schedule can bill for it.

- **Sep 2026 — the league becomes the home page.** `/fantasy/` was the
  market dashboard and the hub lived a click in, which had the section
  leading with the thing that changes least. The league is what somebody
  opens the section to see, so it moved to `/fantasy/`; the market board
  moved to `/fantasy/market/`, and the two league recaps to `/fantasy/week/`
  and `/fantasy/draft-recap/`. `vercel.json` redirects every old URL.

  **The hub is no longer edge-gated, and that is the point.** It is the
  section's front door now, so an anonymous visitor has to reach it to be
  told what is behind it — a login redirect at the edge pre-empts that. The
  page is an empty shell either way: every byte of league data comes from
  `/api/fantasy/league/*`, where `require_member` is and always was the real
  boundary. The two recaps have no teaser story, so they keep the edge gate
  and `MEMBER_PATH_PREFIXES` now names them instead.

  `shared/fantasy-header.js` carries the new shape in three slots: Home, My
  Team, and a Tools menu for the pages that have nothing to do with any
  league (market board, personal rankings, Fourth & Fortune). "My Team"
  links to `?team=me` rather than a team id, because the nav cannot know
  which team is yours; the hub resolves it against `GET /league/me` — which
  it already reads for the ledger highlight — and rewrites the URL to the
  real id. An account with no team chosen lands on the league with a line
  saying to pick one, rather than on a blank team view.

- **Sep 2026 — importing a league (front end only).** The page calls itself
  the fantasy home page, which invites "can I point this at my league?"
  immediately, so it asks and answers the question in a fold-out form on the
  hub. The form is real: it parses an ESPN league ID, reads one out of a
  pasted league URL, normalises leading zeros, and distinguishes three
  outcomes — a typo, the league already on screen, and a well-formed ID for a
  league the site cannot serve. It issues no request for the third, and says
  so plainly rather than spinning.

  **What it cannot do yet is import.** The backend is single-league by
  construction: `configured_league_id()` reads `ESPN_LEAGUE_ID` from the
  environment, and of the eleven `ff_league_*` tables only `ff_league_seasons`
  carries `espn_league_id` — the rest key on `season` alone, with unique
  constraints like `(season, espn_team_id)` that a second league in the same
  season would collide on. Real multi-league support is a migration across
  ten tables, a rewrite of ~109 query sites across four services, per-account
  league selection, and on-demand collection for an arbitrary public ID with
  whatever rate limiting that implies against ESPN. That is its own phase,
  not a redesign; `GET /overview` now returns `league_id` so the form can
  compare honestly in the meantime.

- **Sep 2026 — the top of the page, cleared.** Two things sat above the
  league and earned neither the space nor the position.

  **The "Your team" strip is gone.** It existed because the hub knew all
  twelve teams and not which one was yours, so a shortcut at the top was the
  only way to your own roster. "My Team" is a slot in the section nav now,
  on every page, so the shortcut was permanent furniture repeating something
  already on screen — and its start/sit moves were a four-row copy of the
  lineup card on the team page itself. `GET /league/me` is still read, for
  the one thing that survives: marking your row in the table. The per-team
  lineup request it used to fire on every league load is no longer made.

  **The season chips moved to a History board at the foot of the page.**
  Listing every year the league has ever had, above the year you came to
  read, put the least live thing on the page in the most expensive space.
  History gives each past season a row instead: the year in the margin, who
  won it and what they beat in the final, and a link that switches the hub
  into that season. A season bar entry remains at the top, but only as a
  line that appears when you are reading a season that is not the current
  one — the masthead's year alone does not say which you are doing.

  `list_seasons` therefore carries a `champion` per season, derived from the
  last complete `WINNERS_BRACKET` matchup with a decided winner. It declines
  to answer rather than guessing: a season still being played, a league
  whose playoff matchups were never collected, a consolation-ladder game, or
  a tied final all yield `null`, and the row says "no champion recorded".
  Promoting a semi-final winner to champion would be worse than saying
  nothing. Private seasons keep their labelled row and are never read for a
  champion.

- **Sep 2026 — the power board is two numbers.** It had grown a lede, a
  footnote, a weakest-seat sentence, a surplus list and a foldaway lineup
  table per row. All of it was true and most of it went unread: the board's
  job is an order, and a reader standing in front of a ranking wants to know
  where each team sits, not to be walked through the arithmetic that put it
  there.

  A row is now rank, team, projected points a week, and playoff odds.
  Nothing else. The points figure is the one the board was always built on;
  the odds come from the ledger payload, where they are already simulated,
  joined client-side rather than re-simulated in `/roster-power`. The two
  requests race, so whichever lands second re-renders — a row is never left
  showing a permanent dash for a number the page already has, and a team the
  ledger genuinely has no odds for prints a dash rather than a zero.

  The method did not disappear, it moved: both stat labels carry the same
  hint affordance the standings columns use, so "pts/wk" explains the best-
  legal-lineup calculation on hover, focus, or a tap. That last one matters
  here in a way it does not on the table, which hides its header row on a
  phone entirely — these labels are on screen at every width, and
  `:focus-within` is what makes them answer a tap.

- **Sep 2026 — playoff odds that survive September.** One week into the
  season the hub was reporting 98% for one team and 0% for another. The
  simulation was sound in structure and wrong in its inputs: it fitted each
  team's scoring average to the handful of weeks it had played, then treated
  that average as settled fact across the thirteen games left. A team that
  opened with 150 was modelled as a 150-point team for the rest of the year,
  so it won essentially every simulated game.

  Two changes, both in `_scoring_model`. A team's own average is now pulled
  toward the league's on a sliding weight, `games / (games + PRIOR_GAMES)`.
  `PRIOR_GAMES` is 5, which is not a taste call: for a normal-normal model
  the correct weight is the ratio of week-to-week variance to true
  between-team variance, and fantasy weeks swing about 26 points against a
  talent spread of 11 or 12 — 26²/12² ≈ 5. And the leftover uncertainty in
  that average is now drawn once per simulated season, so a league two weeks
  old produces a genuinely wide range of seasons rather than thirteen more
  copies of the two it has played. Variances are blended, not standard
  deviations, and a `MIN_STDEV` floor stops a league with no measurable
  spread from becoming deterministic by the other door.

  On a synthetic ten-team league the top-to-bottom spread after one week
  went from 98–0 to 61–13, with nothing at either extreme, while the
  invariants held throughout: odds always total the number of places on
  offer, the week-one blowout still helps the team that scored it, and a
  finished season still reports exactly 0 or 1. Confidence now grows with
  the season instead of arriving with it.
