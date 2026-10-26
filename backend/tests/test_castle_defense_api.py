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
from app.database import CastleDefenseOpenScore, CastleDefenseScore, SessionLocal
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
        db.query(CastleDefenseOpenScore).delete()
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
    """`day`'s allotment, its grass tiles (best spots first) and road tiles, from the engine itself."""
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
            " return JSON.stringify({ allotment: m.allotment, grass, road }); })()" % json.dumps(day)
        )
    finally:
        ctx.close()
    return json.loads(raw)


TRAPS = ("spikes", "tar", "mine")


def _place(day: str, types, worst=False):
    """Put `types` on `day`'s map: towers on the best grass (or the worst)."""
    tiles = _tiles(day)
    grass = iter(reversed(tiles["grass"]) if worst else tiles["grass"])
    road = iter(tiles["road"])
    out = []
    for t in types:
        x, y = next(road) if t in TRAPS else next(grass)
        out.append({"type": t, "x": x, "y": y})
    return out


def _everything(day: str):
    """Every piece in the day's allotment, well placed."""
    allotment = _tiles(day)["allotment"]
    return _place(day, [t for t, n in allotment.items() for _ in range(n)])


def _one_piece(day: str):
    """A single piece, badly placed: a weak run."""
    allotment = _tiles(day)["allotment"]
    first = next(t for t, n in allotment.items() if n)
    return _place(day, [first], worst=True)


def test_anyone_can_read_the_board():
    response = TestClient(app).get(f"/api/castle-defense/leaderboard?day={TODAY}")
    assert response.status_code == 200
    assert response.json() == {"day": TODAY, "players": 0, "entries": [], "you": None}


def test_posting_needs_an_account():
    response = TestClient(app).post("/api/castle-defense/runs", json={"day": TODAY, "layout": _one_piece(TODAY)})
    assert response.status_code == 403
    assert "Sign in" in response.json()["detail"]


def test_the_server_scores_the_run_itself():
    client = _member()
    layout = _everything(TODAY)
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
        # One more of something than today's allotment gives.
        (lambda: _everything(TODAY) + _place(TODAY, [next(t for t, n in _tiles(TODAY)["allotment"].items() if n)], worst=True)[:1], "left"),
    ],
)
def test_impossible_layouts_are_refused(layout_fn, message):
    response = _member().post("/api/castle-defense/runs", json={"day": TODAY, "layout": layout_fn()})
    assert response.status_code == 422
    assert message in response.json()["detail"]


def test_only_todays_map_is_ranked():
    old = (datetime.now(timezone.utc).date() - timedelta(days=5)).isoformat()
    response = _member().post("/api/castle-defense/runs", json={"day": old, "layout": _one_piece(old)})
    assert response.status_code == 422


def test_best_run_counts_and_places_are_shared_on_ties():
    strong, weak = _everything(TODAY), _one_piece(TODAY)
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


def test_scores_from_older_rules_are_left_off_and_then_replaced():
    current = castle_defense.current_rules()
    member = _member("Dana")
    db = SessionLocal()
    try:
        db.add(CastleDefenseScore(day=TODAY, username="dana", display_name="Dana", kills=99999, wave=99, layout="[]", runs=1, rules=current - 1))
        db.commit()
    finally:
        db.close()

    # The old score isn't comparable, so the board doesn't show it...
    assert member.get(f"/api/castle-defense/leaderboard?day={TODAY}").json()["players"] == 0
    # ...and Dana's first run under today's rules replaces it, however it scores.
    body = member.post("/api/castle-defense/runs", json={"day": TODAY, "layout": _one_piece(TODAY)}).json()
    assert body["improved"] and body["best"]["kills"] == body["kills"] < 99999
    assert body["players"] == 1 and body["best"]["runs"] == 2


# ── the open field ──────────────────────────────────────────────────────────


def _open_layout(day: str):
    """Every piece in the open day's allotment, packed around the castle."""
    ctx = MiniRacer()
    try:
        ctx.eval(castle_defense.engine_source())
        raw = ctx.eval(
            "(() => { const G = CastleDefenseGame; const m = G.dailyMap(%s, 'open'); const grass = [];"
            " for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) if (G.isGrass(m, x, y)) grass.push([x, y]);"
            " const gap = ([x, y]) => Math.hypot(x - m.castle.x, y - m.castle.y);"
            " grass.sort((a, b) => gap(a) - gap(b)); const out = [];"
            " for (const [t, n] of Object.entries(m.allotment)) for (let i = 0; i < n; i++) {"
            "  const [x, y] = grass.shift(); out.push({ type: t, x, y }); }"
            " return JSON.stringify(out); })()" % json.dumps(day)
        )
    finally:
        ctx.close()
    return json.loads(raw)


def test_open_runs_are_scored_on_their_own_board():
    client = _member("Erin")
    layout = _open_layout(TODAY)
    body = client.post("/api/castle-defense/runs", json={"day": TODAY, "mode": "open", "layout": layout}).json()
    expected = castle_defense.replay(TODAY, layout, "open")
    assert body["kills"] == expected["kills"] > 0
    assert body["best"]["rank"] == 1 and body["players"] == 1

    open_board = client.get(f"/api/castle-defense/leaderboard?day={TODAY}&mode=open").json()
    assert [e["name"] for e in open_board["entries"]] == ["Erin"]
    # The classic board never sees it.
    assert client.get(f"/api/castle-defense/leaderboard?day={TODAY}").json()["players"] == 0

    classic = client.post("/api/castle-defense/runs", json={"day": TODAY, "layout": _one_piece(TODAY)}).json()
    assert classic["players"] == 1 and classic["best"]["runs"] == 1


def test_an_open_layout_is_checked_against_the_open_map():
    layout = _open_layout(TODAY)
    castle = json.loads(_eval_open(f"JSON.stringify(CastleDefenseGame.dailyMap({json.dumps(TODAY)}, 'open').castle)"))
    bad = [{"type": layout[0]["type"], "x": castle["x"], "y": castle["y"]}]
    response = _member().post("/api/castle-defense/runs", json={"day": TODAY, "mode": "open", "layout": bad})
    assert response.status_code == 422
    assert "castle" in response.json()["detail"]


def test_unknown_modes_are_refused():
    response = TestClient(app).get(f"/api/castle-defense/leaderboard?day={TODAY}&mode=sideways")
    assert response.status_code == 422


def _eval_open(expression: str) -> str:
    ctx = MiniRacer()
    try:
        ctx.eval(castle_defense.engine_source())
        return ctx.eval(expression)
    finally:
        ctx.close()
