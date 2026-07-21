"""Fantasy API contract tests: demo-mode reads return seeded data, search
validates input, and the admin refresh endpoint is gated to real auth.
"""
import pytest
from fastapi.testclient import TestClient

from app.database import (
    FantasyCollectionRun,
    FantasyFutureSnapshot,
    FantasyGame,
    FantasyMeta,
    FantasyOddsSnapshot,
    FantasyPlayer,
    FantasyPlayerStat,
    FantasyProjection,
    FantasyPropSnapshot,
    FantasyRanking,
    FantasyTrendingSnapshot,
    SessionLocal,
)
from app.main import SESSION_COOKIE_NAME, app, create_app_session_token
from app.services import fantasy_collector as fc
from app.services.fantasy_sleeper import parse_projection_rows

client = TestClient(app)

FF_MODELS = (
    FantasyRanking,
    FantasyProjection,
    FantasyTrendingSnapshot,
    FantasyPlayerStat,
    FantasyFutureSnapshot,
    FantasyPropSnapshot,
    FantasyOddsSnapshot,
    FantasyGame,
    FantasyCollectionRun,
    FantasyPlayer,
    FantasyMeta,
)

PLAYERS_DUMP = {
    "100": {"full_name": "Patrick Mahomes", "position": "QB", "team": "KC", "gsis_id": "g100", "espn_id": 3139477},
    "200": {"full_name": "Justin Jefferson", "position": "WR", "team": "MIN", "gsis_id": "g200"},
    "300": {"full_name": "Bijan Robinson", "position": "RB", "team": "ATL", "gsis_id": "g300"},
}
PROJECTIONS = [
    {"player_id": "100", "stats": {"pts_ppr": 24.0, "pts_half_ppr": 24.0, "pts_std": 24.0}},
    {"player_id": "200", "stats": {"pts_ppr": 21.0, "pts_half_ppr": 18.5, "pts_std": 16.0}},
    {"player_id": "300", "stats": {"pts_ppr": 19.0, "pts_half_ppr": 17.0, "pts_std": 15.0}},
]


SEASON_PROJECTIONS = [
    {"player_id": "100", "stats": {"pts_ppr": 360.0, "pts_half_ppr": 360.0, "pts_std": 360.0}},
    {"player_id": "200", "stats": {"pts_ppr": 310.0, "pts_half_ppr": 290.0, "pts_std": 270.0}},
    {"player_id": "300", "stats": {"pts_ppr": 280.0, "pts_half_ppr": 260.0, "pts_std": 240.0}},
]


class FakeSleeper:
    def __init__(self, state=None):
        self._state = state or {"season": "2025", "week": 3, "season_type": "regular"}

    def get_players(self):
        return PLAYERS_DUMP

    def get_state(self):
        return self._state

    def get_projections(self, season, week, season_type="regular"):
        return parse_projection_rows(PROJECTIONS)

    def get_season_projections(self, season, season_type="regular"):
        return parse_projection_rows(SEASON_PROJECTIONS)

    def get_trending(self, kind, lookback_hours=24, limit=25):
        return [{"player_id": "300", "count": 500}] if kind == "add" else []


@pytest.fixture(autouse=True)
def seed_db():
    session = SessionLocal()
    for model in FF_MODELS:
        session.query(model).delete()
    session.commit()
    fake = FakeSleeper()
    fc.collect_state(session, client=fake)
    fc.collect_players(session, client=fake)
    fc.collect_projections(session, 2025, 3, client=fake)
    fc.build_derived_rankings(session, 2025, 3)
    fc.collect_trending(session, client=fake)
    session.close()
    yield


def test_state_reports_season_and_jobs():
    response = client.get("/api/fantasy/state")
    assert response.status_code == 200
    body = response.json()
    assert body["season"] == 2025
    assert body["week"] == 3
    assert body["default_week"] == 3
    job_names = {j["job"] for j in body["jobs"]}
    assert {"players", "projections", "rankings"} <= job_names


def _seed_offseason():
    """Re-seed as the 2026 offseason: off state + week-0 season-long rankings."""
    session = SessionLocal()
    for model in FF_MODELS:
        session.query(model).delete()
    session.commit()
    fake = FakeSleeper(state={"season": "2026", "week": 0, "season_type": "off", "display_week": 0})
    fc.collect_state(session, client=fake)
    fc.collect_players(session, client=fake)
    fc.collect_projections(session, 2026, fc.SEASON_LONG_WEEK, client=fake)
    fc.build_derived_rankings(session, 2026, fc.SEASON_LONG_WEEK)
    session.close()


