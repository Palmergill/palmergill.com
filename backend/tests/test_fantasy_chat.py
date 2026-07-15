"""Fantasy chat tests: topic guard, local router, tool handlers, the
model tool-loop (with a stubbed OpenAI call), and demo-mode behavior. No
network and no OpenAI calls.
"""
import json

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
from app.main import app
from app.services import fantasy_ai
from app.services import fantasy_collector as fc
from app.services import fantasy_tools
from app.services.fantasy_sleeper import parse_projection_rows

client = TestClient(app)

FF_MODELS = (
    FantasyRanking, FantasyProjection, FantasyTrendingSnapshot, FantasyPlayerStat,
    FantasyFutureSnapshot, FantasyPropSnapshot, FantasyOddsSnapshot, FantasyGame,
    FantasyCollectionRun, FantasyPlayer, FantasyMeta,
)

PLAYERS = {
    "100": {"full_name": "Josh Allen", "position": "QB", "team": "BUF"},
    "200": {"full_name": "Justin Jefferson", "position": "WR", "team": "MIN"},
    "300": {"full_name": "Bijan Robinson", "position": "RB", "team": "ATL"},
}
PROJECTIONS = [
    {"player_id": "100", "stats": {"pts_ppr": 24.0, "pts_half_ppr": 24.0, "pts_std": 24.0}},
    {"player_id": "200", "stats": {"pts_ppr": 21.0, "pts_half_ppr": 18.5, "pts_std": 16.0}},
    {"player_id": "300", "stats": {"pts_ppr": 19.0, "pts_half_ppr": 17.0, "pts_std": 15.0}},
]


class FakeSleeper:
    def get_players(self):
        return PLAYERS

    def get_state(self):
        return {"season": "2025", "week": 3, "season_type": "regular"}

    def get_projections(self, season, week, season_type="regular"):
        return parse_projection_rows(PROJECTIONS)

    def get_trending(self, kind, lookback_hours=24, limit=25):
        return [{"player_id": "300", "count": 900}] if kind == "add" else []


@pytest.fixture
def db():
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
    yield session
    session.rollback()
    session.close()


# ── topic guard ─────────────────────────────────────────────────────────


def test_topic_guard_accepts_fantasy_terms(db):
    assert fantasy_ai._is_fantasy_related(db, "Who are the top PPR running backs?")
    assert fantasy_ai._is_fantasy_related(db, "Should I start my QB this week?")


def test_topic_guard_accepts_known_player_name(db):
    # No fantasy keyword, but a real collected player name is present.
    assert fantasy_ai._is_fantasy_related(db, "Is Justin Jefferson healthy?")


def test_topic_guard_rejects_off_topic(db):
    assert not fantasy_ai._is_fantasy_related(db, "What is the price of bitcoin?")
    assert not fantasy_ai._is_fantasy_related(db, "Give me a lasagna recipe.")


# ── tool handlers ───────────────────────────────────────────────────────


def test_get_rankings_tool_caps_and_shapes(db):
    result = fantasy_tools.get_rankings(db, position="RB", scoring="ppr", limit=50)
    assert result["position"] == "RB"
    # limit is clamped to 25; only 1 RB in the fixture.
    assert len(result["players"]) == 1
    assert result["players"][0]["name"] == "Bijan Robinson"


def test_compare_players_tool(db):
    result = fantasy_tools.compare_players(db, ["100", "200"])
    names = {p["name"] for p in result["players"]}
    assert names == {"Josh Allen", "Justin Jefferson"}
    allen = next(p for p in result["players"] if p["name"] == "Josh Allen")
    assert allen["proj_ppr"] == 24.0


def test_search_players_tool_clamps_limit(db):
    result = fantasy_tools.search_players(db, "j", limit=99)
    assert isinstance(result["players"], list)


# ── local router (demo / no-key) ────────────────────────────────────────


def test_local_router_answers_rankings(db):
    result = fantasy_ai._answer_with_local_router(db, "top RBs this week", "sess1")
    assert "get_rankings" in result["tools_used"]
    assert "Bijan Robinson" in result["answer"]


def test_demo_chat_never_calls_openai(db, monkeypatch):
    # If the model path were taken this would blow up; demo must not touch it.
    def _boom(*args, **kwargs):
        raise AssertionError("demo path must not call the model")

    monkeypatch.setattr(fantasy_ai, "_openai_response", _boom)
    result = fantasy_ai.answer_demo_chat("Who are the top WRs?")
    assert any("demo mode" in w.lower() for w in result["warnings"])
    assert result["answer"]


def test_out_of_scope_returns_refusal(db):
    result = fantasy_ai.answer_demo_chat("What's the weather tomorrow?")
    assert "fantasy football" in result["answer"].lower()
    assert result["tools_used"] == []


# ── model tool-loop with a stubbed OpenAI response ──────────────────────


def test_model_loop_executes_tool_then_answers(db, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    calls = {"n": 0}

    def fake_openai(input_items):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"output": [{
                "type": "function_call", "name": "get_rankings", "call_id": "c1",
                "arguments": json.dumps({"position": "QB", "scoring": "ppr", "week": None, "limit": 5}),
            }]}
        # Second turn: the tool output is now in the input; return final text.
        assert any(i.get("type") == "function_call_output" for i in input_items)
        return {"output_text": "Josh Allen is the top QB this week."}

    monkeypatch.setattr(fantasy_ai, "_openai_response", fake_openai)
    result = fantasy_ai.answer_chat("Who is the best QB this week?")
    assert result["tools_used"] == ["get_rankings"]
    assert "Josh Allen" in result["answer"]


# ── endpoint contract ───────────────────────────────────────────────────


def test_chat_endpoint_demo_sets_cookie_and_answers(db):
    response = client.post("/api/fantasy/chat", json={"message": "top RBs this week"})
    assert response.status_code == 200
    body = response.json()
    assert "answer" in body and "tools_used" in body
    assert "pg_fantasy_session" in response.cookies


def test_chat_endpoint_rejects_empty_message():
    assert client.post("/api/fantasy/chat", json={"message": ""}).status_code == 422
