from fastapi.testclient import TestClient

from app.log_handler import _redact_sensitive_query_values
from app.database import AnalyticsEvent, Base, LogEntry, PokerGameState, SessionLocal, engine, utc_now
from app.main import (
    AUTH_RATE_LIMIT_MAX_ATTEMPTS,
    SESSION_COOKIE_NAME,
    _auth_failure_store,
    app,
    create_app_session_token,
    safe_next_path,
)
from app.routers import analytics as analytics_router
from app.routers import bitcoin as bitcoin_router
from app.routers.admin import cleanup_old_logs
from app.routers.analytics import cleanup_old_analytics, record_analytics_event, safe_json
from app.routers import poker
from app.routers.bitcoin import BITCOIN_SESSION_COOKIE
from app.services import bitcoin_ai, bitcoin_tools
from app.poker_ai import AIManager
from app.poker_game import Card, PokerGame, Rank, Suit
from app.services.polygon_client import polygon_client
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


def test_get_game_state_does_not_write_a_snapshot():
    # GET is documented as read-only, but used to call save_game_state_deferred
    # on every poll — a full-payload DB write per client per poll interval for
    # zero benefit, since nothing in the handler mutates state.
    data = create_single_player_game()
    game_id = data["game_id"]
    version_after_create = poker._game_save_versions.get(game_id, 0)
    assert version_after_create > 0

    for _ in range(3):
        response = client.get(
            f"/api/poker/games/{game_id}",
            params={"player_id": data["player_id"]},
            headers={"X-Player-Token": data["player_token"]},
        )
        assert response.status_code == 200

    assert poker._game_save_versions.get(game_id, 0) == version_after_create


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


def test_bitcoin_chat_session_history_evicts_least_recently_used():
    # _SESSION_MESSAGES is a per-process dict keyed by chat session id with no
    # prior eviction policy, so it grew for the life of the process. Confirm
    # the LRU cap actually bounds it and evicts the oldest session once full.
    original_messages = dict(bitcoin_ai._SESSION_MESSAGES)
    original_max = bitcoin_ai.MAX_SESSIONS
    bitcoin_ai._SESSION_MESSAGES.clear()
    bitcoin_ai.MAX_SESSIONS = 3
    try:
        for i in range(3):
            bitcoin_ai._remember(f"session-{i}", "hi", "hello")
        assert list(bitcoin_ai._SESSION_MESSAGES.keys()) == ["session-0", "session-1", "session-2"]

        bitcoin_ai._remember("session-3", "hi", "hello")
        # session-0 was least-recently-used and gets evicted to stay at cap.
        assert list(bitcoin_ai._SESSION_MESSAGES.keys()) == ["session-1", "session-2", "session-3"]

        # Touching an existing session moves it to the back of the LRU order,
        # so the next eviction takes the new least-recently-used session.
        bitcoin_ai._remember("session-1", "again", "again")
        bitcoin_ai._remember("session-4", "hi", "hello")
        assert list(bitcoin_ai._SESSION_MESSAGES.keys()) == ["session-3", "session-1", "session-4"]
    finally:
        bitcoin_ai.MAX_SESSIONS = original_max
        bitcoin_ai._SESSION_MESSAGES.clear()
        bitcoin_ai._SESSION_MESSAGES.update(original_messages)


def test_cash_game_start_hand_skips_busted_players():
    # Non-tournament start_hand used to deal cards to every seat regardless of
    # chip count and only excluded zero-chip players in tournaments. A busted
    # cash-game player would get dealt in, occasionally get force-posted a $0
    # blind and marked all-in, and otherwise sit at the table indefinitely
    # looking like a live participant until they bought back.
    game = PokerGame("cash1")
    for name in ["Hero", "Busted", "Villain"]:
        game.add_player(name, is_human=False)
    busted = game.players[1]
    busted.chips = 0
    game.dealer_index = 1  # button sits on the busted seat

    assert game.start_hand() is True

    assert busted.hand == []
    assert busted.folded is True
    assert busted.is_all_in is True
    assert game.dealer_index != 1

    for player in (game.players[0], game.players[2]):
        assert len(player.hand) == 2
        assert player.folded is False


