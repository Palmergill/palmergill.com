"""Power ranking algorithms for the ESPN league hub (spec 17).

Pure math over plain dicts — no SQLAlchemy, no I/O — so the whole module is
testable without a database and the collector can hold the persistence.

Prior art: ported from the standalone fantasyfootball prototype
(github.com/Palmergill/fantasyfootball, `backend/app/utils/ranking_algorithms.py`).
Five defects were fixed in the port; each has a regression test in
`tests/test_fantasy_league_rankings.py`:

  1. Recent form ordered scores by *value* and took the last four, so it
     scored the four best weeks rather than the four most recent.
  2. Head-to-head used truthiness on scores, silently dropping a legitimate
     0.0 (a real, if bleak, fantasy result).
  3. Teams with no completed games fell back to `points_for / max(1, 0)`,
     reporting a whole season's points as a per-game average.
  4. Playoff and consolation games were counted as regular-season results,
     which distorts every record- and schedule-based metric.
  5. Byes were counted as games, inventing a phantom opponent in strength of
     schedule.

Known and deliberate: strength of schedule uses each opponent's *full-season*
win percentage even when computing through week N. It is mildly
self-referential, but it is what most public power rankings do and it avoids
an iterative solve for a ten-team league.
"""
import statistics
from typing import Any, Dict, Iterable, List, Optional

# Weights for the composite. These are the prototype's, kept as-is: record
# dominates, scoring backs it up, and the softer signals only break ties.
DEFAULT_WEIGHTS = {
    "record": 0.30,
    "points_differential": 0.25,
    "strength_of_schedule": 0.20,
    "consistency": 0.10,
    "recent_form": 0.10,
    "head_to_head": 0.05,
}

ALGORITHMS = (
    "composite",
    "record",
    "points_differential",
    "strength_of_schedule",
    "consistency",
    "recent_form",
    "head_to_head",
)

RECENT_FORM_GAMES = 4


class TeamMetrics:
    """Per-team inputs every algorithm reads from."""

    def __init__(self, espn_team_id: int, name: Optional[str] = None):
        self.espn_team_id = espn_team_id
        self.name = name
        self.wins = 0
        self.losses = 0
        self.ties = 0
        self.points_for = 0.0
        self.points_against = 0.0
        # (week, score) so recent form can order by *when*, not by how big.
        self.weekly: List[tuple] = []
        self.opponent_ids: List[int] = []
        self.head_to_head: Dict[int, List[int]] = {}  # opponent -> [wins, losses]

    @property
    def games_played(self) -> int:
        return self.wins + self.losses + self.ties

    @property
    def win_percentage(self) -> float:
        games = self.games_played
        if not games:
            return 0.0
        return (self.wins + 0.5 * self.ties) / games

    @property
    def point_differential(self) -> float:
        return self.points_for - self.points_against

    @property
    def scores_by_week(self) -> List[float]:
        return [score for _, score in sorted(self.weekly, key=lambda pair: pair[0])]

    @property
    def recent_scores(self) -> List[float]:
        return self.scores_by_week[-RECENT_FORM_GAMES:]

    @property
    def average_score(self) -> float:
        scores = self.scores_by_week
        return statistics.mean(scores) if scores else 0.0


def _counts_toward_record(matchup: Dict[str, Any]) -> bool:
    """Regular-season head-to-head games only.

    Playoff and consolation-ladder games are real, but folding them into the
    record- and schedule-based metrics distorts them: a consolation bracket
    pits the worst teams against each other, so those wins are not comparable
    to regular-season wins. Byes are excluded because there is no opponent.
    """
    if matchup.get("is_bye"):
        return False
    if not matchup.get("is_complete"):
        return False
    if (matchup.get("playoff_tier") or "NONE") != "NONE":
        return False
    return matchup.get("away_team_id") is not None


