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


def test_a_team_that_has_not_played_has_no_expectation_and_no_luck():
    """Before kickoff every one of these is 0.0 arithmetically, and every one
    of them would read on the page as a measured result."""
    metrics = metrics_for(TEAMS, [])

    assert A.expected_wins(metrics) == {1: None, 2: None, 3: None, 4: None}
    assert A.luck_index(metrics) == {1: None, 2: None, 3: None, 4: None}


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


# ── position rooms ─────────────────────────────────────────────────────
#
# Numbers are chosen so every average below divides exactly by hand.


def spot(player_id, position):
    return {"player_id": player_id, "position": position}


def test_a_room_scores_points_per_player_game_not_per_total():
    # Team 1 carries three backs, team 2 carries two. Team 1 has more points
    # and the worse room; a total would say the opposite.
    rosters = {
        1: [spot("a", "RB"), spot("b", "RB"), spot("c", "RB")],
        2: [spot("d", "RB"), spot("e", "RB")],
    }
    production = {
        "a": {"games": 10, "points": 100.0},
        "b": {"games": 10, "points": 100.0},
        "c": {"games": 10, "points": 100.0},
        "d": {"games": 10, "points": 150.0},
        "e": {"games": 10, "points": 150.0},
    }

    rooms = A.position_rooms(rosters, production)
    first = next(r for r in rooms[1] if r["position"] == "RB")
    second = next(r for r in rooms[2] if r["position"] == "RB")

    assert first["points_per_game"] == 10.0
    assert second["points_per_game"] == 15.0
    assert first["rank"] == 2
    assert second["rank"] == 1
    assert first["league_average"] == 12.5


def test_a_room_nobody_has_played_takes_no_rank():
    rosters = {1: [spot("a", "DST")], 2: [spot("b", "DST")]}

    rooms = A.position_rooms(rosters, {})
    room = next(r for r in rooms[1] if r["position"] == "DST")

    assert room["points_per_game"] is None
    assert room["league_average"] is None
    assert room["rank"] is None
    assert room["teams"] == 0


def test_ranking_counts_only_the_teams_that_have_a_number():
    rosters = {
        1: [spot("a", "TE")],
        2: [spot("b", "TE")],
        3: [spot("c", "TE")],
    }
    production = {"a": {"games": 4, "points": 40.0}, "b": {"games": 4, "points": 20.0}}

    rooms = A.position_rooms(rosters, production)
    ranked = {t: next(r for r in rooms[t] if r["position"] == "TE") for t in (1, 2, 3)}

    assert ranked[1]["rank"] == 1
    assert ranked[2]["rank"] == 2
    assert ranked[3]["rank"] is None
    assert ranked[1]["teams"] == 2


def test_an_unplayed_player_is_listed_without_inventing_a_zero():
    rosters = {1: [spot("a", "WR"), spot("b", "WR")]}
    production = {"a": {"games": 5, "points": 60.0}}

    room = next(r for r in A.position_rooms(rosters, production)[1] if r["position"] == "WR")

    assert room["players"]["b"] == {
        "player_id": "b",
        "games": 0,
        "points": None,
        "points_per_game": None,
    }
    # The empty player does not drag the room's average toward zero.
    assert room["points_per_game"] == 12.0


def test_an_unmatched_player_has_no_line_at_all():
    rosters = {1: [{"player_id": None, "position": "WR"}, spot("a", "WR")]}
    production = {"a": {"games": 2, "points": 30.0}}

    room = next(r for r in A.position_rooms(rosters, production)[1] if r["position"] == "WR")

    assert list(room["players"]) == ["a"]
    assert room["points_per_game"] == 15.0


def test_kicker_and_defense_stay_separate_rooms():
    rosters = {1: [spot("a", "K"), spot("b", "DEF")]}
    production = {"a": {"games": 4, "points": 32.0}}

    rooms = {room["position"]: room for room in A.position_rooms(rosters, production)[1]}

    assert rooms["K"]["points_per_game"] == 8.0
    assert rooms["DST"]["points_per_game"] is None
    assert [room["label"] for room in A.position_rooms(rosters, production)[1]] == [
        "Quarterback",
        "Running back",
        "Wide receiver",
        "Tight end",
        "Kicker",
        "Defense",
    ]


def test_a_flex_receiver_lands_in_the_receiver_room():
    # Rooms key on the player's position, not the slot he happens to fill.
    rosters = {1: [{"player_id": "a", "position": "WR", "lineup_slot": "FLEX"}]}

    room = next(
        r for r in A.position_rooms(rosters, {"a": {"games": 3, "points": 36.0}})[1]
        if r["position"] == "WR"
    )

    assert room["points_per_game"] == 12.0


# ── playoff odds early in a season ──────────────────────────────────────
#
# These are the regression for the September 2026 bug: one week into the
# season the hub was reporting 98% for one team and 0% for another. The
# simulation was fitting each team's average to the handful of weeks it had
# played and then treating that average as settled fact for the thirteen
# games left, so it played out the same season ten thousand times.
#
# The fix is in _scoring_model: a team's own average is pulled toward the
# league's by how many games it has actually played, and the leftover
# uncertainty in that average is drawn once per simulated season. The tests
# below pin the behaviour that matters — early odds are uncertain, late odds
# are not, and the total is always the number of places on offer.


