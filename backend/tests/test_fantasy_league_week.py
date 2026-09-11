"""Weekly recap: results, lineup efficiency, the curve, and the awards.

The draft recap grades one event against an outside market; a week has none,
so what has to be pinned here is different. Three things matter: the grade
renormalises around a component it cannot measure rather than inventing one,
an award nobody earned is omitted rather than handed to whoever finished
last, and every claim about a bench is dropped the moment the stat feed
cannot cover the lineup it would be measured against.
"""
import json

import pytest

from app.database import (
    FantasyCollectionRun,
    FantasyLeagueMatchup,
    FantasyLeagueRosterEntry,
    FantasyLeagueSeason,
    FantasyLeagueTeam,
    FantasyPlayer,
    FantasyPlayerStat,
    FantasyProjection,
    SessionLocal,
    utc_now,
)
from app.services import fantasy_league_week as flw

SEASON = 2032
LEAGUE_ID = "225965"
RUN_ID = 77001
WEEK = 1

# QB, RB, WR and three bench seats: small enough to reason about by hand.
SLOT_COUNTS = {"0": 1, "2": 1, "4": 1, "20": 3}

MODELS = (
    FantasyLeagueMatchup,
    FantasyLeagueRosterEntry,
    FantasyLeagueTeam,
    FantasyLeagueSeason,
    FantasyPlayerStat,
    FantasyProjection,
    FantasyCollectionRun,
    FantasyPlayer,
)

# Four teams, two matchups: a blowout and a one-point game. Team 1 scores the
# most and starts its best lineup; team 2 is the reverse — a good roster the
# manager mostly benched.
SCORES = {1: 130.0, 2: 90.0, 3: 100.5, 4: 99.5}

# (player, slot, position, actual, projected)
ROSTERS = {
    1: [
        ("t1qb", "QB", "QB", 25.0, 20.0),
        ("t1rb", "RB", "RB", 30.0, 18.0),
        ("t1wr", "WR", "WR", 20.0, 15.0),
        ("t1b1", "BENCH", "RB", 4.0, 12.0),
    ],
    2: [
        ("t2qb", "QB", "QB", 5.0, 21.0),
        ("t2rb", "RB", "RB", 6.0, 14.0),
        ("t2wr", "WR", "WR", 7.0, 13.0),
        ("t2b1", "BENCH", "RB", 40.0, 11.0),
        ("t2b2", "BENCH", "WR", 22.0, 9.0),
    ],
    3: [
        ("t3qb", "QB", "QB", 18.0, 17.0),
        ("t3rb", "RB", "RB", 12.0, 13.0),
        ("t3wr", "WR", "WR", 11.0, 12.0),
        ("t3b1", "BENCH", "WR", 3.0, 10.0),
    ],
    4: [
        ("t4qb", "QB", "QB", 16.0, 16.0),
        ("t4rb", "RB", "RB", 14.0, 14.0),
        ("t4wr", "WR", "WR", 10.0, 11.0),
        ("t4b1", "BENCH", "RB", 2.0, 9.0),
    ],
}


@pytest.fixture(autouse=True)
def league_env(monkeypatch):
    monkeypatch.setenv("ESPN_LEAGUE_ID", LEAGUE_ID)


@pytest.fixture
def db():
    session = SessionLocal()
    _wipe(session)
    yield session
    _wipe(session)
    session.close()


PLAYER_IDS = [row[0] for roster in ROSTERS.values() for row in roster]


def _wipe(session):
    for model in MODELS:
        if model is FantasyPlayer:
            session.query(model).filter(
                FantasyPlayer.player_id.in_(PLAYER_IDS)
            ).delete(synchronize_session=False)
        else:
            session.query(model).filter_by(season=SEASON).delete()
    session.commit()


