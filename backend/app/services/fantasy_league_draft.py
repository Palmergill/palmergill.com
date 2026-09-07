"""Draft recap: grades, callouts, and accolades for the league's ESPN draft.

Read and compute layer only — the router stays thin, matching
``fantasy_league_data``.

Three ideas hold this together:

*Reach is measured in standard deviations, not picks.* The free ADP board
this grades against (Fantasy Football Calculator's 2QB sample) is not the
league's exact format, so a raw ``pick - adp`` carries a systematic bias.
Dividing by the spread of the drafts that produced the ADP normalizes it:
taking a player two picks early is a shrug when his own sample varies by ten,
and a genuine reach when it varies by one.

*Replacement level comes from the league's own slot counts.* A superflex
league's quarterback replacement sits far deeper than a one-QB league's, and
this league runs 10 teams with an OP slot and two FLEX. Filling every team's
real starting lineup from the projection board and reading off the best
player who missed a seat derives that honestly, instead of reusing the
12-team baselines the personal ranking board seeds from.

*Grades are relative and say so.* Ten managers split the same 180 players; the
total value in the room is fixed. An absolute grade would be a fiction, so the
composite is a z-score across this league and the letter is a curve.
"""
import json
import math
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.database import (
    FantasyAdpSnapshot,
    FantasyLeagueDraftPick,
    FantasyLeagueSeason,
    FantasyLeagueTeam,
    FantasyPlayer,
)
from app.services import fantasy_data
from app.services.fantasy_league_espn import configured_league_id

# Half-PPR, as the league plays. Imported lazily inside functions where it is
# needed to keep this module's import graph one-way.
LEAGUE_SCORING = "half"

# What each sub-score is worth in the composite. Value and starters dominate
# because they are the two things a draft actually decides; bench is real but
# secondary, and construction is a check against a roster that cannot field a
# legal lineup rather than a third of the grade.
GRADE_WEIGHTS = {
    "adp_value": 0.35,
    "starters": 0.30,
    "bench": 0.15,
    "construction": 0.20,
}

# Composite z-score -> letter. A curve, because the league is zero-sum.
GRADE_CURVE = (
    (1.45, "A+"),
    (1.05, "A"),
    (0.70, "A-"),
    (0.38, "B+"),
    (0.12, "B"),
    (-0.12, "B-"),
    (-0.38, "C+"),
    (-0.70, "C"),
    (-1.05, "C-"),
    (-1.45, "D"),
)
LOWEST_GRADE = "F"

# A pick whose player the ADP board never listed is treated as going one slot
# past the last pick of the draft rather than being dropped: "nobody else was
# taking him" is information, and discarding it would flatter late reaches.
UNRANKED_ADP_PADDING = 1

# Below this, a stdev is too small to divide by without turning rounding noise
# into a headline. One full pick is the absolute floor.
MIN_ADP_STDEV = 1.0

# The board is never more precise than a few percent of the pick number, and
# the observed spread bears that out: median stdev runs about 3 picks at ADP
# 12 and about 15 at ADP 185. A thinly drafted late-rounder can nonetheless
# come back with a stdev under one pick, and dividing by that turns an
# ordinary 25-pick reach into a 25-sigma one that wins every award forever.
# Flooring proportionally is what keeps a sample artifact from becoming a
# headline.
ADP_STDEV_FLOOR_RATE = 0.05

# A player almost nobody drafted has an ADP, but not a meaningful one. Team
# totals can absorb him; a single-pick award named after him cannot.
MIN_ADP_SAMPLE = 30

# A team needs this share of its starters priced by the season-prop market
# before the Vegas award will rank it. Under that, the sum is measuring
# coverage rather than the roster, so the team is listed as unrankable.
MIN_VEGAS_COVERAGE = 0.6

# Bench value counts, but a bench cannot win a league: past this many points
# of surplus the marginal hoarded player stops adding to the score.
BENCH_VALUE_CAP = 60.0

ROOKIE_EXPERIENCE = 0


# ── loading ─────────────────────────────────────────────────────────────


class DraftUnavailable(Exception):
    """Raised when there is no draft to describe for this season."""


def _season_row(db: Session, season: int) -> Optional[FantasyLeagueSeason]:
    return (
        db.query(FantasyLeagueSeason)
        .filter(
            FantasyLeagueSeason.espn_league_id == configured_league_id(),
            FantasyLeagueSeason.season == season,
        )
        .first()
    )


def _team_names(db: Session, season: int) -> Dict[int, Dict[str, Any]]:
    rows = (
        db.query(FantasyLeagueTeam).filter(FantasyLeagueTeam.season == season).all()
    )
    return {
        row.espn_team_id: {
            "espn_team_id": row.espn_team_id,
            "name": row.name,
            "abbrev": row.abbrev,
            "owner": row.owner_name,
        }
        for row in rows
    }


