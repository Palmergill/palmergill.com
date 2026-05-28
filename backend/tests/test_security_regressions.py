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
from app.routers import analytics as analytics_router
from app.routers.admin import cleanup_old_logs
from app.routers.analytics import cleanup_old_analytics, record_analytics_event, safe_json
from app.routers import poker
from app.routers.bitcoin import BITCOIN_SESSION_COOKIE
from app.services import bitcoin_ai, bitcoin_tools
from app.poker_ai import AIManager
from app.poker_game import PokerGame
from datetime import datetime, timedelta, timezone
import asyncio
import json


client = TestClient(app)


def setup_function():
    poker.games.clear()
    poker.ai_managers.clear()
    poker.game_last_accessed.clear()
    poker.ai_last_processed.clear()
    poker.player_tokens.clear()
    poker._game_save_versions.clear()
    poker._game_persisted_versions.clear()
    poker._game_persist_locks.clear()
    poker._rate_limit_store.clear()
    analytics_router._analytics_rate_limit_store.clear()
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


def test_tournament_next_hand_skips_eliminated_players():
    game = PokerGame("tour")
    for name in ["Hero", "Reg", "Cal", "Stone", "Avery", "Action"]:
        game.add_player(name, is_human=(name == "Hero"))
    game.configure_tournament()

    game.players[2].chips = 0
    game.players[3].chips = 0
    game._record_tournament_eliminations()
    game.dealer_index = 2

    assert game.start_hand() is True

    eliminated = {game.players[2].id, game.players[3].id}
    assert game.current_player_index not in {2, 3}
    for idx, player in enumerate(game.players):
        if player.id in eliminated:
            assert player.hand == []
            assert player.folded is True
            assert player.is_all_in is True
        else:
            assert len(player.hand) == 2
            assert player.folded is False


def test_tournament_processes_ai_turns():
    game = PokerGame("tour-ai")
    game.add_player("Hero", is_human=True)
    game.add_player("Reg", is_human=False)
    game.configure_tournament()
    game.start_hand()
    game.current_player_index = 1

    poker.ai_managers[game.game_id] = poker._ai_manager_for_game(game)
    poker.ai_last_processed.clear()

    assert poker.process_ai_turn_if_needed(game.game_id, game) is True
    assert game.last_action is not None


def test_process_ai_batches_consecutive_bot_turns():
    game = PokerGame("bot-batch")
    game.add_player("Hero", is_human=True)
    game.add_player("Reg", is_human=False)
    game.add_player("Cal", is_human=False)
    game.start_hand()
    game.current_player_index = 1

    poker.games[game.game_id] = game
    poker.ai_managers[game.game_id] = poker._ai_manager_for_game(game)
    poker.ai_last_processed.clear()

    assert poker.process_ai_turn_if_needed(game.game_id, game) is True
    current = game.get_current_player()
    assert current is not None
    assert current.is_human is True


def test_deferred_poker_save_skips_stale_snapshot():
    game = PokerGame("save-order")
    player = game.add_player("Hero", is_human=True)
    game.add_player("Villain", is_human=False)
    game.start_hand()
    poker.games[game.game_id] = game
    poker.player_tokens[game.game_id] = {player.id: "token"}
    poker.update_game_access(game.game_id)

    stale = poker.save_game_state_deferred(game.game_id)
    player.chips = 777
    fresh = poker.save_game_state_deferred(game.game_id)

    asyncio.run(poker.flush_game_state(game.game_id, fresh))
    asyncio.run(poker.flush_game_state(game.game_id, stale))

    db = SessionLocal()
    try:
        row = db.get(PokerGameState, game.game_id)
        assert row is not None
        data = poker._deserialize_game(json.loads(row.payload.decode("utf-8"))["game"])
        assert data._get_player(player.id).chips == 777
    finally:
        db.close()


def test_deferred_poker_save_preserves_broadcast_for_skipped_snapshot(monkeypatch):
    game = PokerGame("save-broadcast")
    game.add_player("Hero", is_human=True)
    game.add_player("Villain", is_human=False)
    game.start_hand()
    poker.games[game.game_id] = game
    poker.update_game_access(game.game_id)

    broadcasts = []
    monkeypatch.setattr(poker, "schedule_game_changed", lambda game_id: broadcasts.append(game_id))

    stale_mutation = poker.save_game_state_deferred(game.game_id, broadcast=True)
    fresh_read = poker.save_game_state_deferred(game.game_id, broadcast=False)

    asyncio.run(poker.flush_game_state(game.game_id, stale_mutation))
    asyncio.run(poker.flush_game_state(game.game_id, fresh_read))

    assert broadcasts == [game.game_id]


