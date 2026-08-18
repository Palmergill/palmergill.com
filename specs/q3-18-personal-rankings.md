# Spec 18 — Personal Rankings

- **Quarter:** Q3 2026 (Jul–Sep)
- **Status:** implemented — P1–P4 shipped; P5 remains future work
- **Depends on:** Spec 16 (player catalog, derived rankings, projections), site member accounts
- **Areas:** `fantasy/rankings/`, `backend/app/services/fantasy_rankings_board.py`,
  `backend/app/routers/fantasy_rankings.py`, `backend/app/database.py`,
  `backend/app/main.py`, `fantasy/index.html`

## Summary

A page at `/fantasy/rankings/` where any signed-in member keeps their own
fantasy rankings: QB, RB, WR and TE lists plus an overall board, seeded from the
site's derived rankings and edited by dragging, nudging, or typing a rank.
Boards are keyed on `(season, scoring, roster)` and are private to their owner.

## Background

Spec 16 shipped a public dashboard that says what the data thinks. It has no
way for a person to say "my order is different, and here it is" — which is the
one thing anybody actually does with rankings each August. The supporting cast
already exists: a Sleeper-keyed catalog, season-long derived rankings per
scoring format, consensus projections, and a player typeahead.

The league this is built for plays **superflex**, which does not change how
points are scored but does change what a quarterback is worth. That is a roster
format, not a scoring format, so it gets its own axis rather than being wedged
in as a fourth `scoring` value.

## Goals

1. Let a member build and maintain a real draft board on the site instead of in
   a spreadsheet.
2. Make the overall and positional lists incapable of disagreeing.
3. Support the way people actually edit rankings: drag, one-slot nudges, big
   jumps by rank, and (P2) named tiers.
4. Seed from what the site already knows, so the first screen is useful.
5. Open it to every member, not just the admin.

## Non-goals

- No weekly boards. A personal board is draft prep and is season-long
  (`week = SEASON_LONG_WEEK`) by definition.
- No kickers or defenses. They are in the catalog; nobody ranks them by hand.
- No new framework, build step, or drag-and-drop library.
- No admin access to member boards. These are personal artifacts, not moderated
  content.

## Requirements

- **R1. One stored order.** For two players of the same position, the overall
  order and the positional order agree — always. This is achieved by storing a
  single `sort_key` per entry and deriving the positional lists as filters, not
  by reconciling five lists. See "Design decisions" below.
- **R2. Sparse keys.** Ordering is a float seeded at 1000, 2000, ... so a move
  writes one row rather than renumbering three hundred. Exhausted gaps trigger a
  whole-board respread that the client is told to accept wholesale.
- **R3. Roster axis.** A board is unique on `(username, season, scoring,
  roster)` where roster is `1qb | superflex`. Superflex changes exactly one
  thing in the math: replacement-level QB moves from QB12 to QB22.
- **R4. Seeding.** Order comes from `fantasy_data.get_rankings`; points come
  from `fantasy_data.get_projections`. A board with no rankings run seeds empty
  with a clear message, never a 500.
- **R5. Editing.** Drag (pointer events), ▲/▼ nudge, move-to-rank, and a full
  keyboard model (Alt+arrows, Alt+Shift+arrows, Alt+Home/End, and a grab mode
  that commits one write for a long move). Every move announces through one
  `aria-live` region.
- **R6. Autosave with revision checks.** Moves are optimistic and serialized
  through one promise chain. A stale revision returns 409 carrying the current
  board; the client reloads and says so rather than interleaving two tabs.
- **R7. Member boundary.** Board routes return JSON 403 to anonymous callers
  (never a `WWW-Authenticate` 401). Another member's board — and the admin's
  view of it — is 404, not 403, so board ids are not enumerable.
- **R8. Board-specific player search.** `/api/fantasy/rankings/players/search`
  orders by projected points and drops non-rankable positions.
- **R9. Tiers (P2).** Named dividers living in the same key space, scoped to one
  list, so dragging a player past one changes his tier with no membership column.