def seed(db, *, with_rosters=True, with_actuals=True, with_projections=True):
    db.add(
        FantasyLeagueSeason(
            espn_league_id=LEAGUE_ID,
            season=SEASON,
            name="The League",
            size=4,
            lineup_slot_counts_json=json.dumps(SLOT_COUNTS),
            status="ok",
        )
    )
    for team_id in SCORES:
        db.add(
            FantasyLeagueTeam(
                season=SEASON,
                espn_team_id=team_id,
                name=f"Team {team_id}",
                owner_name=f"Owner {team_id}",
            )
        )

    for index, (home, away) in enumerate(((1, 2), (3, 4)), start=1):
        db.add(
            FantasyLeagueMatchup(
                season=SEASON,
                espn_matchup_id=index,
                matchup_period=WEEK,
                home_team_id=home,
                home_points=SCORES[home],
                away_team_id=away,
                away_points=SCORES[away],
                winner="HOME",
                is_complete=True,
            )
        )
    # A future week ESPN has already published, so "the newest played week"
    # cannot just mean "the newest week on the schedule".
    db.add(
        FantasyLeagueMatchup(
            season=SEASON,
            espn_matchup_id=3,
            matchup_period=WEEK + 1,
            home_team_id=1,
            away_team_id=3,
            winner="UNDECIDED",
            is_complete=False,
        )
    )

    if with_projections:
        run = FantasyCollectionRun(
            job="projections",
            source="sleeper",
            season=SEASON,
            week=WEEK,
            status="success",
            started_at=utc_now(),
            finished_at=utc_now(),
            rows_written=1,
        )
        db.add(run)
        db.commit()
        db.refresh(run)

    for team_id, roster in ROSTERS.items():
        for player_id, slot, position, actual, projected in roster:
            db.add(
                FantasyPlayer(
                    player_id=player_id,
                    full_name=player_id.upper(),
                    position=position,
                    team="SF",
                )
            )
            if with_rosters:
                db.add(
                    FantasyLeagueRosterEntry(
                        run_id=RUN_ID,
                        season=SEASON,
                        scoring_period=WEEK,
                        espn_team_id=team_id,
                        player_id=player_id,
                        player_name_raw=player_id.upper(),
                        lineup_slot=slot,
                        position=position,
                    )
                )
            if with_actuals:
                db.add(
                    FantasyPlayerStat(
                        season=SEASON,
                        week=WEEK,
                        player_id=player_id,
                        position=position,
                        fantasy_points_half=actual,
                    )
                )
            if with_projections:
                db.add(
                    FantasyProjection(
                        run_id=run.id,
                        season=SEASON,
                        week=WEEK,
                        source="sleeper",
                        player_id=player_id,
                        pts_half_ppr=projected,
                    )
                )
    db.commit()


def award(recap, key):
    return next((row for row in recap["accolades"] if row["key"] == key), None)


def grade(recap, team_id):
    return next(row for row in recap["grades"] if row["espn_team_id"] == team_id)


# ── which week ──────────────────────────────────────────────────────────


def test_the_recap_opens_on_the_newest_week_that_was_actually_played(db):
    seed(db)
    recap = flw.get_week_recap(db, SEASON)
    assert recap["available_weeks"] == [WEEK, WEEK + 1]
    assert recap["played_weeks"] == [WEEK]
    assert recap["week"] == WEEK
    assert recap["status"] == "complete"


def test_an_unplayed_week_reports_itself_rather_than_grading_nothing(db):
    seed(db)
    recap = flw.get_week_recap(db, SEASON, week=WEEK + 1)
    assert recap["week"] == WEEK + 1
    assert recap["status"] == "not_played"
    assert recap["grades"] == []
    assert recap["accolades"] == []
    # The key is always there, so the page never has to tell "no lineup data"
    # apart from "this branch omits the field".
    assert recap["lineups"]["available"] is False


def test_a_season_with_no_schedule_at_all_still_answers(db):
    db.add(
        FantasyLeagueSeason(
            espn_league_id=LEAGUE_ID, season=SEASON, name="The League", status="ok"
        )
    )
    db.commit()
    recap = flw.get_week_recap(db, SEASON)
    assert recap["week"] is None
    assert recap["status"] == "not_played"
    assert recap["matchups"] == []


# ── results ─────────────────────────────────────────────────────────────


def test_every_team_gets_its_result_its_opponent_and_its_margin(db):
    seed(db)
    recap = flw.get_week_recap(db, SEASON)
    winner = grade(recap, 1)
    assert winner["result"] == "win"
    assert winner["points"] == 130.0
    assert winner["margin"] == 40.0
    assert winner["opponent"]["espn_team_id"] == 2
    assert grade(recap, 2)["result"] == "loss"
    assert grade(recap, 2)["margin"] == -40.0