def test_offseason_defaults_to_upcoming_season_long_rankings():
    _seed_offseason()

    state = client.get("/api/fantasy/state").json()
    assert state["in_season"] is False
    assert state["default_season"] == 2026
    assert state["default_week"] == 0  # season-long view
    assert state["is_fallback"] is False

    rankings = client.get("/api/fantasy/rankings").json()
    assert rankings["season"] == 2026
    assert rankings["week"] == 0
    assert [r["player_id"] for r in rankings["rankings"]] == ["100", "200", "300"]
    # Season-long points, not weekly-sized numbers.
    assert rankings["rankings"][0]["projected_points"] == 360.0

    detail = client.get("/api/fantasy/players/100").json()
    assert detail["projection"]["season"] == 2026
    assert detail["projection"]["week"] == 0
    assert detail["projection"]["source"] == "sleeper"


def test_offseason_without_season_long_snapshot_falls_back_to_last_season():
    # Seeded 2025 wk3 data exists; flip the state to the 2026 offseason
    # without collecting a season-long snapshot.
    session = SessionLocal()
    fc.collect_state(
        session,
        client=FakeSleeper(state={"season": "2026", "week": 0, "season_type": "off", "display_week": 0}),
    )
    session.close()

    state = client.get("/api/fantasy/state").json()
    assert state["default_season"] == 2025
    assert state["default_week"] == 3
    assert state["is_fallback"] is True


def test_rankings_default_week_and_position_filter():
    overall = client.get("/api/fantasy/rankings").json()
    assert [r["player_id"] for r in overall["rankings"]] == ["100", "200", "300"]
    assert overall["rankings"][0]["name"] == "Patrick Mahomes"

    wr = client.get("/api/fantasy/rankings", params={"position": "WR"}).json()
    assert [r["player_id"] for r in wr["rankings"]] == ["200"]


def test_projections_endpoint_returns_sorted_points():
    body = client.get("/api/fantasy/projections").json()
    points = [p["projected_points"] for p in body["projections"]]
    assert points == sorted(points, reverse=True)


def test_projection_sources_can_be_listed_and_selected():
    session = SessionLocal()

    class FakeFantasyPros:
        def get_projections(self, season, week):
            return [
                {
                    "name": "Patrick Mahomes",
                    "team": "KC",
                    "position": "QB",
                    "pts_ppr": 30.0,
                    "pts_half_ppr": 30.0,
                    "pts_std": 30.0,
                    "stats": {"points_ppr": 30.0},
                },
                {
                    "name": "Justin Jefferson",
                    "team": "MIN",
                    "position": "WR",
                    "pts_ppr": 25.0,
                    "pts_half_ppr": 22.0,
                    "pts_std": 19.0,
                    "stats": {"points_ppr": 25.0},
                },
            ]

    fc.collect_fantasypros_projections(session, 2025, 3, client=FakeFantasyPros())
    session.close()

    sources = client.get("/api/fantasy/projection-sources").json()["sources"]
    # Sleeper stays the default; a consensus blend is offered once a second
    # provider (FantasyPros) is present.
    assert [source["id"] for source in sources] == ["sleeper", "consensus", "fantasypros"]

    rankings = client.get(
        "/api/fantasy/rankings",
        params={"source": "fantasypros", "position": "ALL", "scoring": "ppr"},
    ).json()
    assert rankings["source"] == "fantasypros"
    assert [row["projected_points"] for row in rankings["rankings"]] == [30.0, 25.0]

    detail = client.get("/api/fantasy/players/100", params={"source": "fantasypros"}).json()
    assert detail["projection"]["source"] == "fantasypros"
    assert detail["projection"]["pts_ppr"] == 30.0


def test_consensus_source_blends_providers():
    session = SessionLocal()

    class FakeFantasyPros:
        def get_projections(self, season, week):
            return [
                {"name": "Patrick Mahomes", "team": "KC", "position": "QB",
                 "pts_ppr": 30.0, "pts_half_ppr": 30.0, "pts_std": 30.0, "stats": {}},
            ]

    fc.collect_fantasypros_projections(session, 2025, 3, client=FakeFantasyPros())
    session.close()

    # Sleeper Mahomes = 24.0, FantasyPros = 30.0 -> consensus 27.0.
    rankings = client.get(
        "/api/fantasy/rankings", params={"source": "consensus", "position": "QB"}
    ).json()
    assert rankings["source"] == "consensus"
    assert rankings["rankings"][0]["player_id"] == "100"
    assert rankings["rankings"][0]["projected_points"] == 27.0

    detail = client.get("/api/fantasy/players/100", params={"source": "consensus"}).json()
    assert detail["projection"]["source"] == "consensus"
    assert detail["projection"]["pts_ppr"] == 27.0
    assert sorted(detail["projection"]["providers"]) == ["fantasypros", "sleeper"]


