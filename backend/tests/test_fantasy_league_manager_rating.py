"""Season lineup efficiency, scored against what actually happened.

The start/sit card asks "who should you start"; this asks "who should you
have started", which is the same optimiser pointed at actual points instead
of projections. The tests that matter here are the two silences — a week
whose starters cannot all be scored is dropped, and a bench player nobody
recorded a score for is never treated as a missed opportunity.
"""
import json
import pytest

from app.database import (
    FantasyLeagueRosterEntry,
    FantasyLeagueSeason,
    FantasyPlayerStat,
    SessionLocal,
)
from app.services import fantasy_league_data as ld

SEASON = 2031
LEAGUE_ID = 225965
RUN_ID = 90210

# QB, RB, WR and five bench seats: small enough to reason about by hand.
SLOT_COUNTS = {"0": 1, "2": 1, "4": 1, "20": 5}


@pytest.fixture(autouse=True)
def league_env(monkeypatch):
    monkeypatch.setenv("ESPN_LEAGUE_ID", str(LEAGUE_ID))


@pytest.fixture
def db():
    session = SessionLocal()
    _wipe(session)
    session.add(
        FantasyLeagueSeason(
            season=SEASON,
            espn_league_id=LEAGUE_ID,
            lineup_slot_counts_json=json.dumps(SLOT_COUNTS),
        )
    )
    session.commit()
    yield session
    _wipe(session)
    session.close()


def _wipe(session):
    session.query(FantasyLeagueRosterEntry).filter_by(season=SEASON).delete()
    session.query(FantasyPlayerStat).filter_by(season=SEASON).delete()
    session.query(FantasyLeagueSeason).filter_by(season=SEASON).delete()
    session.commit()


def roster(session, week, team_id, players, run_id=RUN_ID):
    for player_id, slot, position in players:
        session.add(
            FantasyLeagueRosterEntry(
                run_id=run_id,
                season=SEASON,
                scoring_period=week,
                espn_team_id=team_id,
                player_id=player_id,
                player_name_raw=player_id,
                lineup_slot=slot,
                position=position,
            )
        )
    session.commit()


def scores(session, week, values):
    for player_id, points in values.items():
        session.add(
            FantasyPlayerStat(
                season=SEASON,
                week=week,
                player_id=player_id,
                fantasy_points_half=points,
            )
        )
    session.commit()


def test_efficiency_is_what_was_started_over_what_could_have_been(db):
    roster(
        db,
        1,
        1,
        [
            ("qb1", "QB", "QB"),
            ("rb1", "RB", "RB"),
            ("wr1", "WR", "WR"),
            ("rb2", "BENCH", "RB"),
        ],
    )
    scores(db, 1, {"qb1": 20.0, "rb1": 5.0, "wr1": 10.0, "rb2": 15.0})

    result = ld._manager_ratings(db, SEASON)

    assert result["available"] is True
    team = result["teams"][1]
    # Started 35; the best legal lineup was 20 + 15 + 10 = 45.
    assert team["efficiency"] == pytest.approx(35.0 / 45.0)
    assert team["points_left"] == pytest.approx(10.0)
    assert team["weeks"] == 1


def test_a_perfect_lineup_scores_one_hundred_percent(db):
    roster(
        db,
        1,
        1,
        [
            ("qb1", "QB", "QB"),
            ("rb1", "RB", "RB"),
            ("wr1", "WR", "WR"),
            ("rb2", "BENCH", "RB"),
        ],
    )
    scores(db, 1, {"qb1": 20.0, "rb1": 15.0, "wr1": 10.0, "rb2": 5.0})

    team = ld._manager_ratings(db, SEASON)["teams"][1]

    assert team["efficiency"] == pytest.approx(1.0)
    assert team["points_left"] == pytest.approx(0.0)


def test_a_week_whose_starter_has_no_stat_row_is_dropped(db):
    roster(
        db,
        1,
        1,
        [("qb1", "QB", "QB"), ("rb1", "RB", "RB"), ("wr1", "WR", "WR")],
    )
    scores(db, 1, {"qb1": 20.0, "rb1": 5.0, "wr1": 10.0})
    # Week 2 starts a player nobody recorded a score for.
    roster(
        db,
        2,
        1,
        [("qb1", "QB", "QB"), ("rb9", "RB", "RB"), ("wr1", "WR", "WR")],
        run_id=RUN_ID + 1,
    )
    scores(db, 2, {"qb1": 22.0, "wr1": 9.0})

    team = ld._manager_ratings(db, SEASON)["teams"][1]

    assert team["weeks"] == 1
    assert team["efficiency"] == pytest.approx(1.0)


