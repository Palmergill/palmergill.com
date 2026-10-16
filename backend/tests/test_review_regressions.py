"""Regressions from the 2026-10-15 whole-codebase review.

Each test pins one finding: a leaked provider key, a login rate limit any
account could reset, non-ASCII credentials that 500'd, a poker lobby a guest
could start, sync I/O inside coroutines, and the casino service workers
drifting from the asset versions their pages load.
"""
import base64
import importlib
import inspect
import re
import uuid
from pathlib import Path

import pytest
import requests
from fastapi.testclient import TestClient

from app import accounts
from app.database import FantasyPlayer, SessionLocal
from app.main import (
    AUTH_RATE_LIMIT_MAX_ATTEMPTS,
    ROLE_MEMBER,
    SESSION_COOKIE_NAME,
    _auth_failure_store,
    app,
    create_app_session_token,
)
from app.routers import analytics, craps, poker, stocks
from app.services import bitcoin_tools, fantasy_rankings_board
from app.services.polygon_client import polygon_client

ADMIN = "palmer"
SECRET = "secret"
REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def _auth_env(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", ADMIN)
    monkeypatch.setenv("APP_AUTH_PASSWORD", SECRET)
    monkeypatch.delenv("LOCAL_SITE_ROOT", raising=False)
    monkeypatch.delenv("LOCAL_AUTH_USER", raising=False)
    _auth_failure_store.clear()
    poker._rate_limit_store.clear()
    yield
    _auth_failure_store.clear()


def _member_client() -> TestClient:
    name = f"review{uuid.uuid4().hex[:10]}"
    db = SessionLocal()
    try:
        accounts.create_user(db, name, "correct-horse-battery")
    finally:
        db.close()
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token(name, SECRET, role=ROLE_MEMBER))
    return client


# ── 1. provider errors must not leak the Polygon key ──────────────────────


def test_stock_error_does_not_leak_polygon_api_key(monkeypatch):
    stock_module = importlib.import_module("app.services.stock_data_client")
    monkeypatch.setattr(stock_module, "USE_REAL_DATA", True)
    monkeypatch.setattr(stock_module, "ALLOW_MOCK_FALLBACK", False)
    monkeypatch.setattr(polygon_client, "api_key", "SECRET_POLYGON_KEY")

    def fake_get(url, params=None, timeout=None):
        response = requests.Response()
        response.status_code = 404
        response.reason = "Not Found"
        response.url = requests.Request("GET", url, params=params).prepare().url
        return response

    monkeypatch.setattr(requests, "get", fake_get)

    response = _member_client().get(f"/api/stocks/ZZ{uuid.uuid4().hex[:4].upper()}")

    assert response.status_code >= 400
    assert "SECRET_POLYGON_KEY" not in response.text
    assert "apiKey" not in response.text


# ── 2. a session cookie must not reset the login rate limit ───────────────


def test_member_session_does_not_reset_login_failures():
    member = _member_client()
    attacker = TestClient(app)

    for attempt in range(AUTH_RATE_LIMIT_MAX_ATTEMPTS):
        response = attacker.post("/login/session", json={"username": ADMIN, "password": f"guess{attempt}"})
        assert response.status_code == 401

    # The same IP makes a signed-in request with its own free account...
    assert member.get("/login/session").json()["authenticated"] is True

    # ...and is still locked out of guessing.
    response = attacker.post("/login/session", json={"username": ADMIN, "password": SECRET})
    assert response.status_code == 429


def test_correct_password_still_clears_login_failures():
    client = TestClient(app)
    for attempt in range(AUTH_RATE_LIMIT_MAX_ATTEMPTS - 1):
        client.post("/login/session", json={"username": ADMIN, "password": f"guess{attempt}"})

    assert client.post("/login/session", json={"username": ADMIN, "password": SECRET}).status_code == 200
    assert not _auth_failure_store


# ── 3. non-ASCII credentials are a normal failure, not a 500 ──────────────


def test_member_with_non_ascii_display_name_can_log_in():
    name = f"straße{uuid.uuid4().hex[:6]}"
    # Created directly: the public signup route's daily cap is shared with
    # the rest of the suite. Signup accepts this name — "ß" casefolds to
    # "ss" — and the display name keeps the "ß".
    db = SessionLocal()
    try:
        accounts.create_user(db, name, "longpassword1")
    finally:
        db.close()

    client = TestClient(app)
    assert client.post("/login/session", json={"username": name, "password": "wrong-password"}).status_code == 401
    response = client.post("/login/session", json={"username": name, "password": "longpassword1"})
    assert response.status_code == 200
    assert response.json()["role"] == ROLE_MEMBER


def test_non_ascii_basic_credentials_do_not_500():
    header = "Basic " + base64.b64encode("josé:pässword".encode("utf-8")).decode("ascii")

    public = TestClient(app).get("/api/poker/health", headers={"Authorization": header})
    protected = TestClient(app).get("/api/admin/logs", headers={"Authorization": header})

    assert public.status_code == 200
    assert protected.status_code == 401


