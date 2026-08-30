"""League hub API contract tests.

The important assertions here are the negative ones: this is the only part
of /api/fantasy that is NOT public, and it sits underneath a demo prefix, so
the gate has to be proven rather than assumed.
"""
import pytest
from fastapi.testclient import TestClient

from app import accounts
from app.accounts import ROLE_ADMIN, ROLE_MEMBER
from app.database import (
    FantasyCollectionRun,
    FantasyLeagueMatchup,
    FantasyLeagueMember,
    FantasyLeaguePowerRanking,
    FantasyLeagueRosterEntry,
    FantasyLeagueSeason,
    FantasyLeagueTeam,
    FantasyLeagueTeamOverview,
    FantasyMeta,
    FantasyPlayer,
    FantasyPlayerStat,
    FantasyProjection,
    FantasyPropSnapshot,
    FantasyRanking,
    SessionLocal,
    utc_now,
)
from app.main import SESSION_COOKIE_NAME, app, create_app_session_token
from app.services import fantasy_league_collector as lc
from app.services import fantasy_ai
from app.services.fantasy_league_espn import EspnLeagueUnauthorized

from tests.test_fantasy_league_collector import FakeEspnLeagueClient

ADMIN_USERNAME = "palmer"
ADMIN_PASSWORD = "secret"

LEAGUE_MODELS = (
    FantasyLeaguePowerRanking,
    FantasyLeagueRosterEntry,
    FantasyLeagueMatchup,
    FantasyLeagueTeam,
    FantasyLeagueMember,
    FantasyLeagueSeason,
    FantasyLeagueTeamOverview,
    FantasyPropSnapshot,
    FantasyPlayerStat,
    FantasyProjection,
    FantasyRanking,
    FantasyCollectionRun,
    FantasyPlayer,
    FantasyMeta,
)

# Every members-only route, used to prove the gate covers all of them.
LEAGUE_ROUTES = (
    "/api/fantasy/league/seasons",
    "/api/fantasy/league/overview",
    "/api/fantasy/league/standings",
    "/api/fantasy/league/power-rankings",
    "/api/fantasy/league/scoreboard",
    "/api/fantasy/league/teams/1",
    "/api/fantasy/league/teams/1/roster",
    "/api/fantasy/league/teams/1/overview",
)


@pytest.fixture(autouse=True)
def auth_env(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", ADMIN_USERNAME)
    monkeypatch.setenv("APP_AUTH_PASSWORD", ADMIN_PASSWORD)
    monkeypatch.setenv("ESPN_LEAGUE_ID", "225965")


@pytest.fixture
def seeded_db(monkeypatch):
    session = SessionLocal()
    for model in LEAGUE_MODELS:
        session.query(model).delete()
    session.commit()

    client = FakeEspnLeagueClient()
    lc.collect_season(session, 2024, client)
    session.commit()
    yield session
    session.rollback()
    session.close()


def member_client():
    db = SessionLocal()
    try:
        user = accounts.get_user(db, "taylor")
        if user is None:
            accounts.create_user(db, "taylor", "fixture-password-123")
        elif not user.is_active:
            user.is_active = True
            db.commit()
    finally:
        db.close()
    client = TestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_app_session_token("taylor", ADMIN_PASSWORD, role=ROLE_MEMBER),
    )
    return client


def admin_client():
    client = TestClient(app)
    client.cookies.set(
        SESSION_COOKIE_NAME,
        create_app_session_token(ADMIN_USERNAME, ADMIN_PASSWORD, role=ROLE_ADMIN),
    )
    return client


# ── the gate ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("route", LEAGUE_ROUTES)
def test_anonymous_is_refused_with_json_403(seeded_db, route):
    """403 with a JSON body — never a 401, and never WWW-Authenticate.

    A Basic-auth challenge on an XHR path pops a native browser credential
    modal, which is a dead end. The page needs to render "sign in" instead.
    """
    response = TestClient(app).get(route)
    assert response.status_code == 403
    assert "WWW-Authenticate" not in response.headers
    assert "sign in" in response.json()["detail"].lower()


@pytest.mark.parametrize("route", LEAGUE_ROUTES)
def test_member_may_read_every_route(seeded_db, route):
    response = member_client().get(route)
    assert response.status_code == 200


def test_admin_may_read_too(seeded_db):
    assert admin_client().get("/api/fantasy/league/standings").status_code == 200


