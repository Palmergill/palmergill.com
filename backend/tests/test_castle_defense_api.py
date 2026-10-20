"""Castle Defense leaderboard: the auth boundary, server-side scoring, ranking.

The invariant: a stored score is always the server's own replay of the posted
layout. The browser never gets to name its score.
"""
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from py_mini_racer import MiniRacer

from app import accounts
from app.database import CastleDefenseScore, SessionLocal
from app.main import ROLE_MEMBER, SESSION_COOKIE_NAME, app, create_app_session_token
from app.services import castle_defense

SECRET = "secret"
TODAY = datetime.now(timezone.utc).date().isoformat()


@pytest.fixture(autouse=True)
def _auth_env(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", SECRET)
    monkeypatch.delenv("LOCAL_SITE_ROOT", raising=False)
    monkeypatch.delenv("LOCAL_AUTH_USER", raising=False)


@pytest.fixture(autouse=True)
def _clean_board():
    db = SessionLocal()
    try:
        db.query(CastleDefenseScore).delete()
        db.commit()
    finally:
        db.close()


def _member(display: str = None) -> TestClient:
    name = f"cd{uuid.uuid4().hex[:10]}"
    db = SessionLocal()
    try:
        accounts.create_user(db, display or name, "correct-horse-battery")
    finally:
        db.close()
    normalized = accounts.normalize_username(display or name)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token(normalized, SECRET, role=ROLE_MEMBER))
    return client


def _tiles(day: str):
    """Grass tiles (best spots first) and road tiles of `day`'s map, from the engine itself."""
    ctx = MiniRacer()
    try:
        ctx.eval(castle_defense.engine_source())
        raw = ctx.eval(
            "(() => { const G = CastleDefenseGame; const m = G.dailyMap(%s); const grass = [], road = [];"
            " const reach = (x, y) => { let n = 0; for (let d = 0; d < m.length; d += 0.2) {"
            "  const p = G.pointAt(m, d); if (Math.hypot(p.x - x - 0.5, p.y - y - 0.5) < 2) n++; } return n; };"
            " for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {"
            "  if (G.isGrass(m, x, y)) grass.push([x, y]); else if (G.isRoad(m, x, y)) road.push([x, y]); }"
            # Best-placed grass first, the way a player would build.
            " grass.sort((a, b) => reach(b[0], b[1]) - reach(a[0], a[1]));"
            " return JSON.stringify({ grass, road }); })()" % json.dumps(day)
        )
    finally:
        ctx.close()
    return json.loads(raw)


def _layout(day: str, *types):
    tiles = _tiles(day)
    grass, road = iter(tiles["grass"]), iter(tiles["road"])
    out = []
    for t in types:
        x, y = next(road) if t in ("spikes", "tar", "mine") else next(grass)
        out.append({"type": t, "x": x, "y": y})
    return out


def test_anyone_can_read_the_board():
    response = TestClient(app).get(f"/api/castle-defense/leaderboard?day={TODAY}")
    assert response.status_code == 200
    assert response.json() == {"day": TODAY, "players": 0, "entries": [], "you": None}


def test_posting_needs_an_account():
    response = TestClient(app).post("/api/castle-defense/runs", json={"day": TODAY, "layout": _layout(TODAY, "spikes")})
    assert response.status_code == 403
    assert "Sign in" in response.json()["detail"]


def test_the_server_scores_the_run_itself():
    client = _member()
    layout = _layout(TODAY, "archer", "spikes")
    # Anything the browser might claim is ignored: there's no score field.
    response = client.post("/api/castle-defense/runs", json={"day": TODAY, "layout": layout, "kills": 99999})
    assert response.status_code == 200
    body = response.json()
    expected = castle_defense.replay(TODAY, layout)
    assert body["kills"] == expected["kills"] > 0
    assert body["best"]["rank"] == 1 and body["players"] == 1 and body["improved"]


@pytest.mark.parametrize(
    "layout_fn, message",
    [
        (lambda: [{"type": "archer", "x": _tiles(TODAY)["road"][0][0], "y": _tiles(TODAY)["road"][0][1]}], "grass"),
        (lambda: _layout(TODAY, "mage", "mage", "mage", "mage"), "gold"),
    ],
)
def test_impossible_layouts_are_refused(layout_fn, message):
    response = _member().post("/api/castle-defense/runs", json={"day": TODAY, "layout": layout_fn()})
    assert response.status_code == 422
    assert message in response.json()["detail"]


def test_only_todays_map_is_ranked():
    old = (datetime.now(timezone.utc).date() - timedelta(days=5)).isoformat()
    response = _member().post("/api/castle-defense/runs", json={"day": old, "layout": _layout(old, "spikes")})
    assert response.status_code == 422


def test_best_run_counts_and_places_are_shared_on_ties():
    strong, weak = _layout(TODAY, "archer", "mage", "spikes"), _layout(TODAY, "spikes")
    alice, bob, cara = _member("Alice"), _member("Bob"), _member("Cara")

    first = alice.post("/api/castle-defense/runs", json={"day": TODAY, "layout": strong}).json()
    # A worse run later doesn't replace Alice's best; it only counts the attempt.
    again = alice.post("/api/castle-defense/runs", json={"day": TODAY, "layout": weak}).json()
    assert not again["improved"] and again["best"]["kills"] == first["kills"] and again["best"]["runs"] == 2

    bob.post("/api/castle-defense/runs", json={"day": TODAY, "layout": weak})
    cara.post("/api/castle-defense/runs", json={"day": TODAY, "layout": weak})

    board = bob.get(f"/api/castle-defense/leaderboard?day={TODAY}").json()
    assert board["players"] == 3
    assert [(e["name"], e["rank"]) for e in board["entries"]] == [("Alice", 1), ("Bob", 2), ("Cara", 2)]
    assert board["you"]["name"] == "Bob" and board["you"]["rank"] == 2
    assert [e["you"] for e in board["entries"]] == [False, True, False]
