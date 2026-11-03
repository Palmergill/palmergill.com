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
from app.database import CastleDefenseScore, CastleDefenseTiers, SessionLocal
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


# ── daily tiers ─────────────────────────────────────────────────────────────


def _clear_tiers():
    db = SessionLocal()
    try:
        db.query(CastleDefenseTiers).delete()
        db.commit()
    finally:
        db.close()


def test_tiers_are_worked_out_on_the_server(monkeypatch):
    """A day nobody has asked about is queued, worked out in the background,
    and then served: four rising cut-offs and a best found at least as high
    as the top one needs."""
    _clear_tiers()
    monkeypatch.setattr(castle_defense, "TRIALS", 12)
    monkeypatch.setattr(castle_defense, "CLIMB_STEPS", 6)
    client = TestClient(app)
    first = client.get(f"/api/castle-defense/tiers?day={TODAY}").json()
    assert first == {"day": TODAY, "ready": False}
    worker = castle_defense._tier_worker
    if worker:
        worker.join(timeout=120)
    body = client.get(f"/api/castle-defense/tiers?day={TODAY}").json()
    assert body["ready"]
    cuts = body["cuts"]
    assert len(cuts) == 4 and all(a < b for a, b in zip([0] + cuts, cuts)), cuts
    assert body["best"] >= cuts[3] - 1

    # The best found layout is a real one: replaying it scores what was stored.
    db = SessionLocal()
    try:
        row = db.query(CastleDefenseTiers).filter_by(day=TODAY).one()
        assert castle_defense.replay(TODAY, json.loads(row.best_layout))["kills"] == row.best_kills
    finally:
        db.close()

    # A run past the best found becomes the best found.
    db = SessionLocal()
    try:
        db.add(_score(TODAY, "zed", body["best"] + 50))
        db.commit()
    finally:
        db.close()
    assert client.get(f"/api/castle-defense/tiers?day={TODAY}").json()["best"] == body["best"] + 50


def test_tiers_are_never_worked_out_far_ahead():
    _clear_tiers()
    far = (datetime.now(timezone.utc).date() + timedelta(days=30)).isoformat()
    body = TestClient(app).get(f"/api/castle-defense/tiers?day={far}").json()
    assert body == {"day": far, "ready": False}
    assert far not in castle_defense._tier_queue


# ── all time ────────────────────────────────────────────────────────────────


def _score(day, username, kills, rules=None):
    return CastleDefenseScore(
        day=day, username=username, display_name=username.title(), kills=kills, wave=10,
        layout="[]", runs=1, rules=rules if rules is not None else castle_defense.current_rules(),
    )


def test_all_time_is_a_medal_table():
    rules = castle_defense.current_rules()
    days = {
        # Ann takes gold; Bo and Cy share 2nd, a silver each; Di is 4th.
        "2026-10-20": {"ann": 300, "bo": 250, "cy": 250, "di": 200},
        # A tie for 1st is two golds and no silver: Ann's 3rd is bronze.
        "2026-10-21": {"bo": 400, "cy": 400, "ann": 390, "di": 100},
        # Di's gold, Ann's silver.
        "2026-10-22": {"di": 500, "ann": 10},
    }
    db = SessionLocal()
    try:
        for day, scores in days.items():
            for name, kills in scores.items():
                db.add(_score(day, name, kills))
        # A score from older rules on a day played under newer ones doesn't place.
        db.add(_score("2026-10-22", "eve", 99999, rules=rules - 1))
        db.commit()
    finally:
        db.close()

    board = TestClient(app).get("/api/castle-defense/all-time").json()
    rows = {e["name"]: (e["rank"], e["gold"], e["silver"], e["bronze"], e["days"]) for e in board["entries"]}
    # One gold each, so silvers and then bronzes decide it; Bo and Cy share 2nd.
    assert rows == {
        "Ann": (1, 1, 1, 1, 3),
        "Bo": (2, 1, 1, 0, 2),
        "Cy": (2, 1, 1, 0, 2),
        "Di": (4, 1, 0, 0, 3),
    }
    assert [e["name"] for e in board["entries"]][::3] == ["Ann", "Di"]
    assert board["days"] == 3 and board["players"] == 4