def test_league_paths_are_not_demo_paths():
    """The single assertion that catches an accidental demo-prefix regression.

    /fantasy and /api/fantasy are both demo prefixes, and matching is by
    prefix, so the league hub inherits demo access unless excluded.
    """
    from app.main import is_demo_path, is_member_path, is_protected_path

    assert is_demo_path("/fantasy/league/") is False
    assert is_demo_path("/fantasy/league") is False
    assert is_member_path("/fantasy/league/") is True
    assert is_protected_path("/fantasy/league/") is True

    # The public dashboard around it must stay demo-accessible.
    assert is_demo_path("/fantasy/") is True
    assert is_demo_path("/fantasy/draft-order/") is True
    assert is_demo_path("/api/fantasy/rankings") is True


def test_public_fantasy_dashboard_is_still_anonymous(seeded_db):
    """Locking the league must not lock the league-agnostic dashboard."""
    assert TestClient(app).get("/api/fantasy/state").status_code == 200


# ── payload contracts ───────────────────────────────────────────────────


def test_seasons_reports_private_seasons_explicitly(seeded_db, monkeypatch):
    client = FakeEspnLeagueClient(errors={2025: EspnLeagueUnauthorized("401")})
    lc.collect_league_sync(seeded_db, 2025, client)
    seeded_db.commit()

    body = member_client().get("/api/fantasy/league/seasons").json()
    by_season = {row["season"]: row for row in body["seasons"]}

    assert by_season[2024]["available"] is True
    # A private season is surfaced as a labeled gap, not omitted.
    assert by_season[2025]["status"] == "unauthorized"
    assert by_season[2025]["available"] is False


def test_overview_reports_mode_and_freshness(seeded_db):
    body = member_client().get("/api/fantasy/league/overview?season=2024").json()
    assert body["season"] == 2024
    assert body["mode"] == "live"
    assert body["name"] == "The League"
    assert body["completed_weeks"] == [1, 2]
    assert body["freshness"]["league_sync"]
    assert "composite" in body["algorithms"]


def test_standings_are_division_grouped(seeded_db):
    body = member_client().get("/api/fantasy/league/standings?season=2024").json()
    assert len(body["teams"]) == 2
    assert len(body["divisions"]) == 1
    assert body["divisions"][0]["division_name"] == "East"
    team = body["teams"][0]
    assert {"wins", "losses", "points_for", "owner_name"} <= set(team)


def test_power_rankings_default_to_composite_latest_week(seeded_db):
    body = member_client().get("/api/fantasy/league/power-rankings?season=2024").json()
    assert body["algorithm"] == "composite"
    assert body["week"] == 2
    assert body["available_weeks"] == [1, 2]
    assert [row["rank"] for row in body["rankings"]] == [1, 2]
    assert body["rankings"][0]["history"]


def test_power_rankings_reject_an_unknown_algorithm(seeded_db):
    response = member_client().get(
        "/api/fantasy/league/power-rankings?season=2024&algorithm=vibes"
    )
    assert response.status_code == 422


def test_scoreboard_returns_a_week(seeded_db):
    body = member_client().get("/api/fantasy/league/scoreboard?season=2024&week=1").json()
    assert body["week"] == 1
    assert len(body["matchups"]) == 1
    matchup = body["matchups"][0]
    assert matchup["home"]["points"] == pytest.approx(110.0)
    assert matchup["away"]["points"] == pytest.approx(90.0)
    assert matchup["winner"] == "HOME"


def test_team_detail_lists_results(seeded_db):
    body = member_client().get("/api/fantasy/league/teams/1?season=2024").json()
    assert body["espn_team_id"] == 1
    assert body["owner_name"] == "Palmer Gill"
    outcomes = [row["outcome"] for row in body["results"]]
    assert outcomes == ["W", "L"]


def test_team_roster_marks_unmatched_players(seeded_db):
    body = member_client().get("/api/fantasy/league/teams/1/roster?season=2024").json()
    names = [entry["name"] for entry in body["entries"]]
    assert "Amon-Ra St. Brown" in names
    # No ff_players rows are seeded here, so everything is unmatched — and
    # unmatched entries must still render from their raw ESPN name.
    assert body["unmatched"] == len(body["entries"])
    assert all(entry["matched"] is False for entry in body["entries"])


def test_roster_orders_starters_before_bench(seeded_db):
    body = member_client().get("/api/fantasy/league/teams/1/roster?season=2024").json()
    slots = [entry["lineup_slot"] for entry in body["entries"]]
    assert slots.index("QB") < slots.index("BENCH")
    assert body["entries"][0]["is_starter"] is True