def test_all_play_is_the_record_against_everyone_who_played(db):
    seed(db)
    recap = flw.get_week_recap(db, SEASON)
    # 130 beats all three; 90 loses to all three.
    assert grade(recap, 1)["all_play"] == {
        "wins": 3,
        "losses": 0,
        "ties": 0,
        "pct": 1.0,
    }
    assert grade(recap, 2)["all_play"]["pct"] == 0.0


def test_all_play_balances_across_the_league():
    records = flw.all_play({1: 10.0, 2: 10.0, 3: 5.0})
    wins = sum(row["wins"] for row in records.values())
    losses = sum(row["losses"] for row in records.values())
    assert wins == losses
    assert records[1]["ties"] == 1


# ── lineups ─────────────────────────────────────────────────────────────


def test_efficiency_is_what_was_started_over_what_could_have_been(db):
    seed(db)
    recap = flw.get_week_recap(db, SEASON)
    # Team 1 started 25 + 30 + 20 = 75, and its only bench player scored 4,
    # so the best legal lineup was the one it played.
    assert grade(recap, 1)["efficiency"] == 1.0
    assert grade(recap, 1)["points_left"] == 0.0

    # Team 2 started 18 with a 40-point running back and a 22-point receiver
    # on the bench: the optimum is 5 + 40 + 22 = 67.
    assert grade(recap, 2)["optimal"] == 67.0
    assert grade(recap, 2)["points_left"] == 49.0


def test_the_bench_hero_and_the_swaps_that_were_available_are_named(db):
    seed(db)
    recap = flw.get_week_recap(db, SEASON)
    row = grade(recap, 2)
    assert row["bench_hero"]["name"] == "T2B1"
    assert {entry["name"] for entry in row["should_have_started"]} == {"T2B1", "T2B2"}


def test_without_a_roster_snapshot_the_page_says_so_instead_of_guessing(db):
    seed(db, with_rosters=False)
    recap = flw.get_week_recap(db, SEASON)
    assert recap["lineups"]["available"] is False
    assert recap["lineups"]["reason"] == "no_roster_snapshot"
    assert all(row["efficiency"] is None for row in recap["grades"])
    assert award(recap, "best_manager") is None
    assert award(recap, "bench_regret") is None


def test_without_actuals_no_claim_is_made_about_any_bench(db):
    seed(db, with_actuals=False)
    recap = flw.get_week_recap(db, SEASON)
    assert recap["lineups"]["reason"] == "no_actuals"
    assert award(recap, "player_of_the_week") is None
    # The scores themselves are ESPN's, so the week is still gradeable.
    assert grade(recap, 1)["points"] == 130.0


def test_a_starter_the_stat_feed_misses_costs_that_team_its_efficiency(db):
    seed(db)
    db.query(FantasyPlayerStat).filter_by(season=SEASON, player_id="t3rb").delete()
    db.commit()
    recap = flw.get_week_recap(db, SEASON)
    assert grade(recap, 3)["efficiency"] is None
    assert grade(recap, 3)["unscored_starters"] == 1
    # And it does not take the rest of the league down with it.
    assert grade(recap, 1)["efficiency"] == 1.0


# ── the grade ───────────────────────────────────────────────────────────


def test_the_grade_is_a_curve_ordered_best_first(db):
    seed(db)
    recap = flw.get_week_recap(db, SEASON)
    composites = [row["composite"] for row in recap["grades"]]
    assert composites == sorted(composites, reverse=True)
    assert recap["grades"][0]["espn_team_id"] == 1
    assert recap["grades"][0]["grade"].startswith("A")


def test_every_component_is_reported_with_the_weight_it_was_given(db):
    seed(db)
    row = grade(flw.get_week_recap(db, SEASON), 1)
    assert set(row["components"]) == set(flw.GRADE_WEIGHTS)
    assert sum(part["weight"] for part in row["components"].values()) == pytest.approx(1.0)


def test_an_unmeasurable_component_leaves_the_grade_rather_than_scoring_average(db):
    seed(db, with_rosters=False)
    row = grade(flw.get_week_recap(db, SEASON), 1)
    assert "management" not in row["components"]
    # The remaining weights renormalise, so the letter still means "where you
    # finished" instead of being diluted by a component nobody could measure.
    assert sum(part["weight"] for part in row["components"].values()) == pytest.approx(1.0)
    assert row["components"]["scoring"]["weight"] == pytest.approx(0.45 / 0.70)