def _picks(db: Session, season: int) -> List[FantasyLeagueDraftPick]:
    return (
        db.query(FantasyLeagueDraftPick)
        .filter(
            FantasyLeagueDraftPick.espn_league_id == configured_league_id(),
            FantasyLeagueDraftPick.season == season,
        )
        .order_by(FantasyLeagueDraftPick.overall_pick)
        .all()
    )


def _adp_board(
    db: Session, season: int, drafted_at, fmt: str = "2qb"
) -> Tuple[Dict[str, Dict[str, Any]], Optional[Dict[str, Any]]]:
    """The ADP snapshot the draft should be graded against.

    The latest board taken at or before the draft — grading a draft against
    ADP that moved afterwards would credit managers for news they did not
    have. If every snapshot postdates the draft (the collector was deployed
    late), the earliest one is the closest available answer and is labelled as
    such by the meta the caller renders.
    """
    runs = (
        db.query(FantasyAdpSnapshot.run_id, FantasyAdpSnapshot.fetched_at)
        .filter(
            FantasyAdpSnapshot.season == season,
            FantasyAdpSnapshot.format == fmt,
        )
        .distinct()
        .all()
    )
    if not runs:
        return {}, None

    ordered = sorted(runs, key=lambda row: row[1] or 0)
    chosen = ordered[0]
    if drafted_at is not None:
        before = [row for row in ordered if row[1] is not None and row[1] <= drafted_at]
        if before:
            chosen = before[-1]

    # Filter on format as well as run: one collector run writes every format
    # under a single run id, so a run-only filter pulls the half-PPR board in
    # alongside the superflex one and the later rows silently overwrite the
    # earlier ones player for player.
    rows = (
        db.query(FantasyAdpSnapshot)
        .filter(
            FantasyAdpSnapshot.run_id == chosen[0],
            FantasyAdpSnapshot.format == fmt,
        )
        .all()
    )
    board = {}
    meta = None
    for row in rows:
        if meta is None:
            meta = {
                "format": row.format,
                "teams": row.teams,
                "rounds": row.rounds,
                "total_drafts": row.total_drafts,
                "start_date": row.source_start_date,
                "end_date": row.source_end_date,
                "captured_at": row.fetched_at.isoformat() if row.fetched_at else None,
                "captured_before_draft": bool(
                    drafted_at is not None
                    and row.fetched_at is not None
                    and row.fetched_at <= drafted_at
                ),
            }
        if row.player_id:
            board[row.player_id] = {
                "adp": row.adp,
                "stdev": row.adp_stdev,
                "high": row.adp_high,
                "low": row.adp_low,
                "times_drafted": row.times_drafted,
                "bye": row.bye,
            }
    return board, meta


def _source_points(
    db: Session, season: int, source: Optional[str], scoring: str
) -> Dict[str, float]:
    """Season-long projected points from one named provider.

    ``source=None`` takes whichever provider the read layer defaults to.
    """
    data = fantasy_data.get_projections(
        db,
        season=season,
        week=fantasy_data.SEASON_LONG_WEEK,
        position=None,
        scoring=scoring,
        source=source,
        limit=5000,
    )
    return {
        row["player_id"]: float(row["projected_points"])
        for row in data.get("projections", [])
        if row.get("player_id") and row.get("projected_points") is not None
    }


def _implied_points(db: Session, season: int, scoring: str) -> Dict[str, float]:
    """Market-implied season fantasy points, for the players books quote."""
    data = fantasy_data.get_season_fantasy_point_leaders(
        db, season=season, scoring=scoring, limit=5000, include_context=False
    )
    return {
        entry["player"]["player_id"]: float(entry["fantasy_points"])
        for entry in data.get("leaders", [])
        if entry.get("player", {}).get("player_id")
        and entry.get("fantasy_points") is not None
    }


# ── replacement level ───────────────────────────────────────────────────


