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
    FantasySeasonPropSnapshot,
    FantasyTrendingSnapshot,
    SessionLocal,
)
from app.main import SESSION_COOKIE_NAME, app, create_app_session_token
from app.services import fantasy_collector as fc
from app.services import fantasy_data as fd
from app.services.fantasy_sleeper import parse_projection_rows

client = TestClient(app)

FF_MODELS = (
    FantasyRanking,
    FantasyProjection,
    FantasyTrendingSnapshot,
    FantasyPlayerStat,
    FantasyFutureSnapshot,
    FantasyPropSnapshot,
    FantasySeasonPropSnapshot,
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

    season_props = client.get("/api/fantasy/players/100/season-props").json()
    assert season_props["player"]["name"] == "Patrick Mahomes"
    assert len(season_props["markets"]) == 6
    assert all(market["line"] is None for market in season_props["markets"])

    season_leaders = client.get("/api/fantasy/season-props").json()
    assert season_leaders["leaders"] == []

    fantasy_point_leaders = client.get("/api/fantasy/season-fantasy-points").json()
    assert fantasy_point_leaders["leaders"] == []
    # The projection-comparison fields are part of the route's contract even
    # when there is nothing to rank, so the client can render a stable shape.
    assert fantasy_point_leaders["projection_source"] is None
    assert fantasy_point_leaders["projection_providers"] is None
    assert fantasy_point_leaders["excluded_without_projection"] == 0
    assert client.get(
        "/api/fantasy/season-fantasy-points", params={"scoring": "half"}
    ).json()["scoring"] == "half"
    assert client.get(
        "/api/fantasy/season-fantasy-points", params={"scoring": "invalid"}
    ).status_code == 422

    offense_leaders = client.get("/api/fantasy/season-offenses").json()
    assert offense_leaders["yards"] == []
    assert offense_leaders["touchdowns"] == []

    assert client.get("/api/fantasy/players/unknown/season-props").status_code == 404


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

    season_response = auth_client.post("/api/fantasy/admin/refresh", params={"job": "season_props"})
    assert season_response.status_code == 200
    assert season_response.json()["job"] == "season_props"


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


@pytest.mark.parametrize(
    "route",
    (
        "/api/fantasy/state",
        "/api/fantasy/rankings",
        "/api/fantasy/projections",
        "/api/fantasy/trending",
    ),
)
def test_dashboard_timestamps_are_marked_utc(route):
    """"as of" labels are rendered from these, so they must carry the offset.

    Stored timestamps are naive UTC; without a 'Z' the browser reads them as
    local time and the rendered date slips a day for any collector run that
    finished within the viewer's offset of midnight UTC.
    """
    import re

    payload = client.get(route).json()
    stamps = []

    def walk(node, path=""):
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, f"{path}.{key}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, f"{path}[{index}]")
        elif isinstance(node, str) and re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", node):
            stamps.append((path, node))

    walk(payload)
    offsetless = [(path, value) for path, value in stamps if not value.endswith("Z")]
    assert not offsetless, f"{route} returned unmarked timestamps: {offsetless}"


@pytest.mark.parametrize("kind", ("add", "drop"))
def test_trending_route_returns_200(kind):
    """The route echoes `kind` back as a string.

    A `Dict[str, List[...]]` return annotation is validated by FastAPI as the
    response model, which turned every call here into a 500.
    """
    response = client.get("/api/fantasy/trending", params={"kind": kind})

    assert response.status_code == 200
    body = response.json()
    assert body["kind"] == kind
    assert isinstance(body["results"], list)


def _seed_game_lines():
    """One game with two snapshot runs across all three line markets."""
    session = SessionLocal()
    session.add(FantasyGame(
        game_id="2025_03_BUF_KC", season=2025, week=3,
        home_team="KC", away_team="BUF",
    ))
    for run_id, (spread, total, home_ml) in enumerate(
        [(-2.5, 47.5, -140), (-3.5, 48.5, -165)], start=1
    ):
        for bookmaker in ("draftkings", "fanduel"):
            session.add_all([
                FantasyOddsSnapshot(
                    run_id=run_id, game_id="2025_03_BUF_KC", bookmaker=bookmaker,
                    market="spreads", outcome="KC", point=spread, price=-110,
                ),
                FantasyOddsSnapshot(
                    run_id=run_id, game_id="2025_03_BUF_KC", bookmaker=bookmaker,
                    market="totals", outcome="Over", point=total, price=-110,
                ),
                FantasyOddsSnapshot(
                    run_id=run_id, game_id="2025_03_BUF_KC", bookmaker=bookmaker,
                    market="h2h", outcome="KC", point=None, price=home_ml,
                ),
            ])
    session.commit()
    session.close()


@pytest.mark.parametrize("market", ("spreads", "totals", "h2h"))
def test_game_lines_history_returns_200_for_every_market(market):
    """Every market the route accepts has to actually build its series.

    `h2h` is the reason this is parametrized: its branch called a helper that
    a later same-named definition in fantasy_data had silently shadowed, so
    the route raised a TypeError for that market and no other.
    """
    _seed_game_lines()

    response = client.get(
        "/api/fantasy/games/2025_03_BUF_KC/lines/history", params={"market": market}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["market"] == market
    assert body["outcome"] == ("Over" if market == "totals" else "KC")
    assert [point["point"] for point in body["history"]] == {
        "spreads": [-2.5, -3.5],
        "totals": [47.5, 48.5],
        "h2h": [-140, -165],
    }[market]


def test_game_lines_history_is_empty_for_an_unknown_game():
    response = client.get("/api/fantasy/games/nope/lines/history", params={"market": "h2h"})

    assert response.status_code == 200
    assert response.json()["history"] == []


def _seed_namesakes():
    """Namesakes for one surname, plus a decoy that only matches mid-word.

    Projected points are attached to the same run the read path resolves, so
    the ordering under test is the one the endpoint actually computes.
    """
    session = SessionLocal()
    run = fd._resolve_projection_run(session, 2025, 3, None)
    people = [
        # (id, name, team, projected points)
        ("h1", "Aaron Hill", "NYJ", 40.0),
        ("h2", "Tyreek Hill", "MIA", 310.0),
        ("h3", "Zeb Hill", "DAL", 120.0),
        ("h4", "Hill Bradford", "LAR", 15.0),   # surname query, first-name hit
        ("h5", "Bygone Hill", None, None),      # no projection at all
        ("h6", "Andy Phillips", "SF", 900.0),   # "hill" only buried mid-word
    ]
    for player_id, name, team, points in people:
        session.add(FantasyPlayer(
            player_id=player_id, full_name=name, search_name=name.lower(),
            team=team, position="WR", status="Active",
        ))
        if points is not None:
            session.add(FantasyProjection(
                run_id=run.id, season=2025, week=3, source="sleeper",
                player_id=player_id, pts_ppr=points,
                pts_half_ppr=points, pts_std=points,
            ))
    session.commit()
    session.close()


def test_player_search_ranks_by_projection_not_alphabet():
    """The player anyone means has to be reachable inside the UI's limit.

    Ordering the whole Sleeper catalog by name put five first-name Allens
    above Josh Allen, and the dashboard only asks for eight results.
    """
    _seed_namesakes()

    results = client.get(
        "/api/fantasy/players/search", params={"q": "hill", "limit": 5}
    ).json()["results"]

    names = [r["name"] for r in results]
    # Highest projection first, unprojected last, and a first-name match gets
    # no special standing over the surname matches.
    assert names == ["Tyreek Hill", "Zeb Hill", "Aaron Hill", "Hill Bradford", "Bygone Hill"]
    # "hill" is inside "phillips", but not at a word start, so it never
    # competes — even though the decoy has the highest projection on the board.
    assert "Andy Phillips" not in names


def test_player_search_escapes_like_wildcards():
    """A bare "%" matched every player in the catalog."""
    _seed_namesakes()

    for term in ("%%", "__", "%a"):
        results = client.get(
            "/api/fantasy/players/search", params={"q": term}
        ).json()["results"]
        assert results == [], f"{term!r} was treated as a wildcard"


def test_player_search_ranks_on_season_projection_not_the_current_week():
    """A star who is out this week must not lose his place in search.

    Ranking on the current week's run nulls out anyone questionable or
    injured, which dropped Tyreek Hill below every Hilliard in the catalog.
    "Which Hill do you mean" is a season-scale question, so it is answered
    from the season-long run.
    """
    session = SessionLocal()
    week_run = fd._resolve_projection_run(session, 2025, 3, None)
    fc.collect_projections(session, 2025, fd.SEASON_LONG_WEEK, client=FakeSleeper())
    season_run = fd._resolve_projection_run(session, 2025, fd.SEASON_LONG_WEEK, None)

    for player_id, name, season_points, week_points in [
        ("s1", "Star Hill", 300.0, None),   # out this week, huge for the season
        ("s2", "Scrub Hilliard", 20.0, 8.0),
    ]:
        session.add(FantasyPlayer(
            player_id=player_id, full_name=name, search_name=name.lower(),
            team="NYJ", position="WR", status="Active",
        ))
        session.add(FantasyProjection(
            run_id=season_run.id, season=2025, week=fd.SEASON_LONG_WEEK,
            source="sleeper", player_id=player_id, pts_ppr=season_points,
        ))
        if week_points is not None:
            session.add(FantasyProjection(
                run_id=week_run.id, season=2025, week=3, source="sleeper",
                player_id=player_id, pts_ppr=week_points,
            ))
    session.commit()
    session.close()

    results = client.get(
        "/api/fantasy/players/search", params={"q": "hill", "limit": 5}
    ).json()["results"]

    assert [r["name"] for r in results] == ["Star Hill", "Scrub Hilliard"]


def _seed_week_results(rows, season=2025, week=3):
    """Actual stat lines for a played week, as the nflverse collector writes them."""
    session = SessionLocal()
    session.query(FantasyPlayerStat).delete()
    for row in rows:
        session.add(FantasyPlayerStat(season=season, week=week, **row))
    session.commit()
    session.close()


def test_week_results_ranks_by_actual_and_grades_the_projection_that_was_shown():
    _seed_week_results([
        {"player_id": "100", "position": "QB", "team": "KC", "opponent": "DEN",
         "fantasy_points_ppr": 18.0, "fantasy_points_half": 18.0, "fantasy_points_std": 18.0},
        {"player_id": "200", "position": "WR", "team": "MIN", "opponent": "GB",
         "fantasy_points_ppr": 33.5, "fantasy_points_half": 30.5, "fantasy_points_std": 27.5},
        {"player_id": "300", "position": "RB", "team": "ATL", "opponent": "TB",
         "fantasy_points_ppr": 12.0, "fantasy_points_half": 10.5, "fantasy_points_std": 9.0},
    ])

    body = client.get("/api/fantasy/week-results").json()
    assert body["season"] == 2025
    assert body["week"] == 3  # newest week with stat lines
    assert [e["player_id"] for e in body["entries"]] == ["200", "100", "300"]
    assert [e["rank"] for e in body["entries"]] == [1, 2, 3]

    receiver = body["entries"][0]
    # Projected 16.0 in standard scoring by the derived rankings run for wk3,
    # where he ranked second overall.
    assert receiver["projected_points"] == 16.0
    assert receiver["projected_rank"] == 2
    assert receiver["actual_points"] == 27.5
    assert receiver["projection_delta"] == 11.5
    assert receiver["opponent"] == "GB"

    # 11.5 + 6.0 + 6.0 over three graded players.
    assert body["played"] == 3
    assert body["projected"] == 3
    assert body["mean_absolute_error"] == 7.8


def test_week_results_follow_the_requested_scoring_format():
    _seed_week_results([
        {"player_id": "200", "position": "WR", "team": "MIN", "opponent": "GB",
         "fantasy_points_ppr": 33.5, "fantasy_points_half": 30.5, "fantasy_points_std": 27.5},
    ])

    ppr = client.get("/api/fantasy/week-results", params={"scoring": "ppr"}).json()
    assert ppr["entries"][0]["actual_points"] == 33.5
    assert ppr["entries"][0]["projected_points"] == 21.0
    assert ppr["entries"][0]["projection_delta"] == 12.5


def test_week_results_skip_players_the_board_does_not_rank():
    _seed_week_results([
        {"player_id": "200", "position": "WR", "team": "MIN", "opponent": "GB",
         "fantasy_points_ppr": 33.5, "fantasy_points_half": 30.5, "fantasy_points_std": 27.5},
        # A punter's stat line, and a player who is not in the catalog at all.
        {"player_id": "900", "position": "P", "team": "MIN", "opponent": "GB",
         "fantasy_points_ppr": 0.0, "fantasy_points_half": 0.0, "fantasy_points_std": 0.0},
        {"player_id": "999", "position": "WR", "team": "SEA", "opponent": "SF",
         "fantasy_points_ppr": 40.0, "fantasy_points_half": 40.0, "fantasy_points_std": 40.0},
    ])

    body = client.get("/api/fantasy/week-results").json()
    assert [e["player_id"] for e in body["entries"]] == ["200"]
    assert body["played"] == 1


def test_week_results_grade_only_what_was_projected():
    session = SessionLocal()
    session.query(FantasyRanking).delete()
    session.commit()
    session.close()
    _seed_week_results([
        {"player_id": "200", "position": "WR", "team": "MIN", "opponent": "GB",
         "fantasy_points_ppr": 33.5, "fantasy_points_half": 30.5, "fantasy_points_std": 27.5},
    ])

    body = client.get("/api/fantasy/week-results").json()
    entry = body["entries"][0]
    # He still ranks — he scored the points either way — but there is nothing
    # to grade, so the average miss describes nobody.
    assert entry["actual_points"] == 27.5
    assert entry["projected_points"] is None
    assert entry["projection_delta"] is None
    assert body["played"] == 1
    assert body["projected"] == 0
    assert body["mean_absolute_error"] is None


def test_week_results_are_empty_before_a_week_is_played():
    _seed_week_results([])

    body = client.get("/api/fantasy/week-results").json()
    assert body["entries"] == []
    assert body["week"] is None
    assert body["played"] == 0
    assert body["mean_absolute_error"] is None

    # An explicit week with no stat lines is the same answer, not an error.
    asked = client.get("/api/fantasy/week-results", params={"week": 2}).json()
    assert asked["week"] == 2
    assert asked["entries"] == []
