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
import math
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

# How many games of evidence it takes before a team's own scoring average
# outweighs the league's. This is the one number that keeps early-season
# playoff odds honest, and it is not arbitrary: for a normal-normal model the
# correct weight is the ratio of week-to-week variance to true between-team
# variance. Fantasy weeks swing about 26 points (a bad Sunday from two
# starters), while real talent separates teams by 11 or 12 a week, and
# 26² / 12² is close to five.
#
# What it buys: after one week a team is judged 1/6 on the week it played and
# 5/6 on the league, which is the honest reading of a single game. Without
# it the simulation treats a 150-point opening week as a 150-point team for
# the next thirteen, and hands out 98% and 0% before anyone has played twice.
PRIOR_GAMES = 5.0

# No fantasy team scores the same every week. A measured spread anywhere near
# zero means the data is thin, not that the team is a metronome — and a
# stdev of zero makes every simulated game deterministic, which is the same
# overconfidence PRIOR_GAMES exists to prevent, arriving by a different door.
# Real leagues sit well above this, so it never binds on live data.
MIN_STDEV = 10.0


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
    """What each team is worth a week, and how sure we are.

    Three numbers per team:

      * ``mean`` — the team's own scoring average pulled toward the league's,
        by how many games it has actually played. See ``PRIOR_GAMES``.
      * ``stdev`` — how much that team swings week to week, its own spread
        pooled with the league's on the same sliding weight, because a
        standard deviation from three weeks is mostly noise too.
      * ``mean_stdev`` — how uncertain ``mean`` itself is. The simulation
        draws a season-long strength from this once per run, so a team with
        two weeks on the board gets a genuinely wide range of seasons
        rather than thirteen more copies of the two it has played.

    That last one is the difference between a forecast and a restatement of
    the standings. A point estimate treated as fact makes every remaining
    game a foregone conclusion.
    """
    summary = scoring_summary(metrics)
    league_means = [row["mean"] for row in summary.values() if row["mean"] is not None]
    league_stdevs = [
        row["stdev"] for row in summary.values() if row["stdev"] is not None
    ]
    league_mean = statistics.fmean(league_means) if league_means else 100.0
    # Pooled, not averaged per team: a league two weeks in has a handful of
    # teams with any spread at all, and they should not speak for everyone.
    league_stdev = max(
        statistics.fmean(league_stdevs) if league_stdevs else FALLBACK_STDEV,
        MIN_STDEV,
    )

    model: Dict[int, Dict[str, float]] = {}
    for team_id, row in summary.items():
        games = row["weeks"] or 0
        weight = games / (games + PRIOR_GAMES) if games else 0.0

        own_mean = row["mean"] if row["mean"] is not None else league_mean
        mean = weight * own_mean + (1.0 - weight) * league_mean

        own_stdev = row["stdev"] if row["stdev"] is not None else league_stdev
        # Blend variances, not standard deviations: variance is what adds.
        variance = weight * (own_stdev ** 2) + (1.0 - weight) * (league_stdev ** 2)
        stdev = max(math.sqrt(variance), MIN_STDEV)

        model[team_id] = {
            "mean": mean,
            "stdev": stdev,
            # Standard error of the shrunk mean. The prior counts as games
            # already played, so this starts finite rather than infinite and
            # tightens as the season gives it real ones.
            "mean_stdev": stdev / math.sqrt(games + PRIOR_GAMES),
        }
    return model


