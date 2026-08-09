"""Power ranking math.

Pure functions, no database. Several cases are explicit regressions against
defects in the prototype these algorithms were ported from — those are marked
and assert the *wrong* answer is not produced, so a future refactor that
reintroduces the bug fails loudly instead of quietly changing the standings.
"""
import pytest

from app.services import fantasy_league_rankings as R


def team(team_id, name=None):
    return {"espn_team_id": team_id, "name": name or f"Team {team_id}"}


def matchup(
    week,
    home,
    away,
    home_points,
    away_points,
    tier="NONE",
    complete=True,
    bye=False,
):
    winner = "UNDECIDED"
    if complete and not bye:
        if home_points > away_points:
            winner = "HOME"
        elif away_points > home_points:
            winner = "AWAY"
        else:
            winner = "TIE"
    return {
        "matchup_period": week,
        "playoff_tier": tier,
        "winner": winner,
        "home_team_id": home,
        "home_points": home_points,
        "away_team_id": away,
        "away_points": away_points,
        "is_bye": bye,
        "is_complete": complete,
    }


TEAMS = [team(1), team(2), team(3), team(4)]


def test_records_are_derived_from_matchups():
    matchups = [
        matchup(1, 1, 2, 100.0, 90.0),
        matchup(2, 1, 3, 80.0, 95.0),
        matchup(3, 1, 4, 70.0, 70.0),
    ]
    metrics = R.build_team_metrics(TEAMS, matchups)
    one = metrics[1]
    assert (one.wins, one.losses, one.ties) == (1, 1, 1)
    assert one.points_for == pytest.approx(250.0)
    assert one.points_against == pytest.approx(255.0)
    assert one.win_percentage == pytest.approx(0.5)  # a tie counts as half


# ── regression: recent form must order by week, not by score ────────────


def test_recent_form_uses_the_last_four_weeks_not_the_best_four():
    """Prototype sorted scores ascending then took [-4:], scoring the four
    *highest* weeks. With a big week 1 and a slump after, that inverts the
    entire meaning of "recent form"."""
    matchups = [
        matchup(1, 1, 2, 150.0, 10.0),
        matchup(2, 1, 2, 90.0, 10.0),
        matchup(3, 1, 2, 95.0, 10.0),
        matchup(4, 1, 2, 100.0, 10.0),
        matchup(5, 1, 2, 105.0, 10.0),
    ]
    metrics = R.build_team_metrics(TEAMS, matchups)
    assert metrics[1].scores_by_week == [150.0, 90.0, 95.0, 100.0, 105.0]
    assert metrics[1].recent_scores == [90.0, 95.0, 100.0, 105.0]

    scores = R.recent_form_ranking(metrics)
    assert scores[1] == pytest.approx(97.5)
    assert scores[1] != pytest.approx(112.5)  # the buggy "four best" answer


# ── regression: a 0.0 score is real and must not be dropped ─────────────


def test_zero_score_still_records_a_result():
    """Prototype used `if home_score and away_score`, so a 0.0 silently
    dropped the whole game from head-to-head and the record."""
    matchups = [matchup(1, 1, 2, 0.0, 88.4)]
    metrics = R.build_team_metrics(TEAMS, matchups)

    assert (metrics[1].wins, metrics[1].losses) == (0, 1)
    assert (metrics[2].wins, metrics[2].losses) == (1, 0)
    assert metrics[2].head_to_head[1] == [1, 0]
    assert metrics[1].head_to_head[2] == [0, 1]


# ── regression: no games played is not a great season ───────────────────


def test_teams_with_no_games_score_zero_not_points_for():
    """Prototype divided by `max(1, len(scores))`, so a team with no games
    reported its entire points-for as a per-game average."""
    metrics = R.build_team_metrics(TEAMS, [])
    assert R.consistency_ranking(metrics) == {1: 0.0, 2: 0.0, 3: 0.0, 4: 0.0}
    assert R.recent_form_ranking(metrics) == {1: 0.0, 2: 0.0, 3: 0.0, 4: 0.0}


# ── regression: playoff/consolation games are not regular-season results ─


def test_playoff_and_consolation_games_are_excluded_from_metrics():
    matchups = [
        matchup(1, 1, 2, 100.0, 90.0),
        matchup(15, 1, 2, 10.0, 200.0, tier="WINNERS_BRACKET"),
        matchup(16, 1, 2, 10.0, 200.0, tier="LOSERS_CONSOLATION_LADDER"),
    ]
    metrics = R.build_team_metrics(TEAMS, matchups)
    assert (metrics[1].wins, metrics[1].losses) == (1, 0)
    assert metrics[1].points_for == pytest.approx(100.0)


def test_byes_do_not_create_a_phantom_opponent():
    matchups = [
        matchup(1, 1, 2, 100.0, 90.0),
        matchup(2, 1, None, 88.0, None, bye=True, complete=False),
    ]
    metrics = R.build_team_metrics(TEAMS, matchups)
    assert metrics[1].games_played == 1
    assert metrics[1].opponent_ids == [2]


