"""Weekly recap: grades, accolades and callouts for one week of the league.

Read and compute layer only — the router stays thin, matching
``fantasy_league_data`` and ``fantasy_league_draft``.

The draft recap grades one event against an outside market. A week has no
outside market, so three different ideas carry this one:

*Everything is measured against what actually happened.* The score is ESPN's
own total. The best lineup a roster could have started is the optimiser the
manager ratings already use, pointed at real stat lines rather than
projections. Projections appear only as the expectation a week beat or
missed; they are never the score.

*A week is graded on the same curve as the draft, for the same reason.* Ten
managers play one week against each other; the points in the room are
whatever they are, and an absolute grade would be a fiction.

*What cannot be measured is dropped rather than guessed.* A week with no
roster snapshot cannot say who should have been started, so the management
component leaves the grade entirely and the remaining weights renormalise
around it. The page prints why instead of quietly scoring everybody at 100%.
"""
import statistics
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.database import (
    FantasyLeagueMatchup,
    FantasyLeaguePowerRanking,
    FantasyLeagueRosterEntry,
    FantasyPlayer,
    iso_utc,
)
from app.services import fantasy_data
from app.services.fantasy_common import normalize_scoring
from app.services.fantasy_collector import latest_successful_run

# The grading maths is the draft recap's, not a second copy of it: the same
# curve, the same z-score, the same rounding. A grade means "where you
# finished in this league" on both pages, so they cannot be allowed to drift.
from app.services.fantasy_league_draft import _letter, _round, _zscores

# The lineup side reuses the manager-rating machinery wholesale — the roster
# snapshots, the actual-points join, and the exact optimiser that fills this
# league's real seats. A weekly recap that re-derived any of that would be a
# second answer to "who should you have started".
from app.services.fantasy_league_data import (
    BENCH_SLOTS,
    INELIGIBLE_SLOTS,
    LEAGUE_SCORING,
    UNSCORED_ACTUAL_POSITIONS,
    _actual_points,
    _latest_roster_run_by_week,
    _optimal_lineup,
    _require_season,
    _roster_runs_for_weeks,
    _season_rows,
    _starting_slots,
    _team_rows,
)

# What each sub-score is worth. Scoring dominates because a fantasy week is
# mostly what your players did. Management is the part a manager actually
# controlled and is weighted accordingly. The result is the smallest slice on
# purpose: it is the one component decided by the schedule rather than by the
# team, and the method card says so.
GRADE_WEIGHTS = {
    "scoring": 0.45,
    "management": 0.30,
    "matchup": 0.25,
}

# A player has to have been expected to do something before missing counts as
# a bust. Without a floor the award goes to a kicker who was projected 7 and
# scored 2, every week, forever.
MIN_PROJECTION_FOR_VERDICT = 8.0

# A win is only "lucky" if the score behind it would have lost most of the
# week's other matchups. At or above this all-play win rate the team simply
# won, and there is no story.
LUCKY_ALL_PLAY_MAX = 0.5

# A loss is only "unlucky" if the score would have beaten most of the league.
UNLUCKY_ALL_PLAY_MIN = 0.5


# ── loading ─────────────────────────────────────────────────────────────


def _teams(db: Session, season: int) -> Dict[int, Dict[str, Any]]:
    return {
        row.espn_team_id: {
            "espn_team_id": row.espn_team_id,
            "name": row.name,
            "abbrev": row.abbrev,
            "owner": row.owner_name,
            "logo_url": row.logo_url,
        }
        for row in _team_rows(db, season)
    }


def _week_index(db: Session, season: int) -> Tuple[List[int], List[int]]:
    """Every matchup period in the season, and the subset that finished."""
    rows = (
        db.query(FantasyLeagueMatchup.matchup_period, FantasyLeagueMatchup.is_complete)
        .filter(FantasyLeagueMatchup.season == season)
        .all()
    )
    available = sorted({period for period, _ in rows if period is not None})
    played = sorted(
        {period for period, complete in rows if period is not None and complete}
    )
    return available, played


def _matchup_rows(db: Session, season: int, week: int) -> List[FantasyLeagueMatchup]:
    return (
        db.query(FantasyLeagueMatchup)
        .filter(
            FantasyLeagueMatchup.season == season,
            FantasyLeagueMatchup.matchup_period == week,
        )
        .order_by(FantasyLeagueMatchup.espn_matchup_id)
        .all()
    )


