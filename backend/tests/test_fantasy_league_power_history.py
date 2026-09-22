"""The season-long power chart: one line per team, week by week.

Two series answer the same question about different things. ``resume`` ranks
what a team has earned and comes free, because the collector already writes a
row per team per week per algorithm. ``roster`` ranks what a team holds, and
has to be stored as the season runs — a value recomputed later from revised
projections would quietly rewrite its own history.

The asymmetry is the thing worth pinning: the roster series cannot reach back
before it started being recorded, and the payload has to say so rather than
drawing a line that stops for reasons the reader cannot see.
"""
import pytest
from fastapi.testclient import TestClient

from app.database import (
    FantasyLeagueMatchup,
    FantasyLeagueRosterPower,
    FantasyLeagueSeason,
    FantasyLeagueTeam,
    SessionLocal,
)
from app.main import app
from app.services import fantasy_league_data as D
from tests.test_fantasy_league_api import ADMIN_PASSWORD, ADMIN_USERNAME, member_client
from app.services.fantasy_league_espn import configured_league_id

MODELS = (
    FantasyLeagueRosterPower,
    FantasyLeagueMatchup,
    FantasyLeagueTeam,
    FantasyLeagueSeason,
)


@pytest.fixture(autouse=True)
def auth_env(monkeypatch):
    """Session tokens are signed with APP_AUTH_PASSWORD, so the route tests
    need the same environment the rest of the league suite runs under."""
    monkeypatch.setenv("APP_AUTH_USERNAME", ADMIN_USERNAME)
    monkeypatch.setenv("APP_AUTH_PASSWORD", ADMIN_PASSWORD)
    monkeypatch.setenv("ESPN_LEAGUE_ID", "225965")


@pytest.fixture
def db():
    session = SessionLocal()
    for model in MODELS:
        session.query(model).delete()
    session.commit()
    yield session
    session.rollback()
    for model in MODELS:
        session.query(model).delete()
    session.commit()
    session.close()


def season_row(db, season=2026, periods=14):
    db.add(
        FantasyLeagueSeason(
            espn_league_id=configured_league_id(),
            season=season,
            name="Sunday Money",
            size=4,
            matchup_period_count=periods,
            status="ok",
        )
    )
    for team_id in (1, 2, 3, 4):
        db.add(
            FantasyLeagueTeam(
                season=season, espn_team_id=team_id, name=f"Team {team_id}"
            )
        )


def matchup(db, season, period, home, away, tier="NONE", complete=True):
    db.add(
        FantasyLeagueMatchup(
            season=season,
            espn_matchup_id=period * 100 + home,
            matchup_period=period,
            playoff_tier=tier,
            winner="HOME",
            home_team_id=home,
            away_team_id=away,
            home_points=110.0,
            away_points=100.0,
            is_complete=complete,
        )
    )


def roster_point(db, season, week, team_id, expected, rank):
    db.add(
        FantasyLeagueRosterPower(
            espn_league_id=configured_league_id(),
            season=season,
            week=week,
            espn_team_id=team_id,
            expected=expected,
            rank=rank,
            scoring="half",
        )
    )


# ── the axis ────────────────────────────────────────────────────────────


def test_the_playoff_line_comes_from_the_schedule_when_it_is_drawn(db):
    season_row(db)
    matchup(db, 2026, 14, 1, 2)
    matchup(db, 2026, 15, 1, 2, tier="WINNERS_BRACKET")
    db.commit()

    assert D.playoff_start_week(db, 2026) == 15


def test_a_season_with_no_bracket_yet_falls_back_to_the_stored_length(db):
    # ESPN has not tagged this season's playoff matchups yet, which is the
    # normal state in September — the axis still has to know where to stop.
    season_row(db, periods=13)
    matchup(db, 2026, 1, 1, 2)
    db.commit()

    assert D.playoff_start_week(db, 2026) == 14


def test_the_axis_spans_the_whole_regular_season_not_just_what_is_played(db):
    season_row(db)
    matchup(db, 2026, 1, 1, 2)
    db.commit()

    payload = D.get_power_history(db, 2026, metric="roster")
    # One week of data, fourteen weeks of axis: the chart must not rescale
    # itself every Tuesday.
    assert payload["last_week"] == 14
    assert payload["playoff_start_week"] == 15


# ── the roster series ───────────────────────────────────────────────────