def test_incomplete_games_are_excluded():
    matchups = [matchup(1, 1, 2, 0.0, 0.0, complete=False)]
    metrics = R.build_team_metrics(TEAMS, matchups)
    assert metrics[1].games_played == 0


# ── normalization, composite, ordering ──────────────────────────────────


def test_min_max_normalize_handles_a_flat_slate():
    assert R.min_max_normalize({1: 5.0, 2: 5.0, 3: 5.0}) == {1: 0.5, 2: 0.5, 3: 0.5}
    assert R.min_max_normalize({}) == {}
    assert R.min_max_normalize({1: 0.0, 2: 10.0}) == {1: 0.0, 2: 1.0}


def test_default_weights_sum_to_one():
    assert sum(R.DEFAULT_WEIGHTS.values()) == pytest.approx(1.0)


def test_composite_renormalizes_when_an_algorithm_is_dropped():
    """Halving the weight set must not halve everyone's score."""
    matchups = [
        matchup(1, 1, 2, 120.0, 90.0),
        matchup(2, 3, 4, 110.0, 100.0),
        matchup(3, 1, 3, 130.0, 95.0),
    ]
    metrics = R.build_team_metrics(TEAMS, matchups)
    partial = R.composite_ranking(metrics, {"record": 0.5})
    full_record = R.min_max_normalize(R.record_ranking(metrics))
    assert partial == pytest.approx(full_record)


def test_ranking_tiebreak_is_total_and_deterministic():
    """Equal scores fall back to points for, then team id — never to dict
    ordering, which would manufacture phantom rank movement on a rerun."""
    metrics = R.build_team_metrics(TEAMS, [matchup(1, 1, 2, 100.0, 50.0)])
    metrics[3].points_for = 10.0
    metrics[4].points_for = 20.0
    ranked = R.rank_scores({1: 1.0, 2: 1.0, 3: 1.0, 4: 1.0}, metrics)
    # team 1 scored 100, team 4 has 20, team 3 has 10, team 2 has 50.
    assert [row["espn_team_id"] for row in ranked] == [1, 2, 4, 3]


def test_rank_all_returns_every_algorithm():
    matchups = [matchup(1, 1, 2, 100.0, 90.0), matchup(1, 3, 4, 80.0, 70.0)]
    tables = R.rank_all(TEAMS, matchups)
    assert set(tables) == set(R.ALGORITHMS)
    for table in tables.values():
        assert [row["rank"] for row in table] == [1, 2, 3, 4]


def test_rankings_move_as_weeks_accumulate():
    """Cumulative ranking through different weeks must actually differ,
    otherwise the movement arrows are decoration."""
    matchups = [
        matchup(1, 1, 2, 150.0, 60.0),
        matchup(1, 3, 4, 70.0, 65.0),
        matchup(2, 1, 3, 50.0, 140.0),
        matchup(2, 2, 4, 130.0, 60.0),
        matchup(3, 1, 4, 40.0, 120.0),
        matchup(3, 2, 3, 135.0, 90.0),
    ]
    through_one = R.rank_all(TEAMS, matchups, through_week=1)["composite"]
    through_three = R.rank_all(TEAMS, matchups, through_week=3)["composite"]
    assert [row["espn_team_id"] for row in through_one] != [
        row["espn_team_id"] for row in through_three
    ]


# ── history and movement ────────────────────────────────────────────────


def test_completed_weeks_lists_only_finished_regular_season_weeks():
    matchups = [
        matchup(1, 1, 2, 100.0, 90.0),
        matchup(2, 1, 2, 0.0, 0.0, complete=False),
        matchup(3, 1, 2, 90.0, 80.0),
        matchup(15, 1, 2, 90.0, 80.0, tier="WINNERS_BRACKET"),
    ]
    assert R.completed_weeks(matchups) == [1, 3]


def test_rank_history_materializes_movement():
    matchups = [
        matchup(1, 1, 2, 150.0, 60.0),
        matchup(1, 3, 4, 70.0, 65.0),
        matchup(2, 1, 3, 50.0, 140.0),
        matchup(2, 2, 4, 130.0, 60.0),
    ]
    rows = R.rank_history(TEAMS, matchups)
    weeks = sorted({row["week"] for row in rows})
    assert weeks == [1, 2]

    first_week = [r for r in rows if r["week"] == 1 and r["algorithm"] == "composite"]
    assert all(row["previous_rank"] is None for row in first_week)
    assert all(row["rank_delta"] is None for row in first_week)

    second_week = [r for r in rows if r["week"] == 2 and r["algorithm"] == "composite"]
    assert all(row["previous_rank"] is not None for row in second_week)
    for row in second_week:
        assert row["rank_delta"] == row["previous_rank"] - row["rank"]

    # Every algorithm gets a full table each week.
    assert len(rows) == len(weeks) * len(R.ALGORITHMS) * len(TEAMS)


def test_rank_history_is_empty_before_any_game_is_played():
    assert R.rank_history(TEAMS, []) == []