def replacement_levels(
    slots: List[str], points: Dict[str, float], positions: Dict[str, str], teams: int
) -> Dict[str, float]:
    """Points a freely available player at each position is worth.

    Fills every team's real starting lineup from the projection board, best
    player first, seating him in a dedicated slot where one is open and a
    flex-style slot otherwise. The best player at each position who never got
    a seat is replacement level: he is what a manager could have had instead,
    which is exactly what "value over replacement" is asking.
    """
    from app.services.fantasy_league_data import SLOT_ELIGIBILITY

    seats: Dict[str, int] = {}
    for slot in slots:
        seats[slot] = seats.get(slot, 0) + teams

    # Dedicated slots first so a flex seat is never spent on a player who had
    # a home of his own available.
    dedicated = [s for s in seats if len(SLOT_ELIGIBILITY.get(s, ())) == 1]
    flexible = sorted(
        (s for s in seats if len(SLOT_ELIGIBILITY.get(s, ())) > 1),
        key=lambda s: len(SLOT_ELIGIBILITY[s]),
    )

    ranked = sorted(
        (
            (player_id, value)
            for player_id, value in points.items()
            if positions.get(player_id)
        ),
        key=lambda item: -item[1],
    )

    seated: Dict[str, bool] = {}
    levels: Dict[str, float] = {}
    for player_id, value in ranked:
        position = positions[player_id]
        placed = False
        for slot in dedicated + flexible:
            if seats.get(slot, 0) <= 0:
                continue
            if position not in SLOT_ELIGIBILITY.get(slot, ()):  # pragma: no branch
                continue
            seats[slot] -= 1
            placed = True
            break
        if placed:
            seated[player_id] = True
            continue
        # First man at this position to miss out sets its replacement level.
        levels.setdefault(position, value)

    # A position whose entire pool fits into the lineup has no replacement
    # below it; the weakest starter is the honest floor.
    for player_id, value in reversed(ranked):
        levels.setdefault(positions[player_id], value)
    return levels


# ── scoring ─────────────────────────────────────────────────────────────


def _zscores(values: Dict[Any, float]) -> Dict[Any, float]:
    """Z-score a mapping, returning zeros when every entry is identical."""
    if not values:
        return {}
    numbers = list(values.values())
    mean = sum(numbers) / len(numbers)
    variance = sum((n - mean) ** 2 for n in numbers) / len(numbers)
    stdev = math.sqrt(variance)
    if stdev == 0:
        return {key: 0.0 for key in values}
    return {key: (value - mean) / stdev for key, value in values.items()}


def _letter(composite: float) -> str:
    for threshold, letter in GRADE_CURVE:
        if composite >= threshold:
            return letter
    return LOWEST_GRADE


def _round(value: Optional[float], places: int = 2) -> Optional[float]:
    return None if value is None else round(float(value), places)


def _enrich_picks(
    picks: List[FantasyLeagueDraftPick],
    players: Dict[str, FantasyPlayer],
    adp: Dict[str, Dict[str, Any]],
    values: Dict[str, Dict[str, float]],
    byes: Dict[str, int],
    total_picks: int,
) -> List[Dict[str, Any]]:
    """Attach identity, ADP, and every valuation to each pick."""
    unranked_adp = total_picks + UNRANKED_ADP_PADDING
    rows = []
    for pick in picks:
        player = players.get(pick.player_id) if pick.player_id else None
        position = pick.position or (player.position if player else None)
        pro_team = pick.pro_team or (player.team if player else None)
        board = adp.get(pick.player_id) if pick.player_id else None

        adp_value = board["adp"] if board else float(unranked_adp)
        stdev = max(
            (board or {}).get("stdev") or 0.0,
            MIN_ADP_STDEV,
            adp_value * ADP_STDEV_FLOOR_RATE,
        )
        # Positive means the player lasted longer than the room expected —
        # he was still there at a pick number past his ADP, which is value.
        # Negative means he came off the board early: a reach.
        delta = pick.overall_pick - adp_value
        rows.append(
            {
                "overall_pick": pick.overall_pick,
                "round": pick.round_id,
                "round_pick": pick.round_pick,
                "espn_team_id": pick.espn_team_id,
                "keeper": bool(pick.keeper),
                "autopicked": bool(pick.auto_draft_type_id),
                "player": {
                    "player_id": pick.player_id,
                    "name": pick.player_name_raw
                    or (player.full_name if player else None),
                    "position": position,
                    "pro_team": pro_team,
                    "age": player.age if player else None,
                    "years_exp": player.years_exp if player else None,
                    "bye": byes.get(pro_team) if pro_team else None,
                },
                "adp": _round(board["adp"], 1) if board else None,
                "adp_stdev": _round((board or {}).get("stdev"), 1),
                "adp_ranked": board is not None,
                "adp_sample": (board or {}).get("times_drafted"),
                "adp_delta": _round(delta, 1),
                "adp_sigma": _round(delta / stdev, 2),
                "points": {
                    source: _round(table.get(pick.player_id))
                    for source, table in values.items()
                },
            }
        )
    return rows


def _team_points(roster: List[Dict[str, Any]], source: str) -> Tuple[float, int, int]:
    """(total, priced, total players) for one valuation source."""
    priced = [
        row["points"][source]
        for row in roster
        if row["points"].get(source) is not None
    ]
    return sum(priced), len(priced), len(roster)


def _starters(
    roster: List[Dict[str, Any]], slots: List[str], source: str
) -> List[Dict[str, Any]]:
    """The best legal starting lineup this roster can field."""
    from app.services.fantasy_league_data import _optimal_lineup

    candidates = [
        {
            "player_id": row["player"]["player_id"],
            "name": row["player"]["name"],
            "_position": row["player"]["position"],
            "_points": row["points"].get(source) or 0.0,
            "_pick": row,
        }
        for row in roster
        if row["player"]["position"]
    ]
    if not candidates or not slots:
        return []
    return _optimal_lineup(slots, candidates)