- **R10. Publish and consensus (P3–P4).** An opt-in per-board publish exposing a
  read-only share URL, and a site consensus averaging published boards with
  omissions imputed just past each board's bottom and an appearance floor.

## Design decisions

**One order, not five.** The product rule — positional order is authoritative,
and an overall drag also reorders the player within his position — means the
positional lists carry no information the overall list does not already have.
The QB list *is* the overall list filtered to QBs. So there is no reconciliation
code, and no drift, because there is nothing to reconcile. A positional move is
translated into an overall slot: landing at positional index *i* means landing
immediately above whoever currently holds that slot, wherever he sits overall.
That is the only placement that changes the player's order relative to his own
position and to nobody else.

**No FK from `ff_rank_entries.player_id` to `ff_players`.** The catalog is
collector-owned; a constraint with a cascade would let a scheduled collection
run mutate a member's hand-built board. `position` is snapshotted on the entry
for the same reason.

**`username` as a string, not a FK to `app_users`.** Same as `ff_draft_players`:
the admin authenticates from env vars and has no row there.

**`/fantasy/rankings` is deliberately not a member path.** Published boards are
shared by URL and the consensus is public, so an anonymous visitor must reach
the page. Adding it to `MEMBER_PATH_PREFIXES` would bounce every share-link
visitor to `/login/`. The API gates itself per endpoint instead, and a
regression test in `test_fantasy_rankings_api.py` pins the intent.

**Pointer events, not HTML5 drag-and-drop.** HTML5 DnD does not fire on touch in
iOS Safari at all, and reordering receivers on a phone is a core use.
`touch-action: none` is scoped to the grip handle only, so a finger can still
scroll the list from anywhere else on a row. The list is not virtualized on
purpose: 300 `<li>` is not a performance problem, and virtualizing would break
both focus management and the drag's cached rects.

## Data model

All tables prefixed `ff_rank_`:

- `ff_rank_boards` — one per `(username, season, scoring, roster)`; carries
  `share_slug` (minted at create, so publishing is a pure boolean flip),
  `published`, `seeded_from`, `seed_run_id`, and `revision` (the concurrency
  token).
- `ff_rank_entries` — `board_id`, `player_id`, snapshotted `position`, float
  `sort_key`, `seed_rank` (for the "vs consensus" delta), `note`.
- `ff_rank_tiers` — `board_id`, `scope`, `label`, `sort_key` in the same space.

New tables only, so `Base.metadata.create_all` covers them; no
`database_migration.py` change is needed.

## Phases

- **P1 (done).** Private boards, five lists, seeding with roster-aware VOR,
  drag/nudge/jump/keyboard, autosave with 409 handling, board-specific search.
- **P2 (done).** Named, scoped tier dividers share the player key space and
  support create, rename, drag and delete from every list.
- **P3 (done).** Owners can publish or unpublish with revision checks; opaque
  share slugs serve a public read-only board only while publication is enabled.
- **P4 (done).** Public consensus averages published boards for one
  `(season, scoring, roster)` format, imputes omissions one slot below each
  board, applies a 25% appearance floor, and powers the editor's live
  "vs consensus" values.
- **P5.** Per-player notes, CSV export, position-change reconciliation prompt.

## Testing

`backend/tests/test_fantasy_rankings_api.py` — the auth boundary (parametrized
over every board route), and the invariant: `assert_invariant` after each of 200
seeded-random moves across mixed scopes, parametrized over both roster formats.
Plus key exhaustion, revision conflicts, reset, superflex seeding, and search
relevance.

`fantasy/tests/rankings-format.test.js` — `projectOverallMove` from both
directions plus an exhaustive invariant sweep, `moveWithin` non-mutation,
`midpointKey` exhaustion, `tierBands` edges, and a 500-move permutation check.

`fantasy/tests/rankings-app.test.js` — DOM-level controller regressions for
keyboard-event isolation, board-scoped write cancellation during navigation,
409 conflict adoption, and out-of-order consensus responses.
