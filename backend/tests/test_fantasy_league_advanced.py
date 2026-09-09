"""Derived ledger metrics.

Pure functions, no database. The load-bearing assertions here are the
invariants — all-play wins balance against all-play losses, and luck sums to
zero across the league — because those are what catch an off-by-one in the
week-by-week fold that eyeballing a plausible-looking number would not.
"""
import pytest

from app.services import fantasy_league_advanced as A
from app.services import fantasy_league_rankings as R


def team(team_id, name=None):
    return {"espn_team_id": team_id, "name": name or f"Team {team_id}"}


def matchup(week, home, away, home_points, away_points, tier="NONE", bye=False):
    return {
        "matchup_period": week,
        "playoff_tier": tier,
        "home_team_id": home,
        "home_points": home_points,
        "away_team_id": away,
        "away_points": away_points,
        "is_bye": bye,
        "is_complete": True,
    }


def metrics_for(teams, matchups):
    return R.build_team_metrics(teams, matchups)


TEAMS = [team(1), team(2), team(3), team(4)]


# ── all-play ────────────────────────────────────────────────────────────


def test_all_play_counts_every_other_team_each_week():
    # Week 1 scores: 1 -> 120, 2 -> 90, 3 -> 100, 4 -> 80.
    matchups = [
        matchup(1, 1, 2, 120.0, 90.0),
        matchup(1, 3, 4, 100.0, 80.0),
    ]
    records = A.all_play_records(metrics_for(TEAMS, matchups))

    assert records[1] == {
        "wins": 3,
        "losses": 0,
        "ties": 0,
        "games": 3,
        "win_pct": 1.0,
    }
    assert records[3]["wins"] == 2 and records[3]["losses"] == 1
    assert records[2]["wins"] == 1 and records[2]["losses"] == 2
    assert records[4]["wins"] == 0 and records[4]["losses"] == 3


def test_all_play_wins_and_losses_balance_across_the_league():
    matchups = [
        matchup(1, 1, 2, 120.0, 90.0),
        matchup(1, 3, 4, 100.0, 80.0),
        matchup(2, 1, 3, 88.0, 111.0),
        matchup(2, 2, 4, 95.0, 104.0),
    ]
    records = A.all_play_records(metrics_for(TEAMS, matchups))

    assert sum(r["wins"] for r in records.values()) == sum(
        r["losses"] for r in records.values()
    )


def test_all_play_ties_count_as_half_on_both_sides():
    matchups = [
        matchup(1, 1, 2, 100.0, 100.0),
        matchup(1, 3, 4, 90.0, 80.0),
    ]
    records = A.all_play_records(metrics_for(TEAMS, matchups))

    assert records[1]["ties"] == 1
    assert records[2]["ties"] == 1
    assert records[1]["win_pct"] == pytest.approx((2 + 0.5) / 3)


def test_a_bye_week_is_not_an_all_play_game():
    # Team 4 sits out week 2, so week 2 is a three-team all-play round.
    matchups = [
        matchup(1, 1, 2, 120.0, 90.0),
        matchup(1, 3, 4, 100.0, 80.0),
        matchup(2, 1, 2, 100.0, 95.0),
        matchup(2, 3, None, 90.0, None, bye=True),
    ]
    records = A.all_play_records(metrics_for(TEAMS, matchups))

    # Three games in week 1, one in week 2 (only teams 1 and 2 played).
    assert records[1]["games"] == 4
    assert records[4]["games"] == 3


def test_a_single_team_week_produces_no_all_play_games():
    records = A.all_play_records(metrics_for(TEAMS, []))
    assert all(record["games"] == 0 for record in records.values())
    assert all(record["win_pct"] == 0.0 for record in records.values())


# ── expected wins and luck ──────────────────────────────────────────────


def test_expected_wins_is_games_times_all_play_percentage():
    matchups = [
        matchup(1, 1, 2, 120.0, 90.0),
        matchup(1, 3, 4, 100.0, 80.0),
    ]
    metrics = metrics_for(TEAMS, matchups)
    expected = A.expected_wins(metrics)

    # Team 1 beat everyone in week 1 and played one game.
    assert expected[1] == pytest.approx(1.0)
    assert expected[4] == pytest.approx(0.0)


def test_luck_sums_to_zero_across_the_league():
    matchups = [
        matchup(1, 1, 2, 120.0, 90.0),
        matchup(1, 3, 4, 100.0, 80.0),
        matchup(2, 1, 3, 88.0, 111.0),
        matchup(2, 2, 4, 95.0, 104.0),
        matchup(3, 1, 4, 130.0, 70.0),
        matchup(3, 2, 3, 99.0, 101.0),
    ]
    luck = A.luck_index(metrics_for(TEAMS, matchups))

    assert sum(luck.values()) == pytest.approx(0.0, abs=1e-9)


def test_a_team_that_beat_everyone_it_faced_but_scored_least_is_lucky():
    # Team 2 wins its game while posting the second-lowest score of the week.
    matchups = [
        matchup(1, 1, 3, 130.0, 125.0),
        matchup(1, 2, 4, 90.0, 80.0),
    ]
    luck = A.luck_index(metrics_for(TEAMS, matchups))

    assert luck[2] > 0
    # Team 3 lost while outscoring both of week 1's other survivors.
    assert luck[3] < 0


