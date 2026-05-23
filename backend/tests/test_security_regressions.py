from fastapi.testclient import TestClient

from app.log_handler import _redact_sensitive_query_values
from app.database import Base, PokerGameState, SessionLocal, engine
from app.main import (
    AUTH_RATE_LIMIT_MAX_ATTEMPTS,
    SESSION_COOKIE_NAME,
    _auth_failure_store,
    app,
    create_app_session_token,
)
from app.routers import poker


client = TestClient(app)


def setup_function():
    poker.games.clear()
    poker.ai_managers.clear()
    poker.game_last_accessed.clear()
    poker.ai_last_processed.clear()
    poker.player_tokens.clear()
    poker._rate_limit_store.clear()
    _auth_failure_store.clear()
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        db.query(PokerGameState).delete()
        db.commit()
    finally:
        db.close()


def create_single_player_game():
    response = client.post(
        "/api/poker/games",
        json={"player_name": "Alice", "game_type": "single"},
    )
    assert response.status_code == 200
    return response.json()


def test_poker_state_requires_player_token_header_not_query_string():
    data = create_single_player_game()

    query_token_response = client.get(
        f"/api/poker/games/{data['game_id']}",
        params={
            "player_id": data["player_id"],
            "player_token": data["player_token"],
        },
    )
    assert query_token_response.status_code == 403

    header_token_response = client.get(
        f"/api/poker/games/{data['game_id']}",
        params={"player_id": data["player_id"]},
        headers={"X-Player-Token": data["player_token"]},
    )
    assert header_token_response.status_code == 200


def test_buy_back_uses_server_defined_amount_for_busted_players():
    data = create_single_player_game()
    game = poker.games[data["game_id"]]
    player = game._get_player(data["player_id"])
    player.chips = 0
    player.is_all_in = True
    game.phase = "showdown"

    response = client.post(
        f"/api/poker/games/{data['game_id']}/buy-back",
        json={
            "player_id": data["player_id"],
            "player_token": data["player_token"],
            "amount": 999999,
        },
    )

    assert response.status_code == 200
    assert game._get_player(data["player_id"]).chips == poker.BUY_BACK_AMOUNT


def test_stock_price_history_rejects_unbounded_day_ranges():
    response = client.get("/api/stocks/AAPL/prices", params={"days": 100000000})

    assert response.status_code == 422


def test_log_redaction_removes_sensitive_query_values():
    message = '127.0.0.1 - "GET /api/poker/games/abc?player_id=p0&player_token=secret123 HTTP/1.1" 200'

    redacted = _redact_sensitive_query_values(message)

    assert "secret123" not in redacted
    assert "player_token=[REDACTED]" in redacted


def test_admin_page_redirects_to_login_for_html_requests(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    auth_client = TestClient(app)

    response = auth_client.get(
        "/admin/",
        headers={"accept": "text/html"},
        follow_redirects=False,
    )

    assert response.status_code == 302
    assert response.headers["location"] == "/login/?next=/admin/"


def test_login_session_sets_signed_session_cookie(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    auth_client = TestClient(app)

    response = auth_client.post(
        "/login/session",
        json={"username": "palmer", "password": "secret"},
    )

    assert response.status_code == 200
    assert f"{SESSION_COOKIE_NAME}=" in response.headers["set-cookie"]
    assert "HttpOnly" in response.headers["set-cookie"]

    protected_response = auth_client.get("/api/unknown")
    assert protected_response.status_code == 404


def test_signed_session_cookie_allows_protected_api_without_basic_auth(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    auth_client = TestClient(app)
    token = create_app_session_token("palmer", "secret")
    auth_client.cookies.set(SESSION_COOKIE_NAME, token)

    response = auth_client.get("/api/unknown")

    assert response.status_code == 404


def test_login_session_rate_limits_repeated_failures(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    auth_client = TestClient(app)

    for _ in range(AUTH_RATE_LIMIT_MAX_ATTEMPTS):
        response = auth_client.post(
            "/login/session",
            json={"username": "palmer", "password": "wrong"},
        )
        assert response.status_code == 401

    limited_response = auth_client.post(
        "/login/session",
        json={"username": "palmer", "password": "secret"},
    )

    assert limited_response.status_code == 429


def test_malformed_basic_auth_returns_challenge(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    auth_client = TestClient(app)

    response = auth_client.get(
        "/api/unknown",
        headers={"authorization": "Basic not-base64"},
    )

    assert response.status_code == 401


def test_poker_game_state_loads_from_persisted_store_after_memory_clear():
    data = create_single_player_game()
    game_id = data["game_id"]
    player_id = data["player_id"]
    player_token = data["player_token"]

    poker.games.clear()
    poker.ai_managers.clear()
    poker.game_last_accessed.clear()
    poker.ai_last_processed.clear()
    poker.player_tokens.clear()

    response = client.get(
        f"/api/poker/games/{game_id}",
        params={"player_id": player_id},
        headers={"X-Player-Token": player_token},
    )

    assert response.status_code == 200
    assert response.json()["game_id"] == game_id