def build_team_metrics(
    teams: Iterable[Dict[str, Any]],
    matchups: Iterable[Dict[str, Any]],
    through_week: Optional[int] = None,
) -> Dict[int, TeamMetrics]:
    """Fold completed regular-season matchups into per-team metrics.

    Records are derived from the matchups rather than read off ESPN's team
    rows so that `through_week` produces a real point-in-time standing.
    """
    metrics: Dict[int, TeamMetrics] = {}
    for team in teams:
        team_id = team.get("espn_team_id")
        if team_id is None:
            continue
        metrics[team_id] = TeamMetrics(team_id, team.get("name"))

    for matchup in matchups:
        if not _counts_toward_record(matchup):
            continue
        week = matchup.get("matchup_period")
        if through_week is not None and (week is None or week > through_week):
            continue
        home_id = matchup.get("home_team_id")
        away_id = matchup.get("away_team_id")
        home = metrics.get(home_id)
        away = metrics.get(away_id)
        if home is None or away is None:
            continue
        home_points = matchup.get("home_points")
        away_points = matchup.get("away_points")
        # `is not None`, not truthiness: 0.0 is a real fantasy score.
        if home_points is None or away_points is None:
            continue

        home.points_for += home_points
        home.points_against += away_points
        away.points_for += away_points
        away.points_against += home_points
        home.weekly.append((week, home_points))
        away.weekly.append((week, away_points))
        home.opponent_ids.append(away_id)
        away.opponent_ids.append(home_id)
        home.head_to_head.setdefault(away_id, [0, 0])
        away.head_to_head.setdefault(home_id, [0, 0])

        if home_points > away_points:
            home.wins += 1
            away.losses += 1
            home.head_to_head[away_id][0] += 1
            away.head_to_head[home_id][1] += 1
        elif away_points > home_points:
            away.wins += 1
            home.losses += 1
            away.head_to_head[home_id][0] += 1
            home.head_to_head[away_id][1] += 1
        else:
            home.ties += 1
            away.ties += 1

    return metrics


# ── individual algorithms ───────────────────────────────────────────────


def record_ranking(metrics: Dict[int, TeamMetrics]) -> Dict[int, float]:
    """Win percentage, with points for as the tiebreaker."""
    return {
        team_id: metric.win_percentage * 1000 + (metric.points_for / 100)
        for team_id, metric in metrics.items()
    }


def points_differential_ranking(metrics: Dict[int, TeamMetrics]) -> Dict[int, float]:
    return {team_id: metric.point_differential for team_id, metric in metrics.items()}


def strength_of_schedule_ranking(metrics: Dict[int, TeamMetrics]) -> Dict[int, float]:
    """Win percentage nudged up for teams that faced tougher opponents."""
    scores = {}
    for team_id, metric in metrics.items():
        opponents = [
            metrics[opponent_id].win_percentage
            for opponent_id in metric.opponent_ids
            if opponent_id in metrics
        ]
        if not opponents:
            scores[team_id] = metric.win_percentage
        else:
            scores[team_id] = metric.win_percentage + (statistics.mean(opponents) * 0.3)
    return scores


def consistency_ranking(metrics: Dict[int, TeamMetrics]) -> Dict[int, float]:
    """Reward a high average, penalize volatility around it."""
    scores = {}
    for team_id, metric in metrics.items():
        weekly = metric.scores_by_week
        if not weekly:
            scores[team_id] = 0.0  # no games played is not a perfect score
        elif len(weekly) < 2:
            scores[team_id] = weekly[0]
        else:
            scores[team_id] = statistics.mean(weekly) - (statistics.stdev(weekly) * 0.5)
    return scores


def recent_form_ranking(metrics: Dict[int, TeamMetrics]) -> Dict[int, float]:
    """Average of the last four games *by week*, not the four best."""
    scores = {}
    for team_id, metric in metrics.items():
        recent = metric.recent_scores
        scores[team_id] = statistics.mean(recent) if recent else 0.0
    return scores


def head_to_head_ranking(metrics: Dict[int, TeamMetrics]) -> Dict[int, float]:
    """Win percentage with a small bonus for beating the teams you played."""
    scores = {}
    for team_id, metric in metrics.items():
        bonus = 0.0
        for wins, losses in metric.head_to_head.values():
            played = wins + losses
            if played:
                bonus += (wins / played) * 0.1
        scores[team_id] = metric.win_percentage + bonus
    return scores


ALGORITHM_FUNCTIONS = {
    "record": record_ranking,
    "points_differential": points_differential_ranking,
    "strength_of_schedule": strength_of_schedule_ranking,
    "consistency": consistency_ranking,
    "recent_form": recent_form_ranking,
    "head_to_head": head_to_head_ranking,
}


def min_max_normalize(scores: Dict[int, float]) -> Dict[int, float]:
    """Scale to 0-1. A flat slate maps to 0.5 rather than dividing by zero."""
    if not scores:
        return {}
    lowest = min(scores.values())
    highest = max(scores.values())
    spread = highest - lowest
    if spread == 0:
        return {team_id: 0.5 for team_id in scores}
    return {team_id: (score - lowest) / spread for team_id, score in scores.items()}