def test_roster_points_come_back_as_one_line_per_team(db):
    season_row(db)
    for week in (1, 2, 3):
        for team_id in (1, 2, 3, 4):
            roster_point(db, 2026, week, team_id, 130.0 - team_id, team_id)
    db.commit()

    payload = D.get_power_history(db, 2026, metric="roster")
    assert payload["available"] is True
    assert payload["weeks"] == [1, 2, 3]
    assert len(payload["teams"]) == 4
    first = payload["teams"][0]
    assert [point["week"] for point in first["points"]] == [1, 2, 3]
    assert first["points"][0]["rank"] == 1
    assert first["points"][0]["value"] == 129.0


def test_the_roster_line_ends_on_the_boards_own_order(db, monkeypatch):
    # Stored rows stop at the last finished week; the Power rankings board
    # ranks the week in progress. The chart's last point is the board, and a
    # stored row for that same week gives way to it.
    season_row(db)
    for team_id in (1, 2):
        roster_point(db, 2026, 1, team_id, 120.0, team_id)
        roster_point(db, 2026, 2, team_id, 120.0, team_id)
    db.commit()
    monkeypatch.setattr(
        D,
        "get_roster_power",
        lambda db, season=None, **kw: {
            "available": True,
            "week": 2,
            "teams": [
                {"espn_team_id": 2, "rank": 1, "expected": 131.0},
                {"espn_team_id": 1, "rank": 2, "expected": 128.0},
            ],
        },
    )

    payload = D.get_power_history(db, 2026, metric="roster")
    by_team = {team["espn_team_id"]: team["points"] for team in payload["teams"]}
    assert [point["week"] for point in by_team[2]] == [1, 2]
    assert by_team[2][-1] == {"week": 2, "rank": 1, "value": 131.0}
    assert by_team[1][-1]["rank"] == 2


def test_a_season_recorded_before_the_series_existed_says_so(db):
    season_row(db, season=2024)
    matchup(db, 2024, 1, 1, 2)
    db.commit()

    payload = D.get_power_history(db, 2024, metric="roster")
    assert payload["available"] is False
    assert payload["unavailable_reason"] == "roster_power_not_recorded"
    assert payload["teams"] == []
    # The axis still comes back, so the chart can draw the empty frame and
    # explain itself rather than rendering nothing at all.
    assert payload["last_week"] == 14


def test_storing_a_week_twice_replaces_it_rather_than_stacking(db):
    season_row(db)
    roster_point(db, 2026, 1, 1, 100.0, 4)
    db.commit()
    roster_point(db, 2026, 1, 1, 140.0, 1)
    with pytest.raises(Exception):
        db.commit()
    db.rollback()


def test_the_metric_and_algorithm_are_echoed_back(db):
    season_row(db)
    roster_point(db, 2026, 1, 1, 130.0, 1)
    db.commit()

    resume = D.get_power_history(db, 2026, metric="resume", algorithm="recent_form")
    assert resume["metric"] == "resume"
    assert resume["algorithm"] == "recent_form"

    roster = D.get_power_history(db, 2026, metric="roster", algorithm="recent_form")
    assert roster["metric"] == "roster"
    # The roster series has no algorithm — it is not ranked by one.
    assert roster["algorithm"] is None


def test_an_unknown_metric_falls_back_rather_than_erroring(db):
    season_row(db)
    db.commit()

    assert D.get_power_history(db, 2026, metric="nonsense")["metric"] == "resume"


# ── the route ───────────────────────────────────────────────────────────


def test_the_route_is_members_only():
    response = TestClient(app).get("/api/fantasy/league/power-history")
    assert response.status_code == 403


def test_the_route_rejects_an_unknown_algorithm():
    response = member_client().get("/api/fantasy/league/power-history?algorithm=vibes")
    assert response.status_code == 422


def test_the_route_rejects_an_unknown_metric():
    # Rejected at the route by the pattern, before it can fall back.
    response = member_client().get("/api/fantasy/league/power-history?metric=nonsense")
    assert response.status_code == 422


def test_a_member_gets_both_series(db):
    season_row(db)
    roster_point(db, 2026, 1, 1, 130.0, 1)
    db.commit()
    client = member_client()

    for metric in ("resume", "roster"):
        response = client.get(
            f"/api/fantasy/league/power-history?season=2026&metric={metric}"
        )
        assert response.status_code == 200, response.text
        assert response.json()["metric"] == metric
