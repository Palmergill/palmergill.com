"""Backwards-compatible schema changes for persistent deployments."""

from sqlalchemy import create_engine, inspect, text

from app import database_migration


def test_draft_room_modes_are_added_to_an_existing_database(monkeypatch):
    legacy_engine = create_engine("sqlite:///:memory:")
    with legacy_engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE ff_draft_sessions ("
            "id VARCHAR PRIMARY KEY, state VARCHAR, completed_at DATETIME)"
        ))
        connection.execute(text(
            "CREATE TABLE ff_draft_players (id VARCHAR PRIMARY KEY, session_id VARCHAR)"
        ))
        connection.execute(text(
            "INSERT INTO ff_draft_sessions (id, state, completed_at) "
            "VALUES ('room-1', 'complete', '2026-08-01 12:00:00'), "
            "('room-2', 'lobby', NULL)"
        ))
        connection.execute(text(
            "INSERT INTO ff_draft_players (id, session_id) VALUES ('player-1', 'room-1')"
        ))

    monkeypatch.setattr(database_migration, "engine", legacy_engine)
    monkeypatch.setattr(database_migration, "is_postgres", False)
    database_migration.migrate_database()

    inspector = inspect(legacy_engine)
    session_columns = {column["name"] for column in inspector.get_columns("ff_draft_sessions")}
    player_columns = {column["name"] for column in inspector.get_columns("ff_draft_players")}
    assert "mode" in session_columns
    assert "revealed_at" in session_columns
    assert "is_bot" in player_columns
    assert "turn_state" in session_columns
    assert "resolved_at" in session_columns
    assert "last_event_json" in session_columns
    assert "game_version" in session_columns

    with legacy_engine.connect() as connection:
        assert connection.execute(text(
            "SELECT mode FROM ff_draft_sessions WHERE id = 'room-1'"
        )).scalar_one() == "league"
        assert connection.execute(text(
            "SELECT is_bot FROM ff_draft_players WHERE id = 'player-1'"
        )).scalar_one() == 0
        assert connection.execute(text(
            "SELECT revealed_at FROM ff_draft_sessions WHERE id = 'room-1'"
        )).scalar_one() is not None
        # Rooms mid-draft when this shipped are holding nothing, which is
        # exactly how they behaved before the turn could be held at all.
        assert connection.execute(text(
            "SELECT turn_state FROM ff_draft_sessions WHERE id = 'room-1'"
        )).scalar_one() == "playing"
        # Dealt/completed rooms retain their old proof rules. An untouched
        # lobby can safely adopt fresh per-round decks before it starts.
        assert connection.execute(text(
            "SELECT game_version FROM ff_draft_sessions WHERE id = 'room-1'"
        )).scalar_one() == "fourth-and-fortune-v1"
        assert connection.execute(text(
            "SELECT game_version FROM ff_draft_sessions WHERE id = 'room-2'"
        )).scalar_one() == "fourth-and-fortune-v2"
