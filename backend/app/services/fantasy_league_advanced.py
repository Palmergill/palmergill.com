"""Derived season metrics for the league hub ledger.

Pure math over plain dicts — no SQLAlchemy, no I/O — for the same reason
`fantasy_league_rankings.py` is: the whole module is testable without a
database, and the read layer holds the persistence.

Everything here is a reduction over matchups the hub already stores. Nothing
in this module needs a new collection source, and the one number it cannot
produce honestly (a live in-game win probability) is deliberately absent
rather than faked from a score that is only as fresh as the last collector
pass.

Three ideas carry the ledger:

  * **All-play** is a team's record against every other team, every week. It
    answers "how would you be doing if the schedule were fair", which is the
    only honest way to separate a good team from a lucky one in a ten-team
    league five games into a season.
  * **Expected wins** turns that into a comparable number, and **luck** is
    wins minus expected wins. Luck sums to zero across the league by
    construction, which is a useful invariant to test against.
  * **Playoff odds** simulate the rest of the schedule from each team's own
    scoring distribution.
"""
import random
import statistics
from typing import Any, Dict, Iterable, List, Optional

from .fantasy_league_rankings import TeamMetrics

# Enough runs that the reported whole-percent odds are stable between calls,
# and still only a few million float draws for a ten-team league.
DEFAULT_SIMULATIONS = 10000

# A team with one completed game has no measurable spread of its own. Rather
# than treat it as perfectly predictable (stdev 0, which would make its half
# of every simulated game deterministic), fall back to how much the league as
# a whole varies week to week.
FALLBACK_STDEV = 25.0


def _weekly_scores(metrics: Dict[int, TeamMetrics]) -> Dict[int, Dict[int, float]]:
    """week -> {team_id: score}, over the weeks that counted toward the record."""
    by_week: Dict[int, Dict[int, float]] = {}
    for team_id, metric in metrics.items():
        for week, score in metric.weekly:
            if week is None:
                continue
            by_week.setdefault(week, {})[team_id] = score
    return by_week


def all_play_records(metrics: Dict[int, TeamMetrics]) -> Dict[int, Dict[str, Any]]:
    """Each team's record against every other team that played the same week.

    A team on a bye has no score that week, so it neither plays nor is played
    against — the same rule the ranking metrics use. Ties count as half a win
    on both sides, so the league's all-play wins and losses balance.
    """
    records: Dict[int, Dict[str, Any]] = {
        team_id: {"wins": 0, "losses": 0, "ties": 0, "games": 0} for team_id in metrics
    }

    for scores in _weekly_scores(metrics).values():
        if len(scores) < 2:
            continue
        for team_id, score in scores.items():
            record = records[team_id]
            for other_id, other_score in scores.items():
                if other_id == team_id:
                    continue
                record["games"] += 1
                if score > other_score:
                    record["wins"] += 1
                elif score < other_score:
                    record["losses"] += 1
                else:
                    record["ties"] += 1

    for record in records.values():
        games = record["games"]
        record["win_pct"] = (
            (record["wins"] + 0.5 * record["ties"]) / games if games else 0.0
        )
    return records


def expected_wins(
    metrics: Dict[int, TeamMetrics],
    all_play: Optional[Dict[int, Dict[str, Any]]] = None,
) -> Dict[int, float]:
    """Games played times all-play win percentage.

    This is the number of wins the schedule "should" have handed a team given
    how it actually scored, so wins minus this is a clean measure of how
    kindly the schedule treated it.

    A team that has not played reports ``None`` rather than 0.0. Both are
    arithmetically true, but 0.0 reads as a measured result — "this team was
    expected to win nothing" — where the honest answer before kickoff is that
    there is nothing to expect yet.
    """
    if all_play is None:
        all_play = all_play_records(metrics)
    return {
        team_id: (
            metric.games_played * all_play[team_id]["win_pct"]
            if metric.games_played
            else None
        )
        for team_id, metric in metrics.items()
    }


def luck_index(
    metrics: Dict[int, TeamMetrics],
    expected: Optional[Dict[int, float]] = None,
) -> Dict[int, float]:
    """Actual wins minus expected wins. Sums to zero across the league.

    Unknown wherever the expectation is: before a team has played, it has
    been neither lucky nor unlucky, and saying 0.0 claims otherwise.
    """
    if expected is None:
        expected = expected_wins(metrics)
    return {
        team_id: (
            (metric.wins + 0.5 * metric.ties) - expected[team_id]
            if expected[team_id] is not None
            else None
        )
        for team_id, metric in metrics.items()
    }


def scoring_summary(metrics: Dict[int, TeamMetrics]) -> Dict[int, Dict[str, Any]]:
    """Lowest, median, highest and spread of a team's weekly scores."""
    summary: Dict[int, Dict[str, Any]] = {}
    for team_id, metric in metrics.items():
        scores = metric.scores_by_week
        if not scores:
            summary[team_id] = {
                "low": None,
                "median": None,
                "high": None,
                "mean": None,
                "stdev": None,
                "weeks": 0,
            }
            continue
        summary[team_id] = {
            "low": min(scores),
            "median": statistics.median(scores),
            "high": max(scores),
            "mean": statistics.fmean(scores),
            # One week has no spread; report it unknown rather than 0.0, which
            # would read as "perfectly consistent".
            "stdev": statistics.stdev(scores) if len(scores) > 1 else None,
            "weeks": len(scores),
        }
    return summary