def composite_ranking(
    metrics: Dict[int, TeamMetrics],
    weights: Optional[Dict[str, float]] = None,
) -> Dict[int, float]:
    """Weighted blend of the six algorithms, each normalized to 0-1 first.

    Normalizing before weighting is what makes the blend meaningful: raw
    point differentials and win percentages are on wildly different scales.
    Weights are renormalized by the total actually applied, so dropping an
    algorithm does not silently shrink everyone's score.
    """
    weights = weights or DEFAULT_WEIGHTS
    normalized = {
        name: min_max_normalize(function(metrics))
        for name, function in ALGORITHM_FUNCTIONS.items()
    }

    composite = {}
    for team_id in metrics:
        total = 0.0
        applied = 0.0
        for name, weight in weights.items():
            table = normalized.get(name)
            if table and team_id in table:
                total += table[team_id] * weight
                applied += weight
        composite[team_id] = total / applied if applied else 0.0
    return composite


def score_all(
    metrics: Dict[int, TeamMetrics],
    weights: Optional[Dict[str, float]] = None,
) -> Dict[str, Dict[int, float]]:
    scores = {name: function(metrics) for name, function in ALGORITHM_FUNCTIONS.items()}
    scores["composite"] = composite_ranking(metrics, weights)
    return scores


def rank_scores(
    scores: Dict[int, float], metrics: Dict[int, TeamMetrics]
) -> List[Dict[str, Any]]:
    """Order by score, breaking ties on points for and then team id.

    The tiebreak chain has to be total so a rerun cannot reshuffle equal teams
    and manufacture phantom rank movement.
    """
    ordered = sorted(
        scores.items(),
        key=lambda item: (
            -item[1],
            -(metrics[item[0]].points_for if item[0] in metrics else 0.0),
            item[0],
        ),
    )
    return [
        {"espn_team_id": team_id, "rank": index, "score": score}
        for index, (team_id, score) in enumerate(ordered, start=1)
    ]


def rank_all(
    teams: Iterable[Dict[str, Any]],
    matchups: Iterable[Dict[str, Any]],
    through_week: Optional[int] = None,
    weights: Optional[Dict[str, float]] = None,
) -> Dict[str, List[Dict[str, Any]]]:
    """Ranked tables for every algorithm, cumulative through `through_week`."""
    teams = list(teams)
    matchups = list(matchups)
    metrics = build_team_metrics(teams, matchups, through_week)
    return {
        name: rank_scores(scores, metrics)
        for name, scores in score_all(metrics, weights).items()
    }


def completed_weeks(matchups: Iterable[Dict[str, Any]]) -> List[int]:
    """Regular-season weeks that have at least one finished game."""
    weeks = {
        matchup.get("matchup_period")
        for matchup in matchups
        if _counts_toward_record(matchup) and matchup.get("matchup_period") is not None
    }
    return sorted(weeks)


def rank_history(
    teams: Iterable[Dict[str, Any]],
    matchups: Iterable[Dict[str, Any]],
    weights: Optional[Dict[str, float]] = None,
) -> List[Dict[str, Any]]:
    """Cumulative rankings for every completed week, with movement.

    `rank_delta` is materialized here (positive = moved up) so neither the
    read layer nor the front end has to self-join week N against N-1.
    """
    teams = list(teams)
    matchups = list(matchups)
    rows: List[Dict[str, Any]] = []
    previous: Dict[str, Dict[int, int]] = {}

    for week in completed_weeks(matchups):
        tables = rank_all(teams, matchups, through_week=week, weights=weights)
        for algorithm, table in tables.items():
            prior = previous.get(algorithm, {})
            for entry in table:
                team_id = entry["espn_team_id"]
                previous_rank = prior.get(team_id)
                rows.append(
                    {
                        "week": week,
                        "algorithm": algorithm,
                        "espn_team_id": team_id,
                        "rank": entry["rank"],
                        "score": entry["score"],
                        "previous_rank": previous_rank,
                        "rank_delta": (
                            previous_rank - entry["rank"]
                            if previous_rank is not None
                            else None
                        ),
                    }
                )
            previous[algorithm] = {
                entry["espn_team_id"]: entry["rank"] for entry in table
            }
    return rows