def test_cash_game_start_hand_declines_with_fewer_than_two_funded_players():
    game = PokerGame("cash2")
    for name in ["Hero", "Busted"]:
        game.add_player(name, is_human=False)
    game.players[1].chips = 0

    assert game.start_hand() is False
    assert game.phase == "showdown"


def test_showdown_does_not_reveal_folded_hands():
    # At showdown, to_dict used to reveal every player's hole cards, including
    # players who folded pre-flop — leaking real strategic information (what
    # an opponent folded) to anyone polling the state endpoint.
    game = PokerGame("g1")
    hero = game.add_player("Hero", is_human=True)
    villain = game.add_player("Villain", is_human=True)
    hero.hand = [Card(Suit.HEARTS, Rank.ACE), Card(Suit.HEARTS, Rank.KING)]
    villain.hand = [Card(Suit.CLUBS, Rank.TWO), Card(Suit.CLUBS, Rank.THREE)]
    villain.folded = True
    game.phase = "showdown"

    state = game.to_dict(for_player=hero.id)
    players_by_id = {p["id"]: p for p in state["players"]}

    assert players_by_id[hero.id]["hand"] != []
    assert players_by_id[villain.id]["hand"] == []


def test_buy_back_is_rejected_in_tournaments():
    # A busted tournament player must stay eliminated — buy-back is a cash-game
    # feature only. Without a tournament guard, a busted player could rebuy and
    # `tournament_standings()` would then list them twice (once as a survivor,
    # once in the eliminated tail), corrupting every rank below them.
    response = client.post(
        "/api/poker/games",
        json={"player_name": "Hero", "game_type": "tournament"},
    )
    assert response.status_code == 200
    data = response.json()
    game = poker.games[data["game_id"]]
    player = game._get_player(data["player_id"])
    player.chips = 0
    player.is_all_in = True
    game.phase = "showdown"

    response = client.post(
        f"/api/poker/games/{data['game_id']}/buy-back",
        json={"player_id": data["player_id"], "player_token": data["player_token"]},
    )

    assert response.status_code == 400
    assert game._get_player(data["player_id"]).chips == 0


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

    def fake_demo_answer(message, session_id=None, timezone_name=None, level=None):
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


def test_bitcoin_live_status_runs_blocking_provider_off_loop(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    auth_client = TestClient(app)
    auth_client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token("palmer", "secret"))
    calls = []

    async def fake_run_blocking(func, *args, **kwargs):
        calls.append((func.__name__, args, kwargs))
        return {"source": "node", "blocks": 840000}

    monkeypatch.setattr(bitcoin_router, "run_blocking", fake_run_blocking)

    response = auth_client.get("/api/bitcoin/status")

    assert response.status_code == 200
    assert response.json()["source"] == "node"
    assert calls == [("get_node_status", (), {})]


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


def test_bitcoin_chat_routes_explicit_block_questions_to_block_tools():
    current = bitcoin_ai.answer_demo_chat("what is the current block?", session_id="demo-session")
    numbered = bitcoin_ai.answer_demo_chat("what is block 800000?", session_id="demo-session")

    assert current["tools_used"] == ["get_latest_block"]
    assert numbered["tools_used"] == ["get_block"]
    assert numbered["data"]["height"] == 800000


def test_bitcoin_chat_keeps_mining_questions_on_conceptual_route():
    result = bitcoin_ai.answer_demo_chat(
        "How does mining work? Who adds new blocks?",
        session_id="demo-session",
    )

    assert result["tools_used"] == []
    assert result["answer"].startswith("**Mining**")


def test_stock_price_history_rejects_unbounded_day_ranges():
    response = client.get("/api/stocks/AAPL/prices", params={"days": 100000000})

    assert response.status_code == 422