def test_non_ascii_session_cookie_signature_is_rejected_not_500():
    cookie = f"{SESSION_COOKIE_NAME}=payload.sïgnature".encode("utf-8")
    response = TestClient(app).get("/login/session", headers={"Cookie": cookie})

    assert response.status_code == 200
    assert response.json()["authenticated"] is False


def test_non_ascii_poker_token_is_403_not_500():
    game = TestClient(app).post("/api/poker/games", json={"player_name": "Alice"}).json()

    response = TestClient(app).get(
        f"/api/poker/games/{game['game_id']}",
        params={"player_id": game["player_id"]},
        headers={"X-Player-Token": "tökén".encode("utf-8")},
    )

    assert response.status_code == 403


# ── 4. only the host starts a multiplayer game ───────────────────────────


def test_guest_cannot_start_multiplayer_lobby_with_next_hand():
    client = TestClient(app)
    host = client.post("/api/poker/games", json={"player_name": "Host", "game_type": "multiplayer"}).json()
    guest = client.post("/api/poker/games/join", json={"game_id": host["game_id"], "player_name": "Guest"}).json()
    game_id = host["game_id"]

    guest_auth = {"player_id": guest["player_id"], "player_token": guest["player_token"]}
    assert client.post(f"/api/poker/games/{game_id}/start", json=guest_auth).status_code == 403
    response = client.post(f"/api/poker/games/{game_id}/next-hand", json=guest_auth)
    assert response.status_code == 400
    assert poker.games[game_id].phase == "waiting"

    host_auth = {"player_id": host["player_id"], "player_token": host["player_token"]}
    started = client.post(f"/api/poker/games/{game_id}/start", json=host_auth)
    assert started.status_code == 200
    assert started.json()["phase"] == "preflop"


# ── 5. blocking I/O stays off the event loop ─────────────────────────────


@pytest.mark.parametrize(
    "endpoint",
    [
        stocks.search_stocks_endpoint,
        stocks.get_earnings,
        stocks.get_price_history,
        stocks.get_stock,
        craps.translate,
        analytics.create_event,
    ],
    ids=lambda endpoint: endpoint.__name__,
)
def test_blocking_routes_are_sync_so_they_run_in_the_threadpool(endpoint):
    assert not inspect.iscoroutinefunction(endpoint)


# ── 6. the session cookie is Secure behind the https proxy ───────────────


def test_session_cookie_is_secure_behind_https_proxy():
    response = TestClient(app).post(
        "/login/session",
        json={"username": ADMIN, "password": SECRET},
        headers={"X-Forwarded-Proto": "https"},
    )

    assert response.status_code == 200
    assert "secure" in response.headers["set-cookie"].lower()


# ── 7. casino workers precache what their pages load ─────────────────────


CASINO_APPS = ["poker", "craps", "blackjack", "craps-strategy", "high-card-flush"]


@pytest.mark.parametrize("app_dir", CASINO_APPS)
def test_service_worker_precaches_every_versioned_page_asset(app_dir):
    """Fourth time this drifted (most recently site-nav.js v18 vs v19).

    The worker's cache name is derived from STATIC_ASSETS, so a page asset at
    a version the worker doesn't list is never precached and the app breaks
    offline after the next deploy.
    """
    page = (REPO_ROOT / app_dir / "index.html").read_text()
    worker = (REPO_ROOT / app_dir / "sw.js").read_text()
    precached = set(re.findall(r"""['"](/[^'"]+\?v=\d+)['"]""", worker))

    page_assets = set()
    for ref in re.findall(r'(?:src|href)="([^"]+\?v=\d+)"', page):
        if ref.startswith("/"):
            page_assets.add(ref)
        else:
            page_assets.add(f"/{app_dir}/{ref.removeprefix('./')}")

    assert page_assets, "expected the page to load versioned assets"
    assert page_assets - precached == set()


# ── 8. LIKE wildcards in a rankings search are literal ───────────────────


def test_rankings_search_treats_like_wildcards_literally():
    db = SessionLocal()
    try:
        player_id = f"rv{uuid.uuid4().hex[:8]}"
        db.add(FantasyPlayer(player_id=player_id, full_name="Wild Card", search_name="wild card", position="RB"))
        db.commit()

        assert fantasy_rankings_board.search_rankable_players(db, "%%", None) == []
        assert fantasy_rankings_board.search_rankable_players(db, "w_ld", None) == []
        found = fantasy_rankings_board.search_rankable_players(db, "wild", None)
        assert player_id in [row.get("player_id", row.get("id")) for row in found]
    finally:
        db.query(FantasyPlayer).filter(FantasyPlayer.player_id == player_id).delete()
        db.commit()
        db.close()


# ── 9. block lookups are validated before reaching a provider URL ────────


@pytest.mark.parametrize("value", ["..", "abc?x=1", "١٢٣", "12a", "f" * 63, "g" * 64, ""])
def test_get_block_rejects_values_that_are_not_a_height_or_hash(value):
    with pytest.raises(ValueError):
        bitcoin_tools.get_block(value)