def _construction_score(
    roster: List[Dict[str, Any]],
    starters: List[Dict[str, Any]],
    slots: List[str],
    total_rounds: int,
) -> Tuple[float, List[str]]:
    """Credits and penalties for the shape of the roster, with reasons.

    Deliberately small and legible: these are the failures a manager can see
    on their own roster page, and a grade that docks them silently is worse
    than one that names them.
    """
    notes: List[str] = []
    score = 0.0

    unfilled = len(slots) - len(starters)
    if unfilled > 0:
        score -= 8.0 * unfilled
        notes.append(f"{unfilled} starting slot(s) it cannot fill")

    positions = [row["player"]["position"] for row in roster]
    quarterbacks = positions.count("QB")
    superflex = "OP" in slots
    if superflex and quarterbacks <= 1:
        # In a superflex league the OP seat is a quarterback seat for anyone
        # who took two; ending on one is a structural hole, not a preference.
        score -= 10.0
        notes.append("only one QB in a superflex league")
    elif superflex and quarterbacks >= 4:
        score -= 3.0
        notes.append(f"{quarterbacks} QBs is more than the lineup can use")

    starter_byes = [
        entry["_pick"]["player"]["bye"]
        for entry in starters
        if entry.get("_pick", {}).get("player", {}).get("bye")
    ]
    if starter_byes:
        worst = max(starter_byes.count(week) for week in set(starter_byes))
        if worst >= 4:
            score -= 2.0 * (worst - 3)
            notes.append(f"{worst} starters share a bye week")

    # A kicker or defense taken before the last two rounds is a round spent on
    # a position with almost no spread between the best and the freely
    # available. It is the cheapest identifiable draft mistake there is.
    early_cutoff = max(1, total_rounds - 2)
    early_kd = [
        row
        for row in roster
        if row["player"]["position"] in ("K", "DEF")
        and (row["round"] or total_rounds) <= early_cutoff
    ]
    if early_kd:
        score -= 3.0 * len(early_kd)
        notes.append(f"{len(early_kd)} K/DST taken before the final rounds")

    return score, notes


# ── accolades ───────────────────────────────────────────────────────────
#
# Each award names a winner, the number that won it, and the runner-up, so
# nothing here reads as a bare assertion. An award with no defensible winner
# is omitted rather than handed to whoever scored a zero — "nobody drafted a
# rookie" is a fact about the draft, not a trophy for the team with none.


def _award(
    key: str,
    label: str,
    blurb: str,
    ranking: List[Tuple[int, float]],
    teams: Dict[int, Dict[str, Any]],
    formatter,
    highest_wins: bool = True,
    require_nonzero: bool = False,
) -> Optional[Dict[str, Any]]:
    if not ranking:
        return None
    ordered = sorted(ranking, key=lambda item: (-item[1] if highest_wins else item[1]))
    winner_id, winner_value = ordered[0]
    if require_nonzero and not winner_value:
        return None
    runner = ordered[1] if len(ordered) > 1 else None
    return {
        "key": key,
        "label": label,
        "blurb": blurb,
        "winner": {
            "espn_team_id": winner_id,
            "team": teams.get(winner_id, {}).get("name"),
            "value": _round(winner_value),
            "display": formatter(winner_value),
        },
        "runner_up": (
            {
                "espn_team_id": runner[0],
                "team": teams.get(runner[0], {}).get("name"),
                "value": _round(runner[1]),
                "display": formatter(runner[1]),
            }
            if runner
            else None
        ),
        # Every award carries its full ordering so a card can expand into the
        # standings behind it rather than asserting a winner and stopping.
        "standings": [
            {
                "espn_team_id": team_id,
                "team": teams.get(team_id, {}).get("name"),
                "value": _round(value),
                "display": formatter(value),
            }
            for team_id, value in ordered
        ],
    }


def _pick_award(
    key: str,
    label: str,
    blurb: str,
    candidates: List[Dict[str, Any]],
    teams: Dict[int, Dict[str, Any]],
    metric,
    highest_wins: bool = True,
) -> Optional[Dict[str, Any]]:
    """An award won by a single pick rather than by a whole roster."""
    scored = [(row, metric(row)) for row in candidates if metric(row) is not None]
    if not scored:
        return None
    scored.sort(key=lambda item: (-item[1] if highest_wins else item[1]))

    def describe(row, value):
        return {
            "espn_team_id": row["espn_team_id"],
            "team": teams.get(row["espn_team_id"], {}).get("name"),
            "player": row["player"]["name"],
            "position": row["player"]["position"],
            "overall_pick": row["overall_pick"],
            "round": row["round"],
            "adp": row["adp"],
            "value": _round(value),
            # Rendered here rather than in the page, so every award card reads
            # the same field whether it was won by a roster or by one pick.
            "display": f"{row['adp_sigma']:+.2f}σ vs ADP {row['adp']:.1f}",
        }

    return {
        "key": key,
        "label": label,
        "blurb": blurb,
        "winner": describe(*scored[0]),
        "runner_up": describe(*scored[1]) if len(scored) > 1 else None,
        "standings": [describe(row, value) for row, value in scored[:5]],
    }