def _status(rows: List[FantasyLeagueMatchup]) -> str:
    if not rows:
        return "not_played"
    if all(row.is_complete for row in rows):
        return "complete"
    if any(row.is_complete for row in rows):
        return "in_progress"
    # ESPN publishes the whole schedule up front, so an untouched future week
    # looks exactly like this: rows exist, nothing has been played.
    if any(row.home_points or row.away_points for row in rows):
        return "in_progress"
    return "not_played"


def _week_projections(db: Session, season: int, week: int, scoring: str) -> Dict[str, float]:
    """Consensus weekly projections, falling back to any single provider.

    The same fallback ``fantasy_league_draft._source_points`` makes: with only
    one provider collected the consensus board comes back empty, and a thinly
    collected week should still be able to say who beat expectations.
    """
    for source in (fantasy_data.CONSENSUS_SOURCE, None):
        data = fantasy_data.get_projections(
            db,
            season=season,
            week=week,
            position=None,
            scoring=scoring,
            source=source,
            limit=5000,
        )
        points = {
            row["player_id"]: float(row["projected_points"])
            for row in data.get("projections", [])
            if row.get("player_id") and row.get("projected_points") is not None
        }
        if points:
            return points
    return {}


# ── results ─────────────────────────────────────────────────────────────


def _matchup_payload(
    row: FantasyLeagueMatchup, teams: Dict[int, Dict[str, Any]]
) -> Dict[str, Any]:
    def side(team_id: Optional[int], points: Optional[float]) -> Optional[Dict[str, Any]]:
        if team_id is None:
            return None
        team = teams.get(team_id, {})
        return {
            "espn_team_id": team_id,
            "name": team.get("name"),
            "abbrev": team.get("abbrev"),
            "owner": team.get("owner"),
            "logo_url": team.get("logo_url"),
            "points": _round(points, 1),
        }

    home = side(row.home_team_id, row.home_points)
    away = side(row.away_team_id, row.away_points)
    margin = None
    if home and away and home["points"] is not None and away["points"] is not None:
        margin = _round(abs(home["points"] - away["points"]), 1)
    return {
        "espn_matchup_id": row.espn_matchup_id,
        "playoff_tier": row.playoff_tier,
        "winner": row.winner,
        "is_bye": bool(row.is_bye),
        "is_complete": bool(row.is_complete),
        "margin": margin,
        "home": home,
        "away": away,
    }


def _results(
    rows: List[FantasyLeagueMatchup], teams: Dict[int, Dict[str, Any]]
) -> Dict[int, Dict[str, Any]]:
    """One row per team that played: its score, its opponent, its result."""
    results: Dict[int, Dict[str, Any]] = {}

    def record(team_id, points, opponent_id, opponent_points, is_bye, complete):
        if team_id is None or points is None:
            return
        opponent = teams.get(opponent_id, {}) if opponent_id is not None else {}
        margin = (
            None
            if opponent_points is None
            else _round(points - opponent_points, 1)
        )
        if is_bye or opponent_id is None or margin is None:
            outcome = "bye" if is_bye else None
        elif margin > 0:
            outcome = "win"
        elif margin < 0:
            outcome = "loss"
        else:
            outcome = "tie"
        results[team_id] = {
            "points": _round(points, 1),
            "opponent": (
                {
                    "espn_team_id": opponent_id,
                    "name": opponent.get("name"),
                    "abbrev": opponent.get("abbrev"),
                    "points": _round(opponent_points, 1),
                }
                if opponent_id is not None
                else None
            ),
            "result": outcome,
            "margin": margin,
            "is_bye": bool(is_bye),
            "is_complete": bool(complete),
        }

    for row in rows:
        if not row.is_complete:
            continue
        record(
            row.home_team_id,
            row.home_points,
            row.away_team_id,
            row.away_points,
            row.is_bye,
            row.is_complete,
        )
        record(
            row.away_team_id,
            row.away_points,
            row.home_team_id,
            row.home_points,
            row.is_bye,
            row.is_complete,
        )
    return results


def all_play(scores: Dict[int, float]) -> Dict[int, Dict[str, Any]]:
    """Each team's record against every other team that played this week.

    The honest read on a one-week sample: a schedule pairs you with one
    opponent, and this is what would have happened against the other nine.
    Ties count as half a win on both sides, so the league balances.
    """
    records: Dict[int, Dict[str, Any]] = {}
    for team_id, score in scores.items():
        wins = losses = ties = 0
        for other_id, other in scores.items():
            if other_id == team_id:
                continue
            if score > other:
                wins += 1
            elif score < other:
                losses += 1
            else:
                ties += 1
        games = wins + losses + ties
        records[team_id] = {
            "wins": wins,
            "losses": losses,
            "ties": ties,
            "pct": _round((wins + ties / 2) / games, 3) if games else None,
        }
    return records