def test_weights_renormalise_over_whatever_is_available():
    assert flw._weights(list(flw.GRADE_WEIGHTS)) == flw.GRADE_WEIGHTS
    assert flw._weights([]) == {}
    only = flw._weights(["scoring"])
    assert only == {"scoring": 1.0}


# ── the awards ──────────────────────────────────────────────────────────


def test_the_headline_awards_go_to_the_teams_that_earned_them(db):
    seed(db)
    recap = flw.get_week_recap(db, SEASON)
    assert award(recap, "top_score")["winner"]["espn_team_id"] == 1
    assert award(recap, "low_score")["winner"]["espn_team_id"] == 2
    assert award(recap, "best_manager")["winner"]["espn_team_id"] == 1
    assert award(recap, "bench_regret")["winner"]["espn_team_id"] == 2
    assert award(recap, "player_of_the_week")["winner"]["player"] == "T1RB"
    assert award(recap, "bench_hero")["winner"]["player"] == "T2B1"


def test_the_margins_name_both_teams_in_the_game(db):
    seed(db)
    recap = flw.get_week_recap(db, SEASON)
    blowout = award(recap, "blowout")
    assert blowout["winner"]["team"] == "Team 1"
    assert "Team 2" in blowout["winner"]["detail"]
    assert award(recap, "nail_biter")["winner"]["team"] == "Team 3"


def test_every_award_carries_the_ordering_behind_it(db):
    seed(db)
    for row in flw.get_week_recap(db, SEASON)["accolades"]:
        assert row["standings"]
        assert row["winner"]["display"]


def test_a_week_nobody_got_lucky_in_hands_out_no_luck_award(db):
    seed(db)
    # Both winners outscored most of the league, which is what winning
    # normally means. There is no story, so there is no trophy.
    recap = flw.get_week_recap(db, SEASON)
    assert award(recap, "lucky_win") is None
    assert award(recap, "unlucky_loss") is None


def test_the_luck_awards_appear_when_the_schedule_actually_did_it(db):
    seed(db)
    # Flip the blowout into a one-point game: team 2 now wins with the
    # second-lowest score in the league.
    row = (
        db.query(FantasyLeagueMatchup)
        .filter_by(season=SEASON, espn_matchup_id=1)
        .first()
    )
    row.home_points, row.away_points = 95.0, 96.0
    row.winner = "AWAY"
    db.commit()

    recap = flw.get_week_recap(db, SEASON)
    assert award(recap, "lucky_win")["winner"]["espn_team_id"] == 2
    # Team 4 is the other half of that: it outscored two of the other three
    # and still lost the one game the schedule gave it.
    assert award(recap, "unlucky_loss")["winner"]["espn_team_id"] == 4


def test_players_are_only_called_busts_against_a_real_expectation(db):
    seed(db)
    recap = flw.get_week_recap(db, SEASON)
    bust = award(recap, "bust")
    # Team 2's quarterback was projected 21 and scored 5.
    assert bust["winner"]["player"] == "T2QB"
    assert bust["winner"]["value"] == -16.0
    assert award(recap, "smash")["winner"]["player"] == "T1RB"


def test_with_no_projection_board_nothing_is_measured_against_expectation(db):
    seed(db, with_projections=False)
    recap = flw.get_week_recap(db, SEASON)
    assert award(recap, "bust") is None
    assert award(recap, "over_projection") is None
    assert grade(recap, 1)["projected"] is None
    assert "No projection board" in recap["method"]["projection_caveat"]


# ── callouts and disclosure ─────────────────────────────────────────────


def test_the_callouts_describe_the_shape_of_the_week(db):
    seed(db)
    callouts = flw.get_week_recap(db, SEASON)["callouts"]
    assert callouts["scoring"]["high"] == 130.0
    assert callouts["scoring"]["low"] == 90.0
    assert callouts["scoring"]["teams"] == 4
    assert callouts["expectation"]["of"] == 4


def test_the_method_discloses_what_the_grade_could_not_see(db):
    seed(db, with_rosters=False)
    method = flw.get_week_recap(db, SEASON)["method"]
    assert method["weights"] == flw.GRADE_WEIGHTS
    assert method["lineup_available"] is False
    assert method["lineup_reason"] == "no_roster_snapshot"
    assert "relative to this league" in method["relative"]