def test_polygon_earnings_preserves_zero_values_and_fiscal_metadata():
    earnings = polygon_client._build_earnings_from_financials([
        {
            "filing_date": "2025-01-31",
            "fiscal_year": "2025",
            "fiscal_period": "Q4",
            "financials": {
                "income_statement": {
                    "revenues": {"value": 0},
                    "basic_earnings_per_share": {"value": 0},
                }
            },
        }
    ])

    assert earnings[0]["revenue"] == 0
    assert earnings[0]["reported_eps"] == 0
    assert earnings[0]["fiscal_year"] == "2025"
    assert earnings[0]["fiscal_quarter"] == "4"


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


def test_public_analytics_rejects_oversized_metadata():
    payload = {
        "event_type": "app_event",
        "event_name": "too_large",
        "app": "test",
        "path": "/test",
        "metadata": {"blob": "x" * 9000},
    }

    response = client.post("/api/analytics/events", json=payload)

    assert response.status_code == 422


def test_public_analytics_rejects_deep_metadata():
    payload = {
        "event_type": "app_event",
        "event_name": "too_deep",
        "app": "test",
        "path": "/test",
        "metadata": {"a": {"b": {"c": {"d": {"e": {"f": {"g": "too deep"}}}}}}},
    }

    response = client.post("/api/analytics/events", json=payload)

    assert response.status_code == 422


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


def test_analytics_summary_and_timeseries_use_sql_aggregation(monkeypatch):
    # analytics_summary/timeseries used to pull every row in the window into
    # Python and build several Counters/dict-buckets by hand. They were
    # rewritten to grouped SQL queries; this seeds a small, fully-determined
    # dataset and checks the aggregates come back exactly right.
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    auth_client = TestClient(app)
    auth_client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token("palmer", "secret"))

    db = SessionLocal()
    try:
        record_analytics_event(
            db, event_type="page_view", app="craps-strategy", path="/craps-strategy/",
            referrer="https://www.google.com/search?q=x", visitor_id="v1", session_id="s1",
        )
        record_analytics_event(
            db, event_type="page_view", app="craps-strategy", path="/craps-strategy/",
            referrer="https://www.google.com/search?q=y", visitor_id="v1", session_id="s1",
        )
        record_analytics_event(
            db, event_type="page_view", app="poker", path="/poker/",
            referrer="https://www.bing.com/search?q=z", visitor_id="v2", session_id="s2",
        )
        record_analytics_event(
            db, event_type="request", app="api:stocks", path="/api/stocks/AAPL",
            status_code=200, duration_ms=100, visitor_id="v1", session_id="s1",
        )
        record_analytics_event(
            db, event_type="request", app="api:stocks", path="/api/stocks/MSFT",
            status_code=500, duration_ms=300, visitor_id="v2", session_id="s2", is_admin=True,
        )
        record_analytics_event(
            db, event_type="request", app="api:craps", path="/api/craps/translate",
            status_code=404, duration_ms=200, visitor_id="v1", session_id="s1", is_authenticated=True,
        )
        record_analytics_event(
            db, event_type="app_event", app="craps", event_name="craps_strategy_simulated",
            visitor_id="v1", session_id="s1",
        )
        record_analytics_event(
            db, event_type="app_event", app="craps", event_name="craps_strategy_simulated",
            visitor_id="v2", session_id="s2",
        )
        record_analytics_event(
            db, event_type="app_event", app="blackjack", event_name="blackjack_win",
            visitor_id="v1", session_id="s1",
        )
    finally:
        db.close()

    summary = auth_client.get("/api/admin/analytics/summary").json()
    assert summary["total"] == 9
    assert summary["page_views"] == 3
    assert summary["requests"] == 3
    assert summary["app_events"] == 3
    assert summary["unique_visitors"] == 2
    assert summary["sessions"] == 2
    assert summary["success"] == 7
    assert summary["warning"] == 1
    assert summary["error"] == 1
    assert summary["authenticated"] == 1
    assert summary["admin"] == 1
    assert summary["public"] == 8
    assert summary["avg_duration_ms"] == 200.0

    def by_name(entries):
        return {entry["name"]: entry["count"] for entry in entries}

    assert by_name(summary["top_pages"]) == {"/craps-strategy/": 2, "/poker/": 1}
    assert by_name(summary["top_apps"]) == {
        "craps-strategy": 2, "poker": 1, "api:stocks": 2, "api:craps": 1, "craps": 2, "blackjack": 1,
    }
    assert by_name(summary["casino_app_events"]) == {"craps": 2, "blackjack": 1}
    assert by_name(summary["top_events"]) == {"craps_strategy_simulated": 2, "blackjack_win": 1}
    assert by_name(summary["top_referrers"]) == {"www.google.com": 2, "www.bing.com": 1}

    assert len(summary["recent_errors"]) == 1
    assert summary["recent_errors"][0]["path"] == "/api/stocks/MSFT"
    assert summary["recent_errors"][0]["status_code"] == 500

    timeseries = auth_client.get("/api/admin/analytics/timeseries").json()
    assert len(timeseries["points"]) == 1  # all seeded events land in the current hour
    point = timeseries["points"][0]
    assert point["success"] == 7
    assert point["warning"] == 1
    assert point["error"] == 1
    assert point["page_views"] == 3
    assert point["requests"] == 3
    assert point["timestamp"].endswith("Z")


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