def _accolades(
    rosters: Dict[int, List[Dict[str, Any]]],
    starters_by_team: Dict[int, List[Dict[str, Any]]],
    teams: Dict[int, Dict[str, Any]],
    live_picks: List[Dict[str, Any]],
    slots: List[str],
) -> List[Dict[str, Any]]:
    points = lambda value: f"{value:,.0f} pts"
    count = lambda value: f"{int(value)}"
    sigma = lambda value: f"{value:+.2f}σ"
    plain = lambda value: f"{value:.2f}"

    awards: List[Optional[Dict[str, Any]]] = []

    # ── the three scorers, whose disagreement is the point ──────────────
    for source, label, blurb in (
        (
            "vegas",
            "Vegas's favourite",
            "Most season fantasy points implied by the sportsbook markets.",
        ),
        ("espn", "ESPN's favourite", "Most projected points by ESPN's board."),
        ("sleeper", "Sleeper's favourite", "Most projected points by Sleeper's board."),
    ):
        ranking = []
        unrankable = []
        for team_id, starters in starters_by_team.items():
            roster = [entry["_pick"] for entry in starters]
            total, priced, whole = _team_points(roster, source)
            if not whole:
                continue
            coverage = priced / whole
            # The market prices a few hundred players, not a few thousand. A
            # thinly covered roster would score low for a reason that has
            # nothing to do with how it was drafted, so it is named as
            # unrankable instead of quietly finishing last.
            if source == "vegas" and coverage < MIN_VEGAS_COVERAGE:
                unrankable.append(
                    {
                        "espn_team_id": team_id,
                        "team": teams.get(team_id, {}).get("name"),
                        "priced": priced,
                        "of": whole,
                    }
                )
                continue
            ranking.append((team_id, total))
        award = _award(
            f"{source}_favourite", label, blurb, ranking, teams, points
        )
        if award and unrankable:
            award["unrankable"] = unrankable
            award["note"] = (
                f"{len(unrankable)} team(s) had too few starters priced by the "
                "market to rank"
            )
        awards.append(award)

    # ── single picks ────────────────────────────────────────────────────
    graded = [
        row
        for row in live_picks
        if row["adp_ranked"] and (row.get("adp_sample") or 0) >= MIN_ADP_SAMPLE
    ]
    awards.append(
        _pick_award(
            "biggest_reach",
            "Biggest reach of the draft",
            "The pick furthest ahead of where the room was taking him, measured "
            "against that player's own spread.",
            graded,
            teams,
            lambda row: -row["adp_sigma"],
        )
    )
    awards.append(
        _pick_award(
            "steal_of_the_draft",
            "Steal of the draft",
            "The player who lasted furthest past his ADP.",
            graded,
            teams,
            lambda row: row["adp_sigma"],
        )
    )

    # ── roster shape ────────────────────────────────────────────────────
    def by_team(metric, source_rows=None):
        rows = source_rows if source_rows is not None else rosters
        out = []
        for team_id, roster in rows.items():
            value = metric(roster)
            if value is not None:
                out.append((team_id, value))
        return out

    awards.append(
        _award(
            "rookie_fever",
            "Rookie fever",
            "Most first-year players drafted.",
            by_team(
                lambda roster: sum(
                    1
                    for row in roster
                    if row["player"]["years_exp"] == ROOKIE_EXPERIENCE
                )
            ),
            teams,
            count,
            require_nonzero=True,
        )
    )

    def mean_age(roster):
        ages = [row["player"]["age"] for row in roster if row["player"]["age"]]
        return sum(ages) / len(ages) if ages else None

    ages = by_team(mean_age)
    awards.append(
        _award(
            "youngest_roster",
            "Youngest roster",
            "Lowest average age of the players drafted.",
            ages,
            teams,
            lambda value: f"{value:.1f} yrs",
            highest_wins=False,
        )
    )
    awards.append(
        _award(
            "oldest_roster",
            "Oldest roster",
            "Highest average age of the players drafted.",
            ages,
            teams,
            lambda value: f"{value:.1f} yrs",
        )
    )

    # ── how the board was read ──────────────────────────────────────────
    def mean_abs_sigma(roster):
        values = [
            abs(row["adp_sigma"])
            for row in roster
            if row["adp_ranked"] and not row["keeper"]
        ]
        return sum(values) / len(values) if values else None

    obedience = by_team(mean_abs_sigma)
    awards.append(
        _award(
            "most_adp_obedient",
            "Read the sheet",
            "Drafted closest to ADP, pick after pick — the most consensus board "
            "in the league.",
            obedience,
            teams,
            plain,
            highest_wins=False,
        )
    )
    awards.append(
        _award(
            "most_contrarian",
            "Went their own way",
            "Drifted furthest from ADP in either direction.",
            obedience,
            teams,
            plain,
        )
    )

    def mean_stdev(roster):
        values = [
            row["adp_stdev"] for row in roster if row["adp_stdev"] is not None
        ]
        return sum(values) / len(values) if values else None

    awards.append(
        _award(
            "boom_or_bust",
            "Boom or bust",
            "Drafted the players the rest of the world most disagrees about — "
            "the widest average ADP spread.",
            by_team(mean_stdev),
            teams,
            plain,
        )
    )

    def most_from_one_team(roster):
        counts: Dict[str, int] = {}
        for row in roster:
            team = row["player"]["pro_team"]
            if team:
                counts[team] = counts.get(team, 0) + 1
        return max(counts.values()) if counts else None

    awards.append(
        _award(
            "homer",
            "Homer award",
            "Most players taken from a single NFL team.",
            by_team(most_from_one_team),
            teams,
            count,
        )
    )

    def handcuff_pairs(roster):
        backs: Dict[str, int] = {}
        for row in roster:
            if row["player"]["position"] == "RB" and row["player"]["pro_team"]:
                backs[row["player"]["pro_team"]] = (
                    backs.get(row["player"]["pro_team"], 0) + 1
                )
        return sum(count - 1 for count in backs.values() if count > 1)

    awards.append(
        _award(
            "handcuff_hoarder",
            "Handcuff hoarder",
            "Most running backs stacked behind each other on the same NFL team.",
            by_team(handcuff_pairs),
            teams,
            count,
            require_nonzero=True,
        )
    )

    awards.append(
        _award(
            "autopick",
            "Asleep at the wheel",
            "Most picks ESPN made on the manager's behalf.",
            by_team(lambda roster: sum(1 for row in roster if row["autopicked"])),
            teams,
            count,
            require_nonzero=True,
        )
    )

    def worst_bye_stack(team_id):
        weeks = [
            entry["_pick"]["player"]["bye"]
            for entry in starters_by_team.get(team_id, [])
            if entry["_pick"]["player"]["bye"]
        ]
        return max((weeks.count(w) for w in set(weeks)), default=None)

    awards.append(
        _award(
            "bye_chaos",
            "Bye-week chaos",
            "Most projected starters sharing one bye week.",
            [
                (team_id, value)
                for team_id in rosters
                if (value := worst_bye_stack(team_id)) is not None
            ],
            teams,
            lambda value: f"{int(value)} starters",
        )
    )

    if "OP" in slots:
        def second_qb_pick(roster):
            qbs = sorted(
                row["overall_pick"]
                for row in roster
                if row["player"]["position"] == "QB"
            )
            # Never took a second: treated as waiting forever, which is what
            # it amounts to in a superflex league.
            return float(qbs[1]) if len(qbs) > 1 else math.inf

        waits = by_team(second_qb_pick)
        finite = [(team_id, value) for team_id, value in waits if math.isfinite(value)]
        none_at_all = [team_id for team_id, value in waits if not math.isfinite(value)]
        award = _award(
            "superflex_denier",
            "Superflex denier",
            "Waited longest to take a second quarterback in a league that "
            "starts one in the flex.",
            finite,
            teams,
            lambda value: f"pick {int(value)}",
        )
        if award and none_at_all:
            award["note"] = (
                f"{len(none_at_all)} team(s) never took a second QB at all"
            )
            award["unrankable"] = [
                {
                    "espn_team_id": team_id,
                    "team": teams.get(team_id, {}).get("name"),
                    "priced": 0,
                    "of": 0,
                }
                for team_id in none_at_all
            ]
        awards.append(award)

    def earliest_kd(roster):
        picks = [
            row["overall_pick"]
            for row in roster
            if row["player"]["position"] in ("K", "DEF")
        ]
        return float(min(picks)) if picks else None

    awards.append(
        _award(
            "kicker_enthusiast",
            "Couldn't wait for a kicker",
            "First to spend a pick on a kicker or defense.",
            by_team(earliest_kd),
            teams,
            lambda value: f"pick {int(value)}",
            highest_wins=False,
        )
    )

    return [award for award in awards if award]


