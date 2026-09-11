"""Weekly recap over HTTP: the members-only gate and the written notes.

The recap maths is covered in test_fantasy_league_week; what matters here is
that the route is behind the same JSON 403 as the rest of the league hub, and
that the note endpoints keep the split the draft notes established — the GET
never bills for a model call, the POST is the only thing that writes.
"""
import pytest
from fastapi.testclient import TestClient

from app import accounts
from app.accounts import ROLE_MEMBER
from app.database import FantasyLeagueWeekNote, SessionLocal
from app.main import SESSION_COOKIE_NAME, app, create_app_session_token
from app.services import fantasy_ai

from tests.test_fantasy_league_week import SEASON, WEEK, seed

ADMIN_USERNAME = "palmer"
ADMIN_PASSWORD = "secret"

RECAP_ROUTE = f"/api/fantasy/league/week?season={SEASON}"
NOTE_ROUTE = f"/api/fantasy/league/week/notes/1?season={SEASON}&week={WEEK}"


@pytest.fixture(autouse=True)
def auth_env(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", ADMIN_USERNAME)
    monkeypatch.setenv("APP_AUTH_PASSWORD", ADMIN_PASSWORD)
    monkeypatch.setenv("ESPN_LEAGUE_ID", "225965")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


@pytest.fixture
def seeded_db():
    session = SessionLocal()
    _wipe(session)
    seed(session)
    yield session
    _wipe(session)
    session.close()


def _wipe(session):
    from tests.test_fantasy_league_week import _wipe as wipe_recap

    session.query(FantasyLeagueWeekNote).filter_by(season=SEASON).delete()
    session.commit()
    wipe_recap(session)


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


# ── the gate ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("route", (RECAP_ROUTE, NOTE_ROUTE))
def test_anonymous_is_refused_with_json_403(seeded_db, route):
    response = TestClient(app).get(route)
    assert response.status_code == 403
    assert "WWW-Authenticate" not in response.headers
    assert "sign in" in response.json()["detail"].lower()


def test_writing_a_note_is_gated_too(seeded_db):
    assert TestClient(app).post(NOTE_ROUTE).status_code == 403


# ── the recap ───────────────────────────────────────────────────────────


def test_a_member_reads_the_whole_week_in_one_request(seeded_db):
    payload = member_client().get(RECAP_ROUTE).json()
    assert payload["week"] == WEEK
    assert payload["status"] == "complete"
    assert len(payload["grades"]) == 4
    assert payload["accolades"]
    assert payload["matchups"]
    assert payload["method"]["weights"]


def test_an_explicit_week_is_honoured(seeded_db):
    payload = member_client().get(
        f"/api/fantasy/league/week?season={SEASON}&week={WEEK + 1}"
    ).json()
    assert payload["week"] == WEEK + 1
    assert payload["status"] == "not_played"


# ── the notes ───────────────────────────────────────────────────────────


def test_reading_a_note_never_writes_one(seeded_db):
    payload = member_client().get(NOTE_ROUTE).json()
    assert payload["status"] == "missing"
    assert payload["note_md"] is None
    assert seeded_db.query(FantasyLeagueWeekNote).count() == 0


def test_the_local_fallback_names_the_result_and_the_bench(seeded_db):
    written = member_client().post(NOTE_ROUTE).json()
    assert written["source"] == "local"
    assert "Team 1" in written["note_md"]
    assert "Team 2" in written["note_md"]
    # Team 1 left nothing on the bench, so the note does not claim it did.
    assert "bench" not in written["note_md"]

    stored = member_client().get(NOTE_ROUTE).json()
    assert stored["note_md"] == written["note_md"]
    assert stored["cache_hit"] is True


def test_a_benched_week_is_reported_as_one(seeded_db):
    route = f"/api/fantasy/league/week/notes/2?season={SEASON}&week={WEEK}"
    note = member_client().post(route).json()["note_md"]
    assert "49 points stayed on the bench" in note
    assert "T2B1" in note


def test_the_note_reuses_the_model_plumbing_without_tools(seeded_db, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    captured = {}

    def fake_openai(input_items, instructions=fantasy_ai.SYSTEM_PROMPT, tools=None):
        captured["instructions"] = instructions
        captured["tools"] = tools
        return {"output_text": "**A model recap.**"}

    monkeypatch.setattr(fantasy_ai, "_openai_response", fake_openai)
    payload = member_client().post(NOTE_ROUTE).json()

    assert payload["source"] == "model"
    assert payload["note_md"] == "**A model recap.**"
    assert captured["tools"] == []
    assert captured["instructions"] == fantasy_ai.WEEK_NOTE_PROMPT


def test_a_note_goes_stale_when_the_week_moves_under_it(seeded_db, monkeypatch):
    member_client().post(NOTE_ROUTE)
    from app.database import FantasyLeagueMatchup

    row = (
        seeded_db.query(FantasyLeagueMatchup)
        .filter_by(season=SEASON, espn_matchup_id=1)
        .first()
    )
    row.home_points += 12
    seeded_db.commit()

    assert member_client().get(NOTE_ROUTE).json()["status"] == "stale"
    assert member_client().post(NOTE_ROUTE).json()["cache_hit"] is False
    assert seeded_db.query(FantasyLeagueWeekNote).count() == 1


def test_a_team_with_no_result_in_the_week_is_a_404(seeded_db):
    response = member_client().get(
        f"/api/fantasy/league/week/notes/9?season={SEASON}&week={WEEK}"
    )
    assert response.status_code == 404
