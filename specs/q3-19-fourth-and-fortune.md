# Spec 19 — Fourth & Fortune (Draft-Order Game)

- **Quarter:** Q3 2026 (Jul–Sep)
- **Status:** shipped — written retroactively; the feature was built Jul 31–Aug 17 2026
- **Depends on:** site member accounts (spec: none — shipped with `103ebd0`)
- **Areas:** `fantasy/draft-order/`, `backend/app/services/draft_order_game.py`,
  `backend/app/routers/draft_order.py`, `backend/app/database.py`,
  `backend/scripts/verify_draft_order.py`, `fourth-and-fortune-kickoff.html`

> **Written after the fact.** This documents what was built rather than what was
> planned; the work shipped without a spec. It is here so the roadmap reflects
> the site as it actually stands, and so the fairness argument lives somewhere
> other than commit messages.

## Summary

A push-your-luck card game at `/fantasy/draft-order/` that a fantasy league
plays to decide draft order. Each manager takes five rounds from their own
deck, flipping cards to build a pot and banking before they bust. Final
standings become the draft order. The result is verifiable after the fact: the
server commits to a seed before play and discloses it only once the last score
is locked.

## Background

Leagues decide draft order with something arbitrary — a randomizer, a spun
wheel, last year's standings inverted. All of those ask everyone to trust
whoever ran it. A game that publishes a commitment up front and its seed
afterwards lets any manager re-derive every card that was dealt, which is a more
interesting answer than "the website said so."

## Goals

1. Decide draft order with a game people actually want to play.
2. Make the outcome independently verifiable, in the browser, without trusting
   the host or the server after the fact.
3. Work for a real league (invited accounts, asynchronous turns) and for one
   person messing around alone.
4. Never strand a room in a state where nobody can act.

## Non-goals

- No real money, and no ranking beyond the league that plays it.
- No scheduler or background worker. Reads drive the clock.
- No spectator chat or reactions.

## Fairness model

The load-bearing part of the design.

- At room creation the server generates a master seed and publishes only
  `sha256(seed)` as `seed_hash`. That is the commitment.
- Each player's deck is derived from the master seed by HMAC-SHA256, keyed per
  account and round, so no two players share an order and nobody's deck can be
  inferred from anyone else's.
- The seed is disclosed only when the final score is locked. Until then the API
  withholds it, along with final-round cards, final scores, and the draft order.
- `fantasy/draft-order/verify.js` re-derives every deck in the browser from the
  published seed and checks it against `seed_hash`. Both scoring rules are read
  from the committed `game_version`, never from the fields the proof publishes
  for them — a room that could name its own multiplier could name the one that
  makes its totals add up.
- `backend/scripts/verify_draft_order.py` does the same independently of the
  browser.

Three game versions exist and are all still verifiable: `v1` dealt one
continuous deck, `v2` deals a fresh 52-card deck per round, `v3` adds the
doubled final round. Old rooms are proved under the rules they were played
under.

## Rules

- `ROUNDS_PER_PLAYER = 5`, consumed continuously from the player's own deck.
- Round one follows the seed-derived player order. Every later round is frozen
  from the standings after the preceding round, scoring leader first.
- The final round pays double (`FINAL_ROUND_MULTIPLIER = 2`) and is sealed:
  spectators see opponents' card counts only, and the public leaderboard
  freezes at the round-four standings.
- Five rounds can demand up to 65 cards from a 52-card deck. A round with no
  deck left is recorded `exhausted` and scores zero, rather than stranding the
  room on a manager who can neither flip nor bank.

## Room modes

`league` (account-backed invites), `practice` (private solo warm-up), `bots`
(a full five-round game any account can open against marked bot players), and
admin-only `test`. Both bot modes advance one action at a time, paced by the
host's client, through the same scoring and verification path as a real draft.

## Turn hold

A turn that ends is not handed straight to the next manager. The room enters
`turn_state = 'resolved'`, keeps the finished hand and the acting player on the
table, and publishes the action in `last_event_json`. The turn advances on the
first read or action arriving more than `TURN_HOLD_SECONDS` (1.8) later.
Without the hold, the card that busted or banked a round was already gone by the
time a spectator's poll landed. There is no scheduler, so reads are the clock —
a held room is never stuck longer than it takes someone to look at it.

`turn_started_at` records when the current manager went on the clock. The host's
forfeit is the one lever a person controls rather than the seed, so it stays out
of reach until `FORFEIT_GRACE_SECONDS` (90) have passed.

## Records

- `record/mine` — an account's highest score across every finished game whose
  scores are open. A completed league draft is excluded until its reveal.
- `leaderboard` — the ten highest human runs across practice, bot-table and
  revealed league games. Repeated runs by one account are kept; bot seats and
  admin test rooms are excluded; the final-score seal is honored.

## Data model

Tables prefixed `ff_draft_`: `ff_draft_sessions` (room, mode, `seed_hash`,
`master_seed`, `game_version`, `turn_state`, `revealed_at`), `ff_draft_players`,
`ff_draft_rounds`, `ff_draft_flips` (every dealt card).

## Testing

`backend/tests/test_draft_order_game.py` (~1,700 lines) — seeded determinism,
the commit/reveal boundary at every read, sealed-final-round concealment, deck
exhaustion, turn-hold advancement, forfeit grace, mode isolation, leaderboard
eligibility, and tie ordering.

`fantasy/tests/draft-order-verify.test.js` — the browser verifier against known
seeds, including version-pinned scoring and a tampered-proof rejection.

`fantasy/tests/draft-order-format.test.js` — presentation helpers.

## Known follow-ups

- The kickoff deck lives at the repository root
  (`fourth-and-fortune-kickoff.html`) rather than under a directory.
- No spec-level decision on retiring `v1` rooms.