# ── callouts ────────────────────────────────────────────────────────────


def _callouts(
    live_picks: List[Dict[str, Any]],
    teams: Dict[int, Dict[str, Any]],
    slots: List[str],
) -> Dict[str, Any]:
    """League-wide observations that are about the board, not about a team."""
    runs = []
    window = 5
    threshold = 3
    for start in range(len(live_picks) - window + 1):
        chunk = live_picks[start : start + window]
        counts: Dict[str, int] = {}
        for row in chunk:
            position = row["player"]["position"]
            if position:
                counts[position] = counts.get(position, 0) + 1
        for position, count in counts.items():
            if count >= threshold:
                runs.append(
                    {
                        "position": position,
                        "count": count,
                        "from_pick": chunk[0]["overall_pick"],
                        "to_pick": chunk[-1]["overall_pick"],
                    }
                )
    # Collapse overlapping windows: a genuine run reported five times reads
    # as five runs.
    merged: List[Dict[str, Any]] = []
    for run in runs:
        previous = merged[-1] if merged else None
        if (
            previous
            and previous["position"] == run["position"]
            and run["from_pick"] <= previous["to_pick"]
        ):
            previous["to_pick"] = max(previous["to_pick"], run["to_pick"])
            previous["count"] = max(previous["count"], run["count"])
            continue
        merged.append(dict(run))

    quarterbacks = [row for row in live_picks if row["player"]["position"] == "QB"]
    first_qb = quarterbacks[0] if quarterbacks else None

    return {
        "positional_runs": merged,
        "first_qb": (
            {
                "player": first_qb["player"]["name"],
                "overall_pick": first_qb["overall_pick"],
                "team": teams.get(first_qb["espn_team_id"], {}).get("name"),
            }
            if first_qb
            else None
        ),
        "superflex": "OP" in slots,
        "qb_count": len(quarterbacks),
    }