def test_poker_serialization_preserves_ai_personality_metadata():
    game = PokerGame("persist")
    game.add_player("Hero", is_human=True)
    manager = AIManager(game)
    bot = manager.add_bot("Cal", personality="lp")

    restored = poker._deserialize_game(poker._serialize_game(game))
    restored_bot = restored._get_player(bot.id)
    restored_manager = poker._ai_manager_for_game(restored)

    assert restored_bot.ai_personality == "lp"
    assert restored_bot.ai_personality_label == "Loose-Passive"
    assert restored_manager.bots[bot.id].looseness == poker.PERSONALITIES["lp"]["looseness"]


def test_bitcoin_chat_session_cookie_is_not_exposed_to_browser(monkeypatch):
    seen_sessions = []

    def fake_demo_answer(message, session_id=None, timezone_name=None):
        seen_sessions.append(session_id)
        return {
            "answer": "demo answer",
            "session_id": session_id or "issued-session",
            "tools_used": [],
            "data": {},
            "warnings": [],
        }

    monkeypatch.setattr(bitcoin_ai, "answer_demo_chat", fake_demo_answer)
    chat_client = TestClient(app)

    first = chat_client.post("/api/bitcoin/chat", json={"message": "what is bitcoin?"})

    assert first.status_code == 200
    assert "session_id" not in first.json()
    assert f"{BITCOIN_SESSION_COOKIE}=issued-session" in first.headers["set-cookie"]
    assert "HttpOnly" in first.headers["set-cookie"]
    assert seen_sessions == [None]

    second = chat_client.post(
        "/api/bitcoin/chat",
        json={"message": "next", "session_id": "body-session"},
    )

    assert second.status_code == 200
    assert "session_id" not in second.json()
    assert seen_sessions[-1] == "issued-session"


def test_bitcoin_address_lookup_returns_demo_utxos_without_auth():
    address = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080"
    response = client.get(f"/api/bitcoin/address/{address}", params={"utxo_limit": 1})

    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "demo"
    assert body["address"] == address
    assert body["utxo_count"] == 2
    assert body["utxos_returned"] == 1
    assert len(body["utxos"]) == 1
    assert body["utxos"][0]["value_sats"] == 125000


def test_demo_bitcoin_address_lookup_normalizes_address_and_uses_hex_hash():
    address = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080"
    body = bitcoin_tools.get_demo_address(f"  {address}  ", utxo_limit=1)
    block_hash = body["utxos"][0]["block_hash"]

    assert body["address"] == address
    assert len(block_hash) == 64
    int(block_hash, 16)


def test_bitcoin_chat_routes_address_questions_to_address_tool():
    address = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080"
    result = bitcoin_ai.answer_demo_chat(f"what UTXOs are on {address}?", session_id="demo-session")

    assert result["tools_used"] == ["get_address"]
    assert result["data"]["address"] == address
    assert result["data"]["utxos"]
    assert "does not prove who controls the address" in result["answer"]


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


def test_public_analytics_events_are_rate_limited(monkeypatch):
    monkeypatch.setattr(analytics_router, "ANALYTICS_RATE_LIMIT_MAX_EVENTS", 2)
    monkeypatch.setattr(analytics_router, "ANALYTICS_RATE_LIMIT_WINDOW_SECONDS", 60)
    analytics_router._analytics_rate_limit_store.clear()

    payload = {
        "event_type": "app_event",
        "event_name": "rate_limit_probe",
        "app": "test",
        "path": "/test",
    }

    assert client.post("/api/analytics/events", json=payload).status_code == 200
    assert client.post("/api/analytics/events", json=payload).status_code == 200
    limited = client.post("/api/analytics/events", json=payload)

    assert limited.status_code == 429

    db = SessionLocal()
    try:
        assert db.query(AnalyticsEvent).filter(AnalyticsEvent.event_name == "rate_limit_probe").count() == 2
    finally:
        db.close()


def test_bitcoin_mined_yesterday_uses_yesterday_window(monkeypatch):
    captured = {}

    def fake_tool_call(demo, name, start_time, end_time):
        captured["demo"] = demo
        captured["name"] = name
        captured["start_time"] = start_time
        captured["end_time"] = end_time
        return {
            "source": "demo",
            "blocks_counted": 144,
            "subsidy_btc": 450,
            "warnings": [],
        }

    monkeypatch.setattr(bitcoin_ai, "_local_tool_call", fake_tool_call)

    response = bitcoin_ai.answer_demo_chat("How many BTC were mined yesterday?", timezone_name="UTC")
    start = datetime.fromisoformat(captured["start_time"].replace("Z", "+00:00"))
    end = datetime.fromisoformat(captured["end_time"].replace("Z", "+00:00"))
    expected_day = datetime.now(timezone.utc).date() - timedelta(days=1)

    assert captured["demo"] is True
    assert captured["name"] == "get_mined_stats"
    assert start.date() == expected_day
    assert start.hour == 0 and start.minute == 0 and start.second == 0
    assert end.date() == expected_day
    assert end.hour == 23 and end.minute == 59 and end.second == 59
    assert "yesterday" in response["answer"].lower()