def test_an_unscored_bench_player_is_not_a_missed_opportunity(db):
    """No stat row means no evidence he would have helped, so he is not a
    candidate. That biases the rating up, which is the safe direction: it
    never invents a benched hero the manager should have started."""
    roster(
        db,
        1,
        1,
        [
            ("qb1", "QB", "QB"),
            ("rb1", "RB", "RB"),
            ("wr1", "WR", "WR"),
            ("ghost", "BENCH", "RB"),
        ],
    )
    scores(db, 1, {"qb1": 20.0, "rb1": 15.0, "wr1": 10.0})

    team = ld._manager_ratings(db, SEASON)["teams"][1]

    assert team["efficiency"] == pytest.approx(1.0)


def test_a_player_on_ir_is_never_counted_as_startable(db):
    roster(
        db,
        1,
        1,
        [
            ("qb1", "QB", "QB"),
            ("rb1", "RB", "RB"),
            ("wr1", "WR", "WR"),
            ("rb2", "IR", "RB"),
        ],
    )
    # The IR player outscored the started RB, but could not have been played.
    scores(db, 1, {"qb1": 20.0, "rb1": 15.0, "wr1": 10.0, "rb2": 99.0})

    team = ld._manager_ratings(db, SEASON)["teams"][1]

    assert team["efficiency"] == pytest.approx(1.0)


def test_only_the_final_snapshot_of_a_week_is_judged(db):
    """A roster can be snapshotted twice in a week; the lineup a manager is
    judged on is the one that was standing when the games kicked off."""
    roster(
        db,
        1,
        1,
        [("qb1", "QB", "QB"), ("rb1", "RB", "RB"), ("wr1", "WR", "WR")],
        run_id=RUN_ID,
    )
    # Later run for the same week: the bad start was corrected.
    roster(
        db,
        1,
        1,
        [("qb1", "QB", "QB"), ("rb2", "RB", "RB"), ("wr1", "WR", "WR")],
        run_id=RUN_ID + 5,
    )
    scores(db, 1, {"qb1": 20.0, "rb1": 1.0, "wr1": 10.0, "rb2": 15.0})

    team = ld._manager_ratings(db, SEASON)["teams"][1]

    assert team["efficiency"] == pytest.approx(1.0)


def test_the_league_average_covers_every_rated_team(db):
    roster(
        db,
        1,
        1,
        [("qb1", "QB", "QB"), ("rb1", "RB", "RB"), ("wr1", "WR", "WR")],
    )
    roster(
        db,
        1,
        2,
        [
            ("qb2", "QB", "QB"),
            ("rb3", "RB", "RB"),
            ("wr2", "WR", "WR"),
            ("rb4", "BENCH", "RB"),
        ],
    )
    scores(
        db,
        1,
        {
            "qb1": 20.0,
            "rb1": 15.0,
            "wr1": 10.0,
            "qb2": 20.0,
            "rb3": 5.0,
            "wr2": 10.0,
            "rb4": 15.0,
        },
    )

    result = ld._manager_ratings(db, SEASON)

    assert set(result["teams"]) == {1, 2}
    assert result["league_average"] == pytest.approx((1.0 + 35.0 / 45.0) / 2)
    assert result["weeks"] == [1]


def test_no_lineup_settings_reports_a_reason_rather_than_a_blank(db):
    db.query(FantasyLeagueSeason).filter_by(season=SEASON).update(
        {"lineup_slot_counts_json": None}
    )
    db.commit()
    roster(db, 1, 1, [("qb1", "QB", "QB")])
    scores(db, 1, {"qb1": 20.0})

    result = ld._manager_ratings(db, SEASON)

    assert result == {"available": False, "reason": "no_lineup_settings", "teams": {}}


def test_no_actuals_reports_a_reason(db):
    roster(db, 1, 1, [("qb1", "QB", "QB")])

    result = ld._manager_ratings(db, SEASON)

    assert result["available"] is False
    assert result["reason"] == "no_actuals"