def test_team_roster_joins_dashboard_player_data(seeded_db):
    roster = (
        seeded_db.query(FantasyLeagueRosterEntry)
        .filter_by(espn_team_id=1, player_name_raw="Amon-Ra St. Brown")
        .first()
    )
    roster.player_id = "200"
    seeded_db.add(
        FantasyPlayer(
            player_id="200",
            full_name="Amon-Ra St. Brown",
            search_name="amon ra st brown",
            position="WR",
            team="DET",
            injury_status="QUESTIONABLE",
        )
    )
    projection_runs = []
    for source, points in (("sleeper", 18.0), ("espn", 20.0)):
        run = FantasyCollectionRun(
            job="projections", source=source, season=2026, week=0,
            status="success", finished_at=utc_now(), rows_written=1,
        )
        seeded_db.add(run)
        seeded_db.flush()
        projection_runs.append(run)
        seeded_db.add(
            FantasyProjection(
                run_id=run.id, season=2026, week=0, source=source,
                player_id="200", pts_ppr=points,
            )
        )
    ranking_run = FantasyCollectionRun(
        job="rankings", source="fantasypros", season=2026, week=0,
        status="success", finished_at=utc_now(), rows_written=1,
    )
    seeded_db.add(ranking_run)
    seeded_db.flush()
    seeded_db.add(
        FantasyRanking(
            run_id=ranking_run.id, season=2026, week=0, source="fantasypros",
            scoring="ppr", position="WR", player_id="200", rank=4, ecr=4.2,
        )
    )
    seeded_db.add(
        FantasyPlayerStat(
            season=2025, week=17, player_id="200", opponent="MIN",
            fantasy_points_ppr=22.5,
        )
    )
    props_run = FantasyCollectionRun(
        job="odds_props", source="the_odds_api", status="success",
        finished_at=utc_now(), rows_written=1,
    )
    seeded_db.add(props_run)
    seeded_db.flush()
    seeded_db.add(
        FantasyPropSnapshot(
            run_id=props_run.id, player_id="200", player_name_raw="Amon-Ra St. Brown",
            market="player_receptions", outcome="Over", point=6.5, price=-110,
            bookmaker="book",
        )
    )
    seeded_db.commit()

    body = member_client().get("/api/fantasy/league/teams/1/roster?season=2024").json()
    entry = next(row for row in body["entries"] if row["player_id"] == "200")
    assert entry["matched"] is True
    assert entry["projection"]["pts_ppr"] == pytest.approx(19.0)
    assert entry["ranking"]["rank"] == 4
    assert entry["props"][0]["point"] == pytest.approx(6.5)
    assert entry["recent_actuals"][0]["fantasy_points_ppr"] == pytest.approx(22.5)
    assert entry["injury_status"] == "QUESTIONABLE"
    assert body["player_data"]["season"] == 2026


OVERVIEW_ROUTE = "/api/fantasy/league/teams/1/overview?season=2024&week=2"


def test_reading_an_overview_never_generates_one(seeded_db, monkeypatch):
    """A GET must not write or spend.

    Regression: GET used to call the generator, so simply opening a team page
    billed a model call and inserted a row. Browsing every team across every
    season would have generated dozens of overviews nobody asked for.
    """
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    body = member_client().get(OVERVIEW_ROUTE).json()

    assert body["status"] == "missing"
    assert body["overview_md"] is None
    assert seeded_db.query(FantasyLeagueTeamOverview).count() == 0

    # Repeated reads stay free.
    member_client().get(OVERVIEW_ROUTE)
    assert seeded_db.query(FantasyLeagueTeamOverview).count() == 0