# ── lineups ─────────────────────────────────────────────────────────────


def _player_names(db: Session, player_ids: List[str]) -> Dict[str, FantasyPlayer]:
    if not player_ids:
        return {}
    return {
        row.player_id: row
        for row in db.query(FantasyPlayer)
        .filter(FantasyPlayer.player_id.in_(player_ids))
        .all()
    }


def _entry_payload(entry: Dict[str, Any]) -> Dict[str, Any]:
    delta = (
        None
        if entry["projected"] is None
        else _round(entry["points"] - entry["projected"], 1)
    )
    return {
        "player_id": entry["player_id"],
        "name": entry["name"],
        "position": entry["position"],
        "pro_team": entry["pro_team"],
        "slot": entry["slot"],
        "points": _round(entry["points"], 1),
        "projected": _round(entry["projected"], 1),
        "delta": delta,
    }


def _lineups(
    db: Session,
    season: int,
    week: int,
    team_ids: List[int],
    projections: Dict[str, float],
) -> Dict[str, Any]:
    """Started against best-possible, for every team, on the week's actuals.

    Two silences carried over from the season-long manager rating, both in the
    direction of claiming less:

      * A team whose starters are not all covered by the stat feed gets no
        efficiency at all. A short total is worse than no total, because it
        would read as a manager who left points out.
      * A bench player with no stat row is not a candidate for the optimal
        lineup: there is no record of him scoring, so it cannot be claimed he
        would have beaten the starter.

    D/ST is excluded from both sides rather than invalidating the week —
    nflverse publishes individual player actuals, not team-defense totals —
    and the excluded seats are named in the response.
    """
    season_row = next((row for row in _season_rows(db) if row.season == season), None)
    configured = _starting_slots(season_row)
    empty = {"available": False, "reason": None, "excluded_slots": [], "teams": {}}
    if not configured:
        return {**empty, "reason": "no_lineup_settings"}

    excluded_slots = sorted(
        {slot for slot in configured if slot in UNSCORED_ACTUAL_POSITIONS}
    )
    slots = [slot for slot in configured if slot not in UNSCORED_ACTUAL_POSITIONS]
    if not slots:
        return {**empty, "reason": "no_lineup_settings", "excluded_slots": excluded_slots}

    snapshots = _latest_roster_run_by_week(db, season)
    run_id = _roster_runs_for_weeks(snapshots, [week]).get(week)
    if run_id is None:
        return {**empty, "reason": "no_roster_snapshot", "excluded_slots": excluded_slots}

    actuals = _actual_points(db, season, [week])
    if not actuals:
        return {**empty, "reason": "no_actuals", "excluded_slots": excluded_slots}

    rows = (
        db.query(FantasyLeagueRosterEntry)
        .filter(
            FantasyLeagueRosterEntry.season == season,
            FantasyLeagueRosterEntry.run_id == run_id,
            FantasyLeagueRosterEntry.espn_team_id.in_(team_ids),
        )
        .all()
    )
    if not rows:
        return {**empty, "reason": "no_roster_snapshot", "excluded_slots": excluded_slots}

    players = _player_names(db, [row.player_id for row in rows if row.player_id])
    rosters: Dict[int, List[FantasyLeagueRosterEntry]] = {}
    for row in rows:
        rosters.setdefault(row.espn_team_id, []).append(row)

    teams: Dict[int, Dict[str, Any]] = {}
    for team_id, roster in rosters.items():
        started = 0.0
        starters_known = True
        unscored_starters = 0
        starters: List[Dict[str, Any]] = []
        bench: List[Dict[str, Any]] = []
        candidates: List[Dict[str, Any]] = []

        for row in roster:
            slot = row.lineup_slot
            position = row.position
            if slot in UNSCORED_ACTUAL_POSITIONS or position in UNSCORED_ACTUAL_POSITIONS:
                continue
            scored = actuals.get((week, row.player_id)) if row.player_id else None
            player = players.get(row.player_id) if row.player_id else None
            entry = {
                "player_id": row.player_id,
                "name": (player.full_name if player else None) or row.player_name_raw,
                "position": position,
                "pro_team": (player.team if player else None) or row.pro_team,
                "slot": slot,
                "points": scored,
                "projected": projections.get(row.player_id) if row.player_id else None,
                "_points": scored,
                "_position": position,
            }
            is_starter = bool(slot) and slot not in BENCH_SLOTS

            if is_starter:
                if scored is None:
                    starters_known = False
                    unscored_starters += 1
                else:
                    started += scored
                    starters.append(entry)
            elif slot in BENCH_SLOTS and slot not in INELIGIBLE_SLOTS and scored is not None:
                # Only a real bench seat. A row whose slot the collector could
                # not map is not evidence that anybody chose to sit him, and
                # IR is storage a manager cannot start from at all.
                bench.append(entry)

            if slot in INELIGIBLE_SLOTS or scored is None or not position:
                continue
            candidates.append(entry)

        optimal_entries = _optimal_lineup(slots, candidates) if candidates else []
        optimal = sum(entry["_points"] for entry in optimal_entries)
        started_ids = {
            entry["player_id"] for entry in starters if entry["player_id"]
        }
        should_have = [
            entry
            for entry in optimal_entries
            if entry["player_id"] and entry["player_id"] not in started_ids
        ]
        scorable = starters_known and optimal > 0

        starters.sort(key=lambda entry: -entry["points"])
        bench.sort(key=lambda entry: -entry["points"])
        teams[team_id] = {
            "started": _round(started, 1) if starters_known else None,
            "optimal": _round(optimal, 1) if optimal_entries else None,
            "efficiency": _round(started / optimal, 4) if scorable else None,
            "points_left": _round(optimal - started, 1) if scorable else None,
            "unscored_starters": unscored_starters,
            "best_starter": _entry_payload(starters[0]) if starters else None,
            "worst_starter": _entry_payload(starters[-1]) if starters else None,
            "bench_hero": _entry_payload(bench[0]) if bench else None,
            "starters": [_entry_payload(entry) for entry in starters],
            "bench": [_entry_payload(entry) for entry in bench],
            "should_have_started": [_entry_payload(entry) for entry in should_have],
        }

    if not any(row["efficiency"] is not None for row in teams.values()):
        return {
            **empty,
            "reason": "no_scorable_lineups",
            "excluded_slots": excluded_slots,
            "teams": teams,
        }

    run = latest_successful_run(db, "league_rosters", season)
    return {
        "available": True,
        "reason": None,
        "excluded_slots": excluded_slots,
        "as_of": iso_utc(run.finished_at) if run is not None else None,
        "teams": teams,
    }