def _scoring_model(metrics: Dict[int, TeamMetrics]) -> Dict[int, Dict[str, float]]:
    """Per-team mean and spread used to draw simulated scores."""
    summary = scoring_summary(metrics)
    league_means = [row["mean"] for row in summary.values() if row["mean"] is not None]
    league_stdevs = [
        row["stdev"] for row in summary.values() if row["stdev"] is not None
    ]
    default_mean = statistics.fmean(league_means) if league_means else 100.0
    default_stdev = (
        statistics.fmean(league_stdevs) if league_stdevs else FALLBACK_STDEV
    )

    return {
        team_id: {
            "mean": row["mean"] if row["mean"] is not None else default_mean,
            "stdev": row["stdev"] if row["stdev"] is not None else default_stdev,
        }
        for team_id, row in summary.items()
    }


def playoff_odds(
    metrics: Dict[int, TeamMetrics],
    remaining: Iterable[Dict[str, Any]],
    playoff_team_count: int,
    simulations: int = DEFAULT_SIMULATIONS,
    seed: int = 17,
) -> Dict[int, Dict[str, Any]]:
    """Simulate the rest of the schedule and count how often each team seeds in.

    Scores are drawn per team from a normal fitted to that team's own weeks,
    so a boom-or-bust roster correctly gets a wider spread of outcomes than a
    metronome on the same average.

    Seeding is wins, then points for. Real leagues often seed division winners
    first; the hub does not store this league's tiebreak settings, and
    inventing one would make the number less trustworthy rather than more.

    ``seed`` is fixed so the same stored data produces the same odds on every
    request. A page that reshuffles its own numbers on reload reads as broken
    even when the noise is under a point.
    """
    remaining = list(remaining)
    if playoff_team_count <= 0 or not metrics:
        return {
            team_id: {"odds": None, "projected_wins": None, "projected_losses": None}
            for team_id in metrics
        }

    model = _scoring_model(metrics)
    games = [
        (game["home_team_id"], game["away_team_id"])
        for game in remaining
        if game.get("home_team_id") in metrics and game.get("away_team_id") in metrics
    ]

    rng = random.Random(seed)
    made = {team_id: 0 for team_id in metrics}
    total_wins = {team_id: 0.0 for team_id in metrics}

    base_wins = {
        team_id: metric.wins + 0.5 * metric.ties for team_id, metric in metrics.items()
    }
    base_points = {team_id: metric.points_for for team_id, metric in metrics.items()}

    runs = max(1, simulations)
    for _ in range(runs):
        wins = dict(base_wins)
        points = dict(base_points)
        for home_id, away_id in games:
            home_score = rng.gauss(model[home_id]["mean"], model[home_id]["stdev"])
            away_score = rng.gauss(model[away_id]["mean"], model[away_id]["stdev"])
            points[home_id] += home_score
            points[away_id] += away_score
            if home_score > away_score:
                wins[home_id] += 1
            elif away_score > home_score:
                wins[away_id] += 1
            else:
                wins[home_id] += 0.5
                wins[away_id] += 0.5

        seeded = sorted(
            metrics,
            key=lambda team_id: (-wins[team_id], -points[team_id], team_id),
        )
        for team_id in seeded[:playoff_team_count]:
            made[team_id] += 1
        for team_id in metrics:
            total_wins[team_id] += wins[team_id]

    games_each = {
        team_id: metric.games_played
        + sum(1 for home_id, away_id in games if team_id in (home_id, away_id))
        for team_id, metric in metrics.items()
    }
    return {
        team_id: {
            "odds": made[team_id] / runs,
            "projected_wins": total_wins[team_id] / runs,
            "projected_losses": games_each[team_id] - (total_wins[team_id] / runs),
        }
        for team_id in metrics
    }


def ledger_rows(
    metrics: Dict[int, TeamMetrics],
    remaining: Iterable[Dict[str, Any]],
    playoff_team_count: int,
    simulations: int = DEFAULT_SIMULATIONS,
) -> Dict[int, Dict[str, Any]]:
    """Every derived measure for every team, keyed by ESPN team id.

    One entry point so the read layer folds the matchups once rather than
    once per column.
    """
    all_play = all_play_records(metrics)
    expected = expected_wins(metrics, all_play)
    luck = luck_index(metrics, expected)
    scoring = scoring_summary(metrics)
    odds = playoff_odds(metrics, remaining, playoff_team_count, simulations)

    return {
        team_id: {
            "all_play": all_play[team_id],
            "expected_wins": expected[team_id],
            "luck": luck[team_id],
            "scoring": scoring[team_id],
            "playoff": odds[team_id],
            "weekly_scores": [
                score for _week, score in sorted(metric.weekly, key=lambda pair: pair[0])
            ],
        }
        for team_id, metric in metrics.items()
    }


def lineup_efficiency(weeks: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Share of the best legal lineup a manager actually started.

    ``weeks`` are ``{"started": float, "optimal": float}`` pairs already
    computed against *actual* points — the caller owns the roster snapshots
    and the optimiser. A week whose optimal total is zero is dropped rather
    than counted as a perfect 100%: it means nobody on the roster scored, so
    there was no decision to get right.
    """
    started = 0.0
    optimal = 0.0
    counted = 0
    for week in weeks:
        week_optimal = week.get("optimal")
        week_started = week.get("started")
        if week_optimal is None or week_started is None or week_optimal <= 0:
            continue
        started += week_started
        optimal += week_optimal
        counted += 1

    if not counted or optimal <= 0:
        return {"efficiency": None, "points_left": None, "weeks": 0}
    return {
        "efficiency": started / optimal,
        "points_left": optimal - started,
        "weeks": counted,
    }