def test_login_session_status_reports_signed_in_username(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    auth_client = TestClient(app)

    signed_out = auth_client.get("/login/session")
    assert signed_out.status_code == 200
    assert signed_out.json() == {"authenticated": False}
    assert signed_out.headers["cache-control"] == "no-store"

    login = auth_client.post(
        "/login/session",
        json={"username": "palmer", "password": "secret"},
    )
    assert login.status_code == 200
    assert login.json()["username"] == "palmer"

    signed_in = auth_client.get("/login/session")
    assert signed_in.status_code == 200
    assert signed_in.json() == {"authenticated": True, "username": "palmer"}

    logout = auth_client.post("/login/logout")
    assert logout.status_code == 200
    assert auth_client.get("/login/session").json() == {"authenticated": False}


def test_logout_rejects_get_and_only_clears_session_via_post():
    # A GET endpoint that clears the session cookie is a CSRF vector — any
    # third-party page can trigger it with a plain <img src="/login/logout">.
    # Nothing in the app ever links to it as a GET, so only POST should work.
    auth_client = TestClient(app, follow_redirects=False)
    auth_client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token("palmer", "secret"))

    get_response = auth_client.get("/login/logout")
    assert get_response.status_code == 405

    post_response = auth_client.post("/login/logout")
    assert post_response.status_code == 200
    assert f"{SESSION_COOKIE_NAME}=" in post_response.headers["set-cookie"]