def test_compare_endpoint_returns_players():
    body = client.get("/api/fantasy/compare", params={"ids": "100,200"}).json()
    assert [p["player_id"] for p in body["players"]] == ["100", "200"]
    assert body["players"][0]["projected_points"] == 24.0
    # Fewer than two valid ids is a client error.
    assert client.get("/api/fantasy/compare", params={"ids": "100"}).status_code == 400


def test_player_search_validates_and_finds():
    assert client.get("/api/fantasy/players/search", params={"q": "j"}).status_code == 422
    results = client.get("/api/fantasy/players/search", params={"q": "jeff"}).json()["results"]
    assert any(r["player_id"] == "200" for r in results)


def test_player_detail_known_and_unknown():
    assert client.get("/api/fantasy/players/zzz").status_code == 404
    detail = client.get("/api/fantasy/players/200").json()
    assert detail["name"] == "Justin Jefferson"
    assert detail["projection"]["pts_ppr"] == 21.0
    assert detail["projection"]["source"] == "sleeper"


def test_player_news_endpoint(monkeypatch):
    class FakeEspn:
        def get_player_news(self, espn_id, limit=6):
            assert espn_id == "3139477"
            return [
                {
                    "headline": "Mahomes 2026 outlook",
                    "description": None,
                    "byline": "Staff",
                    "url": "https://www.espn.com/story/1",
                    "published_at": "2026-07-10T00:00:00Z",
                    "premium": False,
                }
            ]

    from app.services import fantasy_news

    monkeypatch.setattr(fantasy_news, "espn_news_client", FakeEspn())

    assert client.get("/api/fantasy/players/zzz/news").status_code == 404

    body = client.get("/api/fantasy/players/100/news").json()
    assert body["player_id"] == "100"
    assert body["articles"][0]["headline"] == "Mahomes 2026 outlook"
    assert body["as_of"] is not None

    # Player without an espn_id -> empty articles, still 200.
    no_espn = client.get("/api/fantasy/players/200/news").json()
    assert no_espn["articles"] == []


def test_dashboard_returns_top_by_position():
    body = client.get("/api/fantasy/dashboard").json()
    assert body["top_by_position"]["QB"][0]["player_id"] == "100"
    assert body["trending_add"][0]["player_id"] == "300"


def test_betting_endpoints_return_well_formed_empty_structures():
    # No odds collected in this fixture -> endpoints still 200 with empty data.
    games = client.get("/api/fantasy/games").json()
    assert games["season"] == 2025  # matches the seeded FakeSleeper state
    assert isinstance(games["games"], list)

    props = client.get("/api/fantasy/props").json()
    assert props["featured"] == []

    futures = client.get("/api/fantasy/futures").json()
    assert futures["outcomes"] == []


def test_props_history_requires_params():
    # player_id and market are required query params.
    assert client.get("/api/fantasy/props/history").status_code == 422
    ok = client.get("/api/fantasy/props/history", params={"player_id": "x", "market": "player_pass_yds"})
    assert ok.status_code == 200
    assert ok.json()["history"] == []


def test_admin_refresh_accepts_odds_job(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    auth_client = TestClient(app)
    auth_client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token("palmer", "secret"))

    # No ODDS_API_KEY in the test env -> the job runs but records "skipped".
    response = auth_client.post("/api/fantasy/admin/refresh", params={"job": "odds_futures"})
    assert response.status_code == 200
    assert response.json()["job"] == "odds_futures"


def test_admin_refresh_rejects_anonymous_demo_caller():
    # /api/fantasy is a demo prefix, so an anonymous POST is demo-mode, not 401.
    response = client.post("/api/fantasy/admin/refresh", params={"job": "players"})
    assert response.status_code == 403


def test_admin_refresh_runs_for_authenticated_admin(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    monkeypatch.setattr(fc, "sleeper_client", FakeSleeper())
    auth_client = TestClient(app)
    auth_client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token("palmer", "secret"))

    response = auth_client.post("/api/fantasy/admin/refresh", params={"job": "players"})
    assert response.status_code == 200
    body = response.json()
    assert body["job"] == "players"
    assert body["status"] == "success"


def test_admin_refresh_rejects_unknown_job(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    auth_client = TestClient(app)
    auth_client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token("palmer", "secret"))

    response = auth_client.post("/api/fantasy/admin/refresh", params={"job": "bogus"})
    assert response.status_code == 400