# ── top level ───────────────────────────────────────────────────────────


def get_draft_recap(
    db: Session, season: Optional[int] = None, scoring: str = LEAGUE_SCORING
) -> Dict[str, Any]:
    """Everything the recap page renders, in one read."""
    from app.services import fantasy_league_collector
    from app.services.fantasy_league_data import _starting_slots

    if season is None:
        season = fantasy_league_collector.current_league_season(db)
    if not season:
        raise DraftUnavailable("No league season is configured.")

    status = fantasy_league_collector.last_draft_status(db, season) or "unknown"
    picks = _picks(db, season)
    teams = _team_names(db, season)
    season_row = _season_row(db, season)
    slots = _starting_slots(season_row)

    if not picks:
        return {
            "season": season,
            "status": status,
            "scoring": scoring,
            "teams": list(teams.values()),
            "picks": [],
            "grades": [],
            "accolades": [],
            "callouts": {},
            "adp_source": None,
            "method": _method(slots, None),
        }

    drafted_at = min(
        (pick.fetched_at for pick in picks if pick.fetched_at), default=None
    )
    adp, adp_meta = _adp_board(db, season, drafted_at)

    player_rows = {
        row.player_id: row
        for row in db.query(FantasyPlayer)
        .filter(FantasyPlayer.player_id.in_([p.player_id for p in picks if p.player_id]))
        .all()
    }
    byes = fantasy_data._team_bye_weeks(db, season)

    values = {
        "espn": _source_points(db, season, "espn", scoring),
        "sleeper": _source_points(db, season, "sleeper", scoring),
        "vegas": _implied_points(db, season, scoring),
    }
    # One number per player for the value maths: the market where it exists,
    # the projection consensus where it does not. Which one scored him is
    # reported per pick so a roster is never silently a mix nobody can see.
    # Consensus first, then any single provider. With only one provider
    # collected the consensus board comes back empty, and falling through is
    # what keeps a thinly collected season gradeable — the same fallback
    # fantasy_rankings_board._projection_points already makes.
    consensus: Dict[str, float] = {}
    for source in (fantasy_data.CONSENSUS_SOURCE, None):
        consensus = _source_points(db, season, source, scoring)
        if consensus:
            break
    best: Dict[str, float] = dict(consensus)
    for player_id, value in values["vegas"].items():
        best[player_id] = value
    values["best"] = best

    total_picks = len(picks)
    enriched = _enrich_picks(picks, player_rows, adp, values, byes, total_picks)

    positions = {
        row.player_id: row.position
        for row in db.query(FantasyPlayer).all()
        if row.player_id and row.position
    }
    levels = replacement_levels(slots, best, positions, len(teams) or 10)

    rosters: Dict[int, List[Dict[str, Any]]] = {}
    for row in enriched:
        rosters.setdefault(row["espn_team_id"], []).append(row)

    starters_by_team = {
        team_id: _starters(roster, slots, "best")
        for team_id, roster in rosters.items()
    }

    total_rounds = max((row["round"] or 0) for row in enriched) or 1
    grades = _grade_teams(
        rosters, starters_by_team, teams, levels, slots, total_rounds, best
    )
    accolades = _accolades(rosters, starters_by_team, teams, enriched, slots)
    callouts = _callouts(enriched, teams, slots)

    return {
        "season": season,
        "status": status,
        "scoring": scoring,
        "teams": list(teams.values()),
        "picks": enriched,
        "grades": grades,
        "accolades": accolades,
        "callouts": callouts,
        "adp_source": adp_meta,
        "method": _method(slots, levels),
    }