# ── awards ──────────────────────────────────────────────────────────────
#
# One shape for every award, whether it was won by a team, a matchup or a
# single player: a winner, the number that won it, the runner-up, and the
# full ordering behind them so a card can be argued with rather than
# asserted at. ``detail`` is the free line under the name — an opponent and
# a score for a matchup award, a position and a team for a player one.


def _award(
    key: str,
    label: str,
    blurb: str,
    ranking: List[Tuple[Any, float]],
    describe,
    formatter,
    highest_wins: bool = True,
    note: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    if not ranking:
        return None
    ordered = sorted(ranking, key=lambda item: (-item[1] if highest_wins else item[1]))

    def entry(subject, value):
        return {**describe(subject), "value": _round(value), "display": formatter(value)}

    award = {
        "key": key,
        "label": label,
        "blurb": blurb,
        "winner": entry(*ordered[0]),
        "runner_up": entry(*ordered[1]) if len(ordered) > 1 else None,
        "standings": [entry(subject, value) for subject, value in ordered[:10]],
    }
    if note:
        award["note"] = note
    return award


def _team_describer(teams: Dict[int, Dict[str, Any]], results: Dict[int, Dict[str, Any]]):
    def describe(team_id: int) -> Dict[str, Any]:
        result = results.get(team_id) or {}
        opponent = result.get("opponent") or {}
        detail = None
        if opponent.get("name") and result.get("points") is not None:
            verb = {"win": "beat", "loss": "lost to", "tie": "tied"}.get(
                result.get("result"), "played"
            )
            detail = (
                f"{verb} {opponent['name']} {result['points']:g}–"
                f"{opponent['points']:g}"
            )
        return {
            "espn_team_id": team_id,
            "team": teams.get(team_id, {}).get("name"),
            "owner": teams.get(team_id, {}).get("owner"),
            "detail": detail,
        }

    return describe


def _player_describer(teams: Dict[int, Dict[str, Any]]):
    def describe(subject: Tuple[int, Dict[str, Any]]) -> Dict[str, Any]:
        team_id, entry = subject
        bits = [entry.get("position"), entry.get("pro_team")]
        if entry.get("projected") is not None:
            bits.append(f"projected {entry['projected']:g}")
        return {
            "espn_team_id": team_id,
            "team": teams.get(team_id, {}).get("name"),
            "player": entry.get("name"),
            "detail": " · ".join(bit for bit in bits if bit),
        }

    return describe


def _matchup_describer():
    def describe(matchup: Dict[str, Any]) -> Dict[str, Any]:
        home, away = matchup["home"], matchup["away"]
        winner, loser = (
            (home, away) if (home["points"] or 0) >= (away["points"] or 0) else (away, home)
        )
        return {
            "espn_team_id": winner["espn_team_id"],
            "team": winner["name"],
            "detail": (
                f"over {loser['name']} · {winner['points']:g}–{loser['points']:g}"
            ),
        }

    return describe


def _accolades(
    teams: Dict[int, Dict[str, Any]],
    results: Dict[int, Dict[str, Any]],
    matchups: List[Dict[str, Any]],
    lineups: Dict[str, Any],
    records: Dict[int, Dict[str, Any]],
    projected: Dict[int, Optional[float]],
) -> List[Dict[str, Any]]:
    points = lambda value: f"{value:,.1f} pts"
    signed = lambda value: f"{value:+.1f} pts"
    percent = lambda value: f"{value * 100:.0f}%"
    record = lambda value: f"{value * 100:.0f}% of the field"
    team_of = _team_describer(teams, results)
    player_of = _player_describer(teams)
    matchup_of = _matchup_describer()

    played = {
        team_id: row for team_id, row in results.items() if row["points"] is not None
    }
    awards: List[Optional[Dict[str, Any]]] = []

    # ── the score itself ────────────────────────────────────────────────
    scores = [(team_id, row["points"]) for team_id, row in played.items()]
    awards.append(
        _award(
            "top_score",
            "Team of the week",
            "The most points anybody put on the board.",
            scores,
            team_of,
            points,
        )
    )
    awards.append(
        _award(
            "low_score",
            "The cold shower",
            "The fewest points anybody put on the board.",
            scores,
            team_of,
            points,
            highest_wins=False,
        )
    )
    awards.append(
        _award(
            "field_beater",
            "Best against the field",
            "Record against every other team that played this week, not just "
            "the one on the schedule.",
            [
                (team_id, row["pct"])
                for team_id, row in records.items()
                if row["pct"] is not None
            ],
            team_of,
            record,
        )
    )

    # ── the manager, as distinct from the roster ────────────────────────
    lineup_teams = lineups.get("teams") or {}
    efficiencies = [
        (team_id, row["efficiency"])
        for team_id, row in lineup_teams.items()
        if row["efficiency"] is not None
    ]
    unscored = sum(
        1 for row in lineup_teams.values() if row["efficiency"] is None
    )
    coverage_note = (
        f"{unscored} team(s) had a starter the stat feed does not cover, so "
        "they are not ranked here"
        if unscored
        else None
    )
    awards.append(
        _award(
            "best_manager",
            "Best lineup set",
            "The largest share of the best legal lineup this roster could "
            "have started.",
            efficiencies,
            team_of,
            percent,
            note=coverage_note,
        )
    )
    awards.append(
        _award(
            "bench_regret",
            "Left on the bench",
            "The most points a manager could have started and did not.",
            [
                (team_id, row["points_left"])
                for team_id, row in lineup_teams.items()
                if row["points_left"] is not None
            ],
            team_of,
            points,
            note=coverage_note,
        )
    )

    # ── against expectation ─────────────────────────────────────────────
    deltas = [
        (team_id, played[team_id]["points"] - value)
        for team_id, value in projected.items()
        if value is not None and team_id in played
    ]
    awards.append(
        _award(
            "over_projection",
            "Overachiever",
            "The biggest beat on the week's projection board.",
            deltas,
            team_of,
            signed,
        )
    )
    awards.append(
        _award(
            "under_projection",
            "Underachiever",
            "The biggest miss on the week's projection board.",
            deltas,
            team_of,
            signed,
            highest_wins=False,
        )
    )

    # ── the schedule's doing, not the manager's ─────────────────────────
    # Omitted rather than handed out: in a week where every winner outscored
    # most of the league, nobody got lucky, and saying otherwise would be an
    # invented story.
    lucky = [
        (team_id, records[team_id]["pct"])
        for team_id, row in played.items()
        if row["result"] == "win"
        and records.get(team_id, {}).get("pct") is not None
        and records[team_id]["pct"] < LUCKY_ALL_PLAY_MAX
    ]
    awards.append(
        _award(
            "lucky_win",
            "Luckiest win",
            "Won the one game that counted while losing to most of the league.",
            lucky,
            team_of,
            record,
            highest_wins=False,
        )
    )
    unlucky = [
        (team_id, played[team_id]["points"])
        for team_id, row in played.items()
        if row["result"] == "loss"
        and records.get(team_id, {}).get("pct") is not None
        and records[team_id]["pct"] > UNLUCKY_ALL_PLAY_MIN
    ]
    awards.append(
        _award(
            "unlucky_loss",
            "Unluckiest loss",
            "Beat most of the league and still lost the game on the schedule.",
            unlucky,
            team_of,
            points,
        )
    )

    # ── the games ───────────────────────────────────────────────────────
    contested = [
        row
        for row in matchups
        if row["is_complete"]
        and not row["is_bye"]
        and row["margin"] is not None
        and row["away"] is not None
    ]
    awards.append(
        _award(
            "blowout",
            "Biggest blowout",
            "The widest margin on the slate.",
            [(row, row["margin"]) for row in contested],
            matchup_of,
            lambda value: f"by {value:,.1f}",
        )
    )
    awards.append(
        _award(
            "nail_biter",
            "Closest call",
            "The narrowest margin on the slate.",
            [(row, row["margin"]) for row in contested],
            matchup_of,
            lambda value: f"by {value:,.1f}",
            highest_wins=False,
        )
    )

    # ── individual players ──────────────────────────────────────────────
    starters = [
        (team_id, entry)
        for team_id, row in lineup_teams.items()
        for entry in row["starters"]
    ]
    benched = [
        (team_id, entry)
        for team_id, row in lineup_teams.items()
        for entry in row["bench"]
    ]
    awards.append(
        _award(
            "player_of_the_week",
            "Player of the week",
            "The highest-scoring player anybody actually started.",
            [(subject, subject[1]["points"]) for subject in starters],
            player_of,
            points,
        )
    )
    awards.append(
        _award(
            "bench_hero",
            "Best player nobody started",
            "The highest-scoring player who spent the week on a bench.",
            [(subject, subject[1]["points"]) for subject in benched],
            player_of,
            points,
        )
    )
    verdicts = [
        subject
        for subject in starters
        if subject[1]["delta"] is not None
        and (subject[1]["projected"] or 0) >= MIN_PROJECTION_FOR_VERDICT
    ]
    awards.append(
        _award(
            "smash",
            "Smash of the week",
            "The started player who beat his projection by the most.",
            [(subject, subject[1]["delta"]) for subject in verdicts],
            player_of,
            signed,
        )
    )
    awards.append(
        _award(
            "bust",
            "Bust of the week",
            "The started player who missed his projection by the most.",
            [(subject, subject[1]["delta"]) for subject in verdicts],
            player_of,
            signed,
            highest_wins=False,
        )
    )

    return [award for award in awards if award]


# ── expectation ─────────────────────────────────────────────────────────

# A team's expectation is the sum over the starters the projection board
# covered, and a thinly covered roster gets none at all: a short sum would
# read as a collapse when it is really a gap in the board.
MIN_PROJECTION_COVERAGE = 0.8


def _expectations(
    lineups: Dict[str, Any], team_ids: List[int]
) -> Dict[int, Optional[float]]:
    """team -> projected points for the lineup it actually started."""
    lineup_teams = lineups.get("teams") or {}
    expectations: Dict[int, Optional[float]] = {}
    for team_id in team_ids:
        entries = (lineup_teams.get(team_id) or {}).get("starters") or []
        values = [
            entry["projected"] for entry in entries if entry["projected"] is not None
        ]
        covered = len(values) / len(entries) if entries else 0.0
        expectations[team_id] = (
            _round(sum(values), 1) if covered >= MIN_PROJECTION_COVERAGE else None
        )
    return expectations


# ── callouts ────────────────────────────────────────────────────────────


def _power_movement(db: Session, season: int, week: int) -> List[Dict[str, Any]]:
    rows = (
        db.query(FantasyLeaguePowerRanking)
        .filter(
            FantasyLeaguePowerRanking.season == season,
            FantasyLeaguePowerRanking.week == week,
            FantasyLeaguePowerRanking.algorithm == "composite",
        )
        .order_by(FantasyLeaguePowerRanking.run_id.desc())
        .all()
    )
    if not rows:
        return []
    newest = rows[0].run_id
    return [
        {
            "espn_team_id": row.espn_team_id,
            "rank": row.rank,
            "previous_rank": row.previous_rank,
            "rank_delta": row.rank_delta,
        }
        for row in rows
        if row.run_id == newest
    ]


def _callouts(
    results: Dict[int, Dict[str, Any]],
    teams: Dict[int, Dict[str, Any]],
    projected: Dict[int, Optional[float]],
    movement: List[Dict[str, Any]],
) -> Dict[str, Any]:
    scores = [row["points"] for row in results.values() if row["points"] is not None]
    scoring = None
    if scores:
        scoring = {
            "high": _round(max(scores), 1),
            "low": _round(min(scores), 1),
            "median": _round(statistics.median(scores), 1),
            "average": _round(sum(scores) / len(scores), 1),
            "spread": _round(max(scores) - min(scores), 1),
            "total": _round(sum(scores), 1),
            "teams": len(scores),
        }

    beat = [
        team_id
        for team_id, value in projected.items()
        if value is not None
        and results.get(team_id, {}).get("points") is not None
        and results[team_id]["points"] > value
    ]
    expectation = (
        {"beat": len(beat), "of": sum(1 for value in projected.values() if value is not None)}
        if any(value is not None for value in projected.values())
        else None
    )

    movers = sorted(
        (row for row in movement if row["rank_delta"]),
        key=lambda row: -abs(row["rank_delta"]),
    )[:4]
    return {
        "scoring": scoring,
        "expectation": expectation,
        "movers": [
            {**row, "team": teams.get(row["espn_team_id"], {}).get("name")}
            for row in movers
        ],
    }


# ── grades ──────────────────────────────────────────────────────────────


def _weights(available: List[str]) -> Dict[str, float]:
    """Renormalise the weights over the components a team actually has.

    A team with no measurable lineup is graded on what is left rather than
    being handed a league-average management score it did not earn.
    """
    total = sum(GRADE_WEIGHTS[key] for key in available)
    if not total:
        return {}
    return {key: GRADE_WEIGHTS[key] / total for key in available}


def _grade_teams(
    teams: Dict[int, Dict[str, Any]],
    results: Dict[int, Dict[str, Any]],
    lineups: Dict[str, Any],
    records: Dict[int, Dict[str, Any]],
    projected: Dict[int, Optional[float]],
    movement: Dict[int, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    lineup_teams = lineups.get("teams") or {}
    raw: Dict[str, Dict[int, float]] = {key: {} for key in GRADE_WEIGHTS}

    for team_id, row in results.items():
        if row["points"] is None:
            continue
        raw["scoring"][team_id] = row["points"]
        if row["margin"] is not None:
            raw["matchup"][team_id] = row["margin"]
        efficiency = (lineup_teams.get(team_id) or {}).get("efficiency")
        if efficiency is not None:
            raw["management"][team_id] = efficiency

    zscores = {key: _zscores(values) for key, values in raw.items()}
    weighted: Dict[int, float] = {}
    applied: Dict[int, Dict[str, float]] = {}
    for team_id in raw["scoring"]:
        available = [key for key in GRADE_WEIGHTS if team_id in raw[key]]
        weights = _weights(available)
        applied[team_id] = weights
        weighted[team_id] = sum(
            weight * zscores[key][team_id] for key, weight in weights.items()
        )

    # Re-standardise before the curve, exactly as the draft grades do: a
    # weighted sum of z-scores has a spread well under one sigma, and reading
    # the curve off it directly parks every team in the middle letters no
    # matter how the week went.
    composites = _zscores(weighted)

    rows = []
    for team_id, result in results.items():
        if result["points"] is None:
            continue
        composite = composites.get(team_id, 0.0)
        lineup = lineup_teams.get(team_id) or {}
        expectation = projected.get(team_id)
        rows.append(
            {
                "espn_team_id": team_id,
                "team": teams.get(team_id, {}).get("name"),
                "owner": teams.get(team_id, {}).get("owner"),
                "grade": _letter(composite),
                "composite": _round(composite),
                "weighted_score": _round(weighted.get(team_id, 0.0)),
                "components": {
                    key: {
                        "raw": _round(raw[key][team_id], 3),
                        "z": _round(zscores[key].get(team_id, 0.0)),
                        "weight": applied[team_id][key],
                    }
                    for key in GRADE_WEIGHTS
                    if key in applied.get(team_id, {})
                },
                "points": result["points"],
                "opponent": result["opponent"],
                "result": result["result"],
                "margin": result["margin"],
                "all_play": records.get(team_id),
                "projected": _round(expectation, 1),
                "vs_projection": (
                    None
                    if expectation is None
                    else _round(result["points"] - expectation, 1)
                ),
                "optimal": lineup.get("optimal"),
                "efficiency": lineup.get("efficiency"),
                "points_left": lineup.get("points_left"),
                "unscored_starters": lineup.get("unscored_starters", 0),
                "best_starter": lineup.get("best_starter"),
                "worst_starter": lineup.get("worst_starter"),
                "bench_hero": lineup.get("bench_hero"),
                "should_have_started": lineup.get("should_have_started") or [],
                "power": movement.get(team_id),
            }
        )
    rows.sort(key=lambda row: -row["composite"])
    return rows


def _method(lineups: Dict[str, Any], projection_teams: int) -> Dict[str, Any]:
    """What the page has to disclose for the grades to mean anything."""
    return {
        "weights": GRADE_WEIGHTS,
        "relative": (
            "Grades are relative to this league and this week. Ten managers "
            "play the same seven days, so the points in the room are fixed "
            "and an absolute weekly grade would be meaningless."
        ),
        "components": {
            "scoring": "The points you actually started.",
            "management": (
                "The share of the best legal lineup your roster could have "
                "started, measured on real stat lines rather than "
                "projections."
            ),
            "matchup": (
                "Your margin against the team the schedule gave you. It is "
                "the smallest slice on purpose — it is the one part of the "
                "week you did not control."
            ),
        },
        "lineup_available": bool(lineups.get("available")),
        "lineup_reason": lineups.get("reason"),
        "excluded_slots": lineups.get("excluded_slots") or [],
        "roster_as_of": lineups.get("as_of"),
        "lineup_caveat": (
            "Lineup efficiency is read off the roster snapshot that was "
            "standing last in the week, joined to the individual-player stat "
            "feed. Team defenses have no row in that feed, so the D/ST seat "
            "is excluded from both sides rather than invalidating the week."
        ),
        "projection_caveat": (
            "Beats and misses are measured against the consensus projection "
            "board collected for this week."
            if projection_teams
            else "No projection board was collected for this week, so nothing "
            "is measured against expectation."
        ),
    }


# ── top level ───────────────────────────────────────────────────────────


def get_week_recap(
    db: Session,
    season: Optional[int] = None,
    week: Optional[int] = None,
    scoring: str = LEAGUE_SCORING,
) -> Dict[str, Any]:
    """Everything the weekly recap page renders, in one read."""
    season = _require_season(db, season)
    scoring = normalize_scoring(scoring)
    teams = _teams(db, season)
    available_weeks, played_weeks = _week_index(db, season)

    if week not in available_weeks:
        # Open on the newest week that was actually played, so the page lands
        # on results rather than an empty future slate.
        week = max(played_weeks) if played_weeks else (
            available_weeks[0] if available_weeks else None
        )

    base = {
        "season": season,
        "week": week,
        "scoring": scoring,
        "available_weeks": available_weeks,
        "played_weeks": played_weeks,
        "teams": list(teams.values()),
        # Always present, so a caller never has to distinguish "no lineup
        # data" from "the key is missing on this branch".
        "lineups": {
            "available": False,
            "reason": None,
            "excluded_slots": [],
            "as_of": None,
        },
    }
    if week is None:
        return {
            **base,
            "status": "not_played",
            "matchups": [],
            "grades": [],
            "accolades": [],
            "callouts": {},
            "method": _method({}, 0),
        }

    rows = _matchup_rows(db, season, week)
    status = _status(rows)
    matchups = [_matchup_payload(row, teams) for row in rows]
    results = _results(rows, teams)

    if not results:
        return {
            **base,
            "status": status,
            "matchups": matchups,
            "grades": [],
            "accolades": [],
            "callouts": {},
            "method": _method({}, 0),
        }

    projections = _week_projections(db, season, week, scoring)
    lineups = _lineups(db, season, week, list(results), projections)
    records = all_play(
        {team_id: row["points"] for team_id, row in results.items() if row["points"] is not None}
    )

    projected = _expectations(lineups, list(results))

    movement = {row["espn_team_id"]: row for row in _power_movement(db, season, week)}
    grades = _grade_teams(teams, results, lineups, records, projected, movement)
    accolades = _accolades(teams, results, matchups, lineups, records, projected)
    callouts = _callouts(results, teams, projected, list(movement.values()))

    return {
        **base,
        "status": status,
        "matchups": matchups,
        "grades": grades,
        "accolades": accolades,
        "callouts": callouts,
        "lineups": {
            "available": lineups.get("available", False),
            "reason": lineups.get("reason"),
            "excluded_slots": lineups.get("excluded_slots") or [],
            "as_of": lineups.get("as_of"),
        },
        "method": _method(lineups, sum(1 for value in projected.values() if value is not None)),
    }