def league_of(scores_by_week, teams=10):
    """Build metrics from [{team_id: score}, ...], one dict per week."""
    season = []
    for week, scores in enumerate(scores_by_week, start=1):
        ids = sorted(scores)
        for home, away in zip(ids[::2], ids[1::2]):
            season.append(matchup(week, home, away, scores[home], scores[away]))
    return metrics_for([team(i) for i in range(1, teams + 1)], season)


def schedule_after(played, weeks, teams=10):
    """Every remaining regular-season game, round-robin style."""
    games = []
    ids = list(range(1, teams + 1))
    for week in range(played + 1, weeks + 1):
        rot = ids[1:]
        k = (week - 1) % len(rot)
        order = [ids[0]] + rot[k:] + rot[:k]
        for i in range(teams // 2):
            games.append(
                {
                    "matchup_period": week,
                    "playoff_tier": "NONE",
                    "home_team_id": order[i],
                    "away_team_id": order[teams - 1 - i],
                    "home_points": None,
                    "away_points": None,
                    "is_bye": False,
                    "is_complete": False,
                }
            )
    return games


# One blowout week: the spread a real league produces on any given Sunday.
WEEK_ONE = {1: 168.0, 2: 151.0, 3: 140.0, 4: 128.0, 5: 119.0,
            6: 111.0, 7: 101.0, 8: 92.0, 9: 78.0, 10: 61.0}


def test_one_week_in_nobody_is_in_and_nobody_is_out():
    odds = A.playoff_odds(
        league_of([WEEK_ONE]), schedule_after(1, 14), 4, simulations=4000
    )
    values = [row["odds"] for row in odds.values()]

    # The bug produced 0.98 and 0.00 off exactly this kind of week.
    assert max(values) < 0.85, f"too sure after one week: {sorted(values)}"
    assert min(values) > 0.05, f"too dismissive after one week: {sorted(values)}"


def test_the_week_one_blowout_still_counts_for_something():
    odds = A.playoff_odds(
        league_of([WEEK_ONE]), schedule_after(1, 14), 4, simulations=4000
    )

    # Uncertain is not the same as uninformative: 168 beats 61.
    assert odds[1]["odds"] > odds[10]["odds"]


def test_confidence_grows_as_the_season_does():
    """The same team, the same scores, more weeks of them."""
    spreads = []
    for played in (1, 4, 8, 12):
        weeks = [WEEK_ONE] * played
        odds = A.playoff_odds(
            league_of(weeks), schedule_after(played, 14), 4, simulations=4000
        )
        values = [row["odds"] for row in odds.values()]
        spreads.append(max(values) - min(values))

    assert spreads == sorted(spreads), f"confidence did not grow: {spreads}"
    # And by week 12 the league really is close to settled.
    assert spreads[-1] > 0.8


def test_a_finished_season_is_a_fact_not_a_forecast():
    weeks = [WEEK_ONE] * 14
    odds = A.playoff_odds(league_of(weeks), [], 4, simulations=200)
    values = sorted(row["odds"] for row in odds.values())

    assert values == [0.0] * 6 + [1.0] * 4


def test_odds_total_the_places_on_offer_at_every_point_in_the_season():
    for played in (1, 2, 5, 9, 13, 14):
        odds = A.playoff_odds(
            league_of([WEEK_ONE] * played),
            schedule_after(played, 14),
            4,
            simulations=1000,
        )
        total = sum(row["odds"] for row in odds.values())
        assert total == pytest.approx(4.0), f"week {played}: {total}"


def test_a_team_with_no_games_played_sits_at_the_league_average():
    model = A._scoring_model(league_of([WEEK_ONE]))
    played = model[1]

    # Every team here has one week, so each is pulled most of the way back
    # to the league. The top scorer's 168 must not survive as its average.
    assert played["mean"] < 130.0
    assert played["mean"] > A._scoring_model(league_of([WEEK_ONE]))[10]["mean"]


def test_the_uncertainty_in_a_team_average_shrinks_with_evidence():
    one = A._scoring_model(league_of([WEEK_ONE]))[1]["mean_stdev"]
    many = A._scoring_model(league_of([WEEK_ONE] * 12))[1]["mean_stdev"]

    assert many < one
    # And it is never zero, or the simulation goes back to treating a
    # measured average as a settled one.
    assert many > 0.0


def test_a_league_with_no_measurable_spread_is_not_treated_as_predictable():
    """Every team scoring the same every week is thin data, not certainty.

    It is also the shape a synthetic fixture takes, and without a floor on
    the spread the simulation becomes deterministic — the same 100%/0% the
    shrinkage above exists to prevent, arriving through the variance instead
    of the mean.
    """
    flat = {i: 100.0 for i in range(1, 11)}
    model = A._scoring_model(league_of([flat] * 10))

    assert all(row["stdev"] >= A.MIN_STDEV for row in model.values())
    assert all(row["mean_stdev"] > 0.0 for row in model.values())

    odds = A.playoff_odds(league_of([flat] * 5), schedule_after(5, 14), 4,
                          simulations=2000)
    values = [row["odds"] for row in odds.values()]
    # Ten identical teams, four places: everyone is near 40%, nobody is sure.
    assert max(values) < 0.75
    assert min(values) > 0.10