def test_writing_an_overview_requires_a_post(seeded_db, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    written = member_client().post(OVERVIEW_ROUTE).json()

    assert written["source"] == "local"
    assert written["status"] == "current"
    assert written["overview_md"]
    assert seeded_db.query(FantasyLeagueTeamOverview).count() == 1

    read_back = member_client().get(OVERVIEW_ROUTE).json()
    assert read_back["status"] == "current"
    assert read_back["cache_hit"] is True
    assert read_back["overview_md"] == written["overview_md"]


def test_overview_goes_stale_when_team_data_changes(seeded_db, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    member_client().post(OVERVIEW_ROUTE)
    team = seeded_db.query(FantasyLeagueTeam).filter_by(season=2024, espn_team_id=1).one()
    team.points_for += 5
    seeded_db.commit()

    # The read reports staleness rather than silently regenerating.
    assert member_client().get(OVERVIEW_ROUTE).json()["status"] == "stale"

    refreshed = member_client().post(OVERVIEW_ROUTE).json()
    assert refreshed["cache_hit"] is False
    assert seeded_db.query(FantasyLeagueTeamOverview).count() == 1


def test_a_local_fallback_is_replaced_once_a_model_is_available(seeded_db, monkeypatch):
    """Regression: a transient model failure used to pin the local template.

    The fallback was stored with the current digest, so every later read was a
    cache hit and the UI's non-forcing refresh button could never recover it.
    """
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    first = member_client().post(OVERVIEW_ROUTE).json()
    assert first["source"] == "local"

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(
        fantasy_ai,
        "_openai_response",
        lambda *a, **k: {"output_text": "**Model overview.**"},
    )

    # A plain read still does not generate, but it does report the staleness.
    assert member_client().get(OVERVIEW_ROUTE).json()["status"] == "stale"

    # And a non-forcing refresh now upgrades it.
    upgraded = member_client().post(OVERVIEW_ROUTE).json()
    assert upgraded["source"] == "model"
    assert upgraded["overview_md"] == "**Model overview.**"

    # A model-written overview is a genuine cache hit; it is not rewritten.
    assert member_client().get(OVERVIEW_ROUTE).json()["status"] == "current"
    assert member_client().post(OVERVIEW_ROUTE).json()["cache_hit"] is True


def test_team_overview_reuses_model_plumbing_without_tools(seeded_db, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    captured = {}

    def fake_openai(input_items, instructions=fantasy_ai.SYSTEM_PROMPT, tools=None):
        captured["instructions"] = instructions
        captured["tools"] = tools
        captured["input"] = input_items
        return {"output_text": "**Model overview.**"}

    monkeypatch.setattr(fantasy_ai, "_openai_response", fake_openai)
    body = fantasy_ai.generate_team_overview(seeded_db, 2024, 1, 2)

    assert body["source"] == "model"
    assert body["model"] == fantasy_ai.DEFAULT_MODEL
    assert body["overview_md"] == "**Model overview.**"
    assert captured["tools"] == []
    assert captured["instructions"] == fantasy_ai.TEAM_OVERVIEW_PROMPT


def test_authenticated_chat_turn_enables_private_league_tools(seeded_db, monkeypatch):
    captured = {}

    def fake_answer(message, session_id=None, timezone_name=None, level=None, league_access=False):
        captured["league_access"] = league_access
        return {
            "answer": "ok", "session_id": session_id or "session",
            "tools_used": [], "data": {}, "warnings": [],
        }

    monkeypatch.setattr(fantasy_ai, "answer_chat", fake_answer)
    response = member_client().post(
        "/api/fantasy/chat", json={"message": "Show league standings"}
    )
    assert response.status_code == 200
    assert captured["league_access"] is True


def test_member_local_chat_can_answer_league_power_rankings(seeded_db, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    result = fantasy_ai.answer_chat(
        "Show this league's power rankings", league_access=True
    )
    assert result["tools_used"] == ["get_league_power_rankings"]
    assert "4th and 20" in result["answer"]


# ── error cases ─────────────────────────────────────────────────────────


def test_admin_refresh_honours_the_season_parameter(seeded_db, monkeypatch):
    """Regression: the endpoint used to drop ?season=, so every league
    refresh silently collected the current season instead of the requested
    one — and FastAPI ignores unknown query params, so it looked like it
    worked. The echoed season in the response is what makes it visible.
    """
    monkeypatch.setattr(lc, "espn_league_client", FakeEspnLeagueClient())

    response = admin_client().post(
        "/api/fantasy/admin/refresh?job=league_sync&season=2023"
    )
    assert response.status_code == 200
    body = response.json()
    assert body["season"] == 2023
    assert body["status"] == "success"
    assert (
        seeded_db.query(FantasyLeagueTeam).filter_by(season=2023).count() == 2
    )


def test_admin_refresh_is_still_admin_only(seeded_db):
    assert (
        member_client().post("/api/fantasy/admin/refresh?job=league_sync").status_code
        == 403
    )
    assert (
        TestClient(app).post("/api/fantasy/admin/refresh?job=league_sync").status_code
        == 403
    )


def test_unknown_team_is_404(seeded_db):
    assert member_client().get("/api/fantasy/league/teams/99?season=2024").status_code == 404


def test_unknown_season_is_404(seeded_db):
    assert (
        member_client().get("/api/fantasy/league/standings?season=1999").status_code == 404
    )


def test_private_season_is_404_not_empty(seeded_db):
    """A season we cannot read must not masquerade as an empty one."""
    lc.collect_league_sync(
        seeded_db, 2025, FakeEspnLeagueClient(errors={2025: EspnLeagueUnauthorized("401")})
    )
    seeded_db.commit()
    assert (
        member_client().get("/api/fantasy/league/standings?season=2025").status_code == 404
    )


# ── topic guard and chat season defaults ────────────────────────────────


def test_members_may_ask_about_a_team_by_name(seeded_db, monkeypatch):
    """Regression: "How is 4th and 20 doing?" was refused as off-topic.

    The guard matched topic terms, positions and NFL player names — a league
    team name matched none of those, so the most natural question a manager
    asks about their own team never reached the model or the router.
    """
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    refused = fantasy_ai.answer_demo_chat("How is 4th and 20 doing?")
    assert refused["answer"] == fantasy_ai.OUT_OF_SCOPE_ANSWER

    allowed = fantasy_ai.answer_chat("How is 4th and 20 doing?", league_access=True)
    assert allowed["answer"] != fantasy_ai.OUT_OF_SCOPE_ANSWER
    # ...and it actually answers about that team rather than falling through
    # to the generic "here is what I can do" reply.
    assert allowed["tools_used"] == ["get_league_team"]
    assert "4th and 20" in allowed["answer"]

    by_owner = fantasy_ai.answer_chat("how did Palmer Gill do", league_access=True)
    assert by_owner["tools_used"] == ["get_league_team"]


def test_team_name_matching_is_gated_on_league_access(seeded_db):
    """Anonymous callers must not be able to use the guard as an oracle for
    whether a given string is one of the league's team names."""
    matched = fantasy_ai._first_league_team_match(seeded_db, "How is 4th and 20 doing?")
    assert matched is not None and matched.espn_team_id == 1

    db_session = seeded_db
    assert (
        fantasy_ai._is_fantasy_related(db_session, "How is 4th and 20 doing?", league_access=False)
        is False
    )
    assert (
        fantasy_ai._is_fantasy_related(db_session, "How is 4th and 20 doing?", league_access=True)
        is True
    )


def test_team_name_matching_ignores_incidental_short_words(seeded_db):
    assert fantasy_ai._first_league_team_match(seeded_db, "what is the weather") is None
    assert fantasy_ai._first_league_team_match(seeded_db, "") is None


def test_chat_falls_back_to_the_last_played_season(seeded_db, monkeypatch):
    """Regression: during the preseason the league tools defaulted to the
    current season and reported "not collected yet" while a full set of
    rankings sat in the table for the previous season."""
    client = FakeEspnLeagueClient()
    # 2026 exists but has no completed games — the hub's default landing spot.
    lc.collect_league_sync(seeded_db, 2026, client)
    seeded_db.query(FantasyLeagueMatchup).filter_by(season=2026).update(
        {"is_complete": False, "winner": "UNDECIDED"}
    )
    seeded_db.commit()

    from app.services import fantasy_league_data as ld

    assert ld.resolve_default_season(seeded_db)["season"] == 2026
    assert ld.resolve_default_season(seeded_db)["mode"] == "preseason"
    # Chat prefers the season that actually has results.
    assert ld.resolve_played_season(seeded_db) == 2024

    from app.services import fantasy_tools

    assert fantasy_tools.get_league_power_rankings(seeded_db)["season"] == 2024
    assert fantasy_tools.get_league_standings(seeded_db)["season"] == 2024
    assert fantasy_tools.get_league_scoreboard(seeded_db)["season"] == 2024


@pytest.mark.parametrize("route", LEAGUE_ROUTES)
def test_every_league_timestamp_is_marked_utc(seeded_db, route):
    """No route may hand the client an offsetless stored timestamp.

    Naive UTC without a 'Z' is parsed as local time by `new Date()`, which
    shifts every "as of" label by the viewer's offset. Walking the whole
    payload catches a new timestamp field added to any of these responses,
    not just the ones that existed when this was written.
    """
    payload = member_client().get(route).json()

    def walk(node, path=""):
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, f"{path}.{key}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, f"{path}[{index}]")
        elif isinstance(node, str) and _looks_like_timestamp(node):
            assert node.endswith("Z"), f"{route}{path} is not marked UTC: {node!r}"

    walk(payload)


def _looks_like_timestamp(value: str) -> bool:
    """An ISO date-time, as opposed to a plain date or arbitrary text."""
    import re

    return bool(re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", value))
