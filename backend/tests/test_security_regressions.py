from fastapi.testclient import TestClient

from app.log_handler import _redact_sensitive_query_values
from app.database import AnalyticsEvent, Base, LogEntry, PokerGameState, SessionLocal, engine, utc_now
from app.main import (
    AUTH_RATE_LIMIT_MAX_ATTEMPTS,
    SESSION_COOKIE_NAME,
    _auth_failure_store,
    app,
    create_app_session_token,
)
from app.routers.admin import cleanup_old_logs
from app.routers.analytics import cleanup_old_analytics, record_analytics_event, safe_json
from app.routers import poker
from datetime import timedelta


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
        db.query(AnalyticsEvent).delete()
        db.query(LogEntry).delete()
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


def test_analytics_redacts_sensitive_metadata_values():
    payload = safe_json({
        "ticker": "AAPL",
        "password": "secret",
        "nested": {
            "api_key": "abc",
            "url": "/api/poker/games/abc?player_token=secret123",
        },
    })

    assert "AAPL" in payload
    assert "secret123" not in payload
    assert "secret\"" not in payload
    assert '"api_key":"abc"' not in payload
    assert "[REDACTED]" in payload


def test_analytics_and_log_retention_prune_old_rows():
    db = SessionLocal()
    try:
        old_time = utc_now() - timedelta(days=91)
        current_time = utc_now()
        old_event = record_analytics_event(
            db,
            event_type="page_view",
            event_name="page_view",
            path="/old",
        )
        current_event = record_analytics_event(
            db,
            event_type="page_view",
            event_name="page_view",
            path="/current",
        )
        old_event.timestamp = old_time
        current_event.timestamp = current_time
        db.add(LogEntry(timestamp=old_time, level="INFO", message="old"))
        db.add(LogEntry(timestamp=current_time, level="INFO", message="current"))
        db.commit()

        assert cleanup_old_analytics(db) == 1
        assert cleanup_old_logs(db) == 1
        assert db.query(AnalyticsEvent).filter(AnalyticsEvent.path == "/current").count() == 1
        assert db.query(LogEntry).filter(LogEntry.message == "current").count() == 1
    finally:
        db.close()


def test_admin_debug_and_export_endpoints(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    auth_client = TestClient(app)
    auth_client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token("palmer", "secret"))

    db = SessionLocal()
    try:
        record_analytics_event(
            db,
            event_type="request",
            event_name="http_request",
            path="/api/example",
            method="GET",
            status_code=500,
            duration_ms=1500,
        )
        db.add(LogEntry(level="ERROR", message="example failure", path="/api/example", method="GET", status_code=500))
        db.commit()
    finally:
        db.close()

    slow = auth_client.get("/api/admin/analytics/slow")
    groups = auth_client.get("/api/admin/analytics/error-groups")
    analytics_csv = auth_client.get("/api/admin/analytics/export")
    logs_csv = auth_client.get("/api/admin/logs/export", params={"outcome": "error"})

    assert slow.status_code == 200
    assert slow.json()["entries"][0]["path"] == "/api/example"
    assert groups.status_code == 200
    assert groups.json()["groups"][0]["path"] == "/api/example"
    assert analytics_csv.status_code == 200
    assert "text/csv" in analytics_csv.headers["content-type"]
    assert "/api/example" in analytics_csv.text
    assert logs_csv.status_code == 200
    assert "example failure" in logs_csv.text


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