def _method(slots: List[str], levels: Optional[Dict[str, float]]) -> Dict[str, Any]:
    """What the page has to disclose for the grades to mean anything."""
    return {
        "weights": GRADE_WEIGHTS,
        "starting_slots": slots,
        "replacement_points": (
            {position: _round(value) for position, value in levels.items()}
            if levels
            else None
        ),
        "relative": (
            "Grades are relative to this league. Ten managers split the same "
            "board, so the total value in the room is fixed and an absolute "
            "grade would be meaningless."
        ),
        "adp_caveat": (
            "ADP comes from Fantasy Football Calculator's 2QB board, which is "
            "close to superflex but not identical — a 2QB league forces a "
            "second quarterback where superflex only permits one. Reaches are "
            "measured in standard deviations to absorb that."
        ),
    }


def _grade_teams(
    rosters: Dict[int, List[Dict[str, Any]]],
    starters_by_team: Dict[int, List[Dict[str, Any]]],
    teams: Dict[int, Dict[str, Any]],
    levels: Dict[str, float],
    slots: List[str],
    total_rounds: int,
    points: Dict[str, float],
) -> List[Dict[str, Any]]:
    raw: Dict[str, Dict[int, float]] = {key: {} for key in GRADE_WEIGHTS}
    details: Dict[int, Dict[str, Any]] = {}

    for team_id, roster in rosters.items():
        live = [row for row in roster if not row["keeper"]]
        sigmas = [row["adp_sigma"] for row in live if row["adp_sigma"] is not None]
        raw["adp_value"][team_id] = sum(sigmas)

        starters = starters_by_team.get(team_id, [])
        starter_ids = {entry["player_id"] for entry in starters}
        starter_vor = sum(
            entry["_points"] - levels.get(entry["_position"], 0.0)
            for entry in starters
        )
        raw["starters"][team_id] = starter_vor

        bench_vor = 0.0
        for row in roster:
            player_id = row["player"]["player_id"]
            if player_id in starter_ids or not row["player"]["position"]:
                continue
            value = points.get(player_id)
            if value is None:
                continue
            bench_vor += max(0.0, value - levels.get(row["player"]["position"], 0.0))
        raw["bench"][team_id] = min(bench_vor, BENCH_VALUE_CAP)

        construction, notes = _construction_score(roster, starters, slots, total_rounds)
        raw["construction"][team_id] = construction

        best_pick = max(
            (row for row in live if row["adp_sigma"] is not None),
            key=lambda row: row["adp_sigma"],
            default=None,
        )
        worst_pick = min(
            (row for row in live if row["adp_sigma"] is not None),
            key=lambda row: row["adp_sigma"],
            default=None,
        )
        details[team_id] = {
            "unranked_picks": sum(1 for row in live if not row["adp_ranked"]),
            "construction_notes": notes,
            "best_pick": best_pick,
            "worst_pick": worst_pick,
            "starters": [
                {
                    "slot": entry["slot"],
                    "player": entry["name"],
                    "position": entry["_position"],
                    "points": _round(entry["_points"]),
                    "overall_pick": entry["_pick"]["overall_pick"],
                }
                for entry in starters
            ],
        }

    zscores = {key: _zscores(values) for key, values in raw.items()}
    weighted = {
        team_id: sum(
            GRADE_WEIGHTS[key] * zscores[key].get(team_id, 0.0) for key in GRADE_WEIGHTS
        )
        for team_id in rosters
    }
    # Re-standardise before the curve. A weighted sum of z-scores has a spread
    # well under one sigma — with these weights it comes out around a half —
    # so reading the curve off it directly would park every team in the middle
    # letters no matter how the draft actually went. Normalising makes the
    # curve mean what it says: a grade is a position in this league.
    composites = _zscores(weighted)
    rows = []
    for team_id in rosters:
        composite = composites.get(team_id, 0.0)
        rows.append(
            {
                "espn_team_id": team_id,
                "team": teams.get(team_id, {}).get("name"),
                "owner": teams.get(team_id, {}).get("owner"),
                "grade": _letter(composite),
                "composite": _round(composite),
                "weighted_score": _round(weighted[team_id]),
                "components": {
                    key: {
                        "raw": _round(raw[key][team_id], 1),
                        "z": _round(zscores[key].get(team_id, 0.0)),
                        "weight": GRADE_WEIGHTS[key],
                    }
                    for key in GRADE_WEIGHTS
                },
                **details[team_id],
            }
        )
    rows.sort(key=lambda row: -row["composite"])
    return rows
