# Team view redesign mockups

Hand-written HTML, 2026-09-10. Three directions for the routed team view in the
league hub (`/fantasy/league/?team=N`). Open `index.html` to compare them.

These are direction studies, not implementation specs. Data is illustrative and
set mid-season (2026, week 14) so every module has something to show; the chips,
buttons, and swap controls do nothing.

## What is being redesigned

The league page is now a ledger — serif masthead, one table with a switchable
column, hairline rules instead of card borders. The team view did not come along:
it is still a head card, an overview card, a start/sit card, and then results and
roster in two columns. Each study picks a different answer to what the team page
is *for*.

## 1. The team ledger — `01-team-ledger.html`

Carries the league page's language down one level. The team gets its own masthead
and a standing line built from the four facts the ledger already ranks it on
(power, all-play, lineup, luck). The roster becomes a single table — starters,
bench, and IR as row groups — with a switchable trailing column and the same
`meter` mark the league table uses. Results become a margin chart.

Strongest continuity with the hub; the smallest change in shape.

## 2. Sunday desk — `02-sunday-desk.html`

Decision-first. A verdict bar states the week's gain in one line, the lineup
renders slot by slot the way a lineup actually looks, and each suggested change
rides directly under the slot it would replace rather than in a separate list of
starts and sits. Bench is sorted by what each player would add to the lineup. The
season, overview, and power trend move to a rail.

Best on a Sunday morning; demotes everything about the season.

## 3. Season dossier — `03-season-dossier.html`

The generated overview leads, set as a real lede with the record beside it as a
colophon. The season is a week-by-week timeline carrying margin bars and opponent
records, and the roster is grouped by room with each position measured against the
league average for that position. Start/sit survives as a small aside.

Best for reading someone else's team; weakest for acting on your own.

## Open questions these raise

- Does start/sit belong above the roster (1, 2) or beside it (3)?
- Is the roster one table (1) or one list per position (3)?
- The position-group averages in 3 are not computed anywhere yet.
- 2 leans on the current week's opponent and a lock time. The opponent is already
  in `detail.results` (incomplete weeks carry it, which is how the results list
  renders a pending row) and the start/sit card simply does not show it. A lock
  time is not stored anywhere and would have to be dropped or sourced.