def playoff_odds(
    metrics: Dict[int, TeamMetrics],
    remaining: Iterable[Dict[str, Any]],
    playoff_team_count: int,
    simulations: int = DEFAULT_SIMULATIONS,
    seed: int = 17,
) -> Dict[int, Dict[str, Any]]:
    """Simulate the rest of the schedule and count how often each team seeds in.

    Each run draws a team's season-long strength once, from the uncertainty
    in its shrunk average (see ``_scoring_model``), then draws each week
    around that strength. Both layers matter and they answer different
    questions: the weekly draw is "how much does this team swing", the
    strength draw is "how much of what we have seen was actually the team".

    Skipping the second is what made these odds unusable in September. A
    simulation that treats one week's score as a team's settled average
    plays out the same season ten thousand times and reports near-certainty
    about a league nobody has seen yet.

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
        # One roll of "what is this team really worth" per simulated season,
        # held fixed across that season's games. Re-drawing it per game would
        # average the uncertainty away again and put us back where we started.
        strength = {
            team_id: rng.gauss(row["mean"], row["mean_stdev"])
            for team_id, row in model.items()
        }
        for home_id, away_id in games:
            home_score = rng.gauss(strength[home_id], model[home_id]["stdev"])
            away_score = rng.gauss(strength[away_id], model[away_id]["stdev"])
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


# ── position rooms ────────────────────────────────────────────────────
#
# The ledger measures teams against each other on points and schedule. It
# cannot say *where* a team is strong, which is the question a roster page
# actually raises: is the record a quarterback, or is it four good receivers?
#
# A room is every player a team holds at one position. Rooms are compared on
# points per player-game rather than on totals, because a team carrying three
# running backs would otherwise out-score one carrying two by arithmetic
# alone.

# Display order, and the label each room prints under. Kicker and defense
# stay separate even though they share a slot's worth of attention: only one
# of them has an actuals feed, and a combined room would print a bar that
# silently means "kicker".
ROOMS = (
    ("QB", "Quarterback", frozenset({"QB"})),
    ("RB", "Running back", frozenset({"RB"})),
    ("WR", "Wide receiver", frozenset({"WR"})),
    ("TE", "Tight end", frozenset({"TE"})),
    ("K", "Kicker", frozenset({"K", "PK"})),
    ("DST", "Defense", frozenset({"DEF", "DST", "D/ST"})),
)


def _room_key(position: Optional[str]) -> Optional[str]:
    """Which room a roster position belongs to, or None when it fits none."""
    upper = (position or "").upper()
    for key, _label, members in ROOMS:
        if upper in members:
            return key
    return None


def position_rooms(
    rosters: Dict[int, List[Dict[str, Any]]],
    production: Dict[str, Dict[str, float]],
) -> Dict[int, List[Dict[str, Any]]]:
    """Each team's rooms, measured against the league at the same position.

    ``rosters`` is ``{team_id: [{"player_id", "position", ...}]}`` and
    ``production`` is ``{player_id: {"games", "points"}}`` for the season so
    far. Both come from the read layer; nothing here touches a database.

    A room with no scored games — a defense, whose weekly feed has no row for
    a team unit, or a roster of players who have not played — reports
    ``points_per_game: None`` and takes no rank. That is the same discipline
    the ledger's charts follow: a number that cannot be computed renders as
    nothing rather than as a zero.
    """
    # team -> room -> accumulated games and points, plus the per-player lines
    # the roster page prints next to each name.
    tallies: Dict[int, Dict[str, Dict[str, Any]]] = {}
    for team_id, entries in rosters.items():
        by_room: Dict[str, Dict[str, Any]] = {
            key: {"games": 0, "points": 0.0, "players": {}} for key, _l, _m in ROOMS
        }
        for entry in entries:
            key = _room_key(entry.get("position"))
            if key is None:
                continue
            player_id = entry.get("player_id")
            line = production.get(player_id) if player_id else None
            games = int((line or {}).get("games") or 0)
            points = float((line or {}).get("points") or 0.0)
            if player_id:
                by_room[key]["players"][player_id] = {
                    "player_id": player_id,
                    "games": games,
                    "points": round(points, 1) if games else None,
                    "points_per_game": round(points / games, 1) if games else None,
                }
            if games:
                by_room[key]["games"] += games
                by_room[key]["points"] += points
        tallies[team_id] = by_room

    # One ranking per room, over the teams that have a number at all, so a
    # league where two defenses are unscored still ranks the other eight
    # honestly rather than sinking them to the bottom.
    ranks: Dict[str, Dict[int, int]] = {}
    counts: Dict[str, int] = {}
    for key, _label, _members in ROOMS:
        scored = [
            (team_id, room["points"] / room["games"])
            for team_id, rooms in tallies.items()
            for room in [rooms[key]]
            if room["games"]
        ]
        scored.sort(key=lambda pair: pair[1], reverse=True)
        ranks[key] = {team_id: index + 1 for index, (team_id, _ppg) in enumerate(scored)}
        counts[key] = len(scored)

    result: Dict[int, List[Dict[str, Any]]] = {}
    for team_id, rooms in tallies.items():
        lines = []
        for key, label, _members in ROOMS:
            room = rooms[key]
            ppg = room["points"] / room["games"] if room["games"] else None
            league = [
                other[key]["points"] / other[key]["games"]
                for other in tallies.values()
                if other[key]["games"]
            ]
            lines.append(
                {
                    "position": key,
                    "label": label,
                    "players": room["players"],
                    "games": room["games"],
                    "points_per_game": round(ppg, 1) if ppg is not None else None,
                    "league_average": (
                        round(sum(league) / len(league), 1) if league else None
                    ),
                    "rank": ranks[key].get(team_id),
                    "teams": counts[key],
                }
            )
        result[team_id] = lines
    return result