def test_login_session_redirects_to_safe_next_path(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    auth_client = TestClient(app)

    response = auth_client.post(
        "/login/session",
        json={"username": "palmer", "password": "secret", "next": "/bitcoin-chat/?range=1m"},
    )

    assert response.status_code == 200
    assert response.json()["redirect"] == "/bitcoin-chat/?range=1m"


def test_safe_next_path_rejects_external_and_login_targets():
    assert safe_next_path("https://example.com/admin/") == "/"
    assert safe_next_path("//example.com/admin/") == "/"
    assert safe_next_path("/login/?next=/bitcoin-chat/") == "/"
    assert safe_next_path("/admin/?tab=logs#latest") == "/admin/?tab=logs#latest"


def test_safe_next_path_rejects_backslash_scheme_bypass():
    # urlsplit does not treat "\" as a path separator, but browsers do — so
    # "/\evil.com" parses with an empty netloc/scheme and a path starting
    # with "/" (passing urlsplit-based checks), yet window.location.assign()
    # navigates to https://evil.com. Reject any "next" containing a backslash.
    assert safe_next_path("/\\evil.com") == "/"
    assert safe_next_path("\\\\evil.com") == "/"
    assert safe_next_path("/admin/\\@evil.com") == "/"


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


def test_session_token_signed_with_dedicated_secret_not_password(monkeypatch):
    """A leaked session token must not be a verifiable oracle for the password."""
    from app.main import valid_app_session_cookie, session_signing_secret

    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    monkeypatch.setenv("APP_SESSION_SECRET", "an-independent-signing-secret")

    # Signing secret is decoupled from the password.
    assert session_signing_secret("secret") == "an-independent-signing-secret"

    token = create_app_session_token("palmer", "secret")
    auth_client = TestClient(app)
    auth_client.cookies.set(SESSION_COOKIE_NAME, token)
    assert auth_client.get("/api/unknown").status_code == 404

    # A token forged by signing with the password (the old scheme) is rejected
    # once a separate session secret is configured.
    from app.main import _base64url_encode, _session_signature
    import time as _time

    payload = _base64url_encode(
        json.dumps({"u": "palmer", "exp": int(_time.time()) + 3600}, separators=(",", ":")).encode()
    )
    forged = f"{payload}.{_session_signature('secret', payload)}"
    forged_client = TestClient(app)
    forged_client.cookies.set(SESSION_COOKIE_NAME, forged)
    assert forged_client.get("/api/unknown").status_code == 401


def test_csv_export_neutralizes_formula_injection():
    """Attacker-controlled fields must not execute as spreadsheet formulas."""
    from app.routers.admin import _csv_safe

    assert _csv_safe("=1+1") == "'=1+1"
    assert _csv_safe("+cmd") == "'+cmd"
    assert _csv_safe("-2") == "'-2"
    assert _csv_safe("@SUM(A1)") == "'@SUM(A1)"
    assert _csv_safe("\t=danger") == "'\t=danger"
    # Benign values pass through untouched.
    assert _csv_safe("/admin") == "/admin"
    assert _csv_safe("Mozilla/5.0") == "Mozilla/5.0"
    assert _csv_safe(200) == 200
    assert _csv_safe(None) is None


def test_client_ip_uses_rightmost_proxy_hop(monkeypatch):
    """Rate-limit keys must use the proxy-appended hop, not the spoofable left entry."""
    from app.main import client_ip
    import app.main as main_module

    monkeypatch.setattr(main_module, "TRUST_PROXY_HEADERS", True)
    monkeypatch.setattr(main_module, "TRUSTED_PROXY_HOPS", 1)

    class _Req:
        def __init__(self, xff):
            self.headers = {"x-forwarded-for": xff}
            self.client = None

    # Client forges a fake leftmost IP; we must read the trusted rightmost hop.
    assert client_ip(_Req("1.2.3.4, 9.9.9.9")) == "9.9.9.9"
    assert client_ip(_Req("203.0.113.7")) == "203.0.113.7"


def test_poker_rate_limit_uses_shared_rightmost_hop_helper(monkeypatch):
    # poker.py used to keep its own _client_ip that read the leftmost (client-
    # forgeable) X-Forwarded-For entry. An attacker could rotate a fake
    # leftmost IP on every request to spread load across buckets and dodge
    # the 60 req/min cap. It must key off the same trusted rightmost hop as
    # every other rate limiter in the app.
    import app.main as main_module

    monkeypatch.setattr(main_module, "TRUST_PROXY_HEADERS", True)
    monkeypatch.setattr(main_module, "TRUSTED_PROXY_HOPS", 1)
    poker._rate_limit_store.clear()

    last_status = None
    for i in range(poker._RATE_LIMIT_MAX + 1):
        response = client.post(
            "/api/poker/games",
            json={"player_name": "Spoofer", "game_type": "single"},
            headers={"X-Forwarded-For": f"10.0.0.{i}, 9.9.9.9"},
        )
        last_status = response.status_code

    # All requests shared one bucket (the real, rightmost hop "9.9.9.9")
    # despite a different forged leftmost entry every time, so the limit
    # still trips.
    assert last_status == 429
    assert list(poker._rate_limit_store.keys()) == ["9.9.9.9"]