# ── scoring summary ─────────────────────────────────────────────────────


def test_scoring_summary_reports_range_and_spread():
    matchups = [
        matchup(1, 1, 2, 100.0, 90.0),
        matchup(2, 1, 3, 140.0, 95.0),
        matchup(3, 1, 4, 120.0, 70.0),
    ]
    summary = A.scoring_summary(metrics_for(TEAMS, matchups))[1]

    assert summary["low"] == 100.0
    assert summary["high"] == 140.0
    assert summary["median"] == 120.0
    assert summary["weeks"] == 3
    assert summary["stdev"] > 0


def test_one_week_of_scoring_has_unknown_spread_not_zero():
    matchups = [matchup(1, 1, 2, 100.0, 90.0)]
    summary = A.scoring_summary(metrics_for(TEAMS, matchups))[1]

    assert summary["stdev"] is None
    assert summary["mean"] == 100.0


def test_a_team_with_no_games_reports_no_scoring():
    summary = A.scoring_summary(metrics_for(TEAMS, []))[1]
    assert summary == {
        "low": None,
        "median": None,
        "high": None,
        "mean": None,
        "stdev": None,
        "weeks": 0,
    }


# ── playoff odds ────────────────────────────────────────────────────────


SEASON = [
    matchup(1, 1, 2, 130.0, 90.0),
    matchup(1, 3, 4, 120.0, 80.0),
    matchup(2, 1, 3, 128.0, 111.0),
    matchup(2, 2, 4, 95.0, 84.0),
]
REMAINING = [
    {"home_team_id": 1, "away_team_id": 4, "matchup_period": 3},
    {"home_team_id": 2, "away_team_id": 3, "matchup_period": 3},
]


def test_playoff_odds_are_deterministic_for_the_same_data():
    metrics = metrics_for(TEAMS, SEASON)
    first = A.playoff_odds(metrics, REMAINING, 2, simulations=500)
    second = A.playoff_odds(metrics, REMAINING, 2, simulations=500)

    assert first == second


def test_playoff_odds_total_the_number_of_bracket_places():
    metrics = metrics_for(TEAMS, SEASON)
    odds = A.playoff_odds(metrics, REMAINING, 2, simulations=500)

    assert sum(row["odds"] for row in odds.values()) == pytest.approx(2.0)


def test_the_best_team_has_better_odds_than_the_worst():
    metrics = metrics_for(TEAMS, SEASON)
    odds = A.playoff_odds(metrics, REMAINING, 2, simulations=1000)

    assert odds[1]["odds"] > odds[4]["odds"]


def test_projected_record_covers_played_and_remaining_games():
    metrics = metrics_for(TEAMS, SEASON)
    odds = A.playoff_odds(metrics, REMAINING, 2, simulations=200)

    # Two played plus one remaining for every team here.
    for team_id in (1, 2, 3, 4):
        row = odds[team_id]
        assert row["projected_wins"] + row["projected_losses"] == pytest.approx(3.0)


def test_no_playoff_places_reports_no_odds_rather_than_zero():
    metrics = metrics_for(TEAMS, SEASON)
    odds = A.playoff_odds(metrics, REMAINING, 0, simulations=100)

    assert all(row["odds"] is None for row in odds.values())


def test_a_wider_scoring_spread_survives_a_worse_record():
    # Two teams average the same; one is volatile. With games left, the
    # volatile team should have the better chance of catching a leader.
    teams = [team(1), team(2), team(3)]
    season = [
        matchup(1, 1, 2, 150.0, 100.0),
        matchup(2, 1, 3, 150.0, 100.0),
        matchup(3, 2, 3, 60.0, 100.0),
        matchup(4, 2, 1, 140.0, 150.0),
    ]
    metrics = metrics_for(teams, season)
    steady = A.scoring_summary(metrics)[3]["stdev"]
    volatile = A.scoring_summary(metrics)[2]["stdev"]

    assert volatile > steady


# ── lineup efficiency ───────────────────────────────────────────────────


def test_lineup_efficiency_is_started_over_optimal():
    result = A.lineup_efficiency(
        [
            {"started": 90.0, "optimal": 100.0},
            {"started": 120.0, "optimal": 150.0},
        ]
    )

    assert result["efficiency"] == pytest.approx(210.0 / 250.0)
    assert result["points_left"] == pytest.approx(40.0)
    assert result["weeks"] == 2


def test_a_week_nobody_scored_in_is_dropped_not_counted_as_perfect():
    result = A.lineup_efficiency(
        [
            {"started": 90.0, "optimal": 100.0},
            {"started": 0.0, "optimal": 0.0},
        ]
    )

    assert result["weeks"] == 1
    assert result["efficiency"] == pytest.approx(0.9)


def test_a_week_without_a_computable_optimal_is_skipped():
    result = A.lineup_efficiency(
        [
            {"started": 90.0, "optimal": None},
            {"started": None, "optimal": 120.0},
        ]
    )

    assert result == {"efficiency": None, "points_left": None, "weeks": 0}
