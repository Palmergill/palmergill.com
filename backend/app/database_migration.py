import re

from sqlalchemy import inspect, text
from app.database import engine, Base, is_postgres
import logging

logger = logging.getLogger(__name__)

_SAFE_IDENTIFIER = re.compile(r'^[a-zA-Z_][a-zA-Z0-9_]*$')


def _add_column_if_missing(inspector, table_name, column_name, definition):
    """Add one backwards-compatible column to an existing deployment."""
    if table_name not in inspector.get_table_names():
        return False
    existing = {column["name"] for column in inspector.get_columns(table_name)}
    if column_name in existing:
        return False
    if not _SAFE_IDENTIFIER.match(table_name) or not _SAFE_IDENTIFIER.match(column_name):
        raise ValueError(f"Unsafe migration identifier {table_name}.{column_name}")

    logger.info("Adding column %s to %s", column_name, table_name)
    with engine.begin() as conn:
        conn.execute(text(
            f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}"
        ))
    return True

def migrate_database():
    """Auto-migrate database schema without losing data"""
    try:
        inspector = inspect(engine)
        
        # Check if stock_summaries table exists
        if 'stock_summaries' in inspector.get_table_names():
            existing_columns = [col['name'] for col in inspector.get_columns('stock_summaries')]
            
            from app.database import StockSummary
            expected_columns = {col.name: col for col in StockSummary.__table__.columns}
            
            for col_name, column in expected_columns.items():
                if col_name not in existing_columns and col_name != 'id':
                    logger.info(f"Adding column {col_name} to stock_summaries")
                    try:
                        if not _SAFE_IDENTIFIER.match(col_name):
                            raise ValueError(f"Unsafe stock_summaries column name {col_name!r}")
                        col_type = column.type.compile(dialect=engine.dialect)

                        with engine.begin() as conn:
                            conn.execute(text(f"ALTER TABLE stock_summaries ADD COLUMN {col_name} {col_type}"))
                    except Exception:
                        logger.exception("Could not add required column %s", col_name)
                        raise
        
        if 'earnings' in inspector.get_table_names():
            existing_columns = [col['name'] for col in inspector.get_columns('earnings')]
            
            from app.database import EarningsRecord
            expected_columns = {col.name: col for col in EarningsRecord.__table__.columns}
            
            for col_name, column in expected_columns.items():
                if col_name not in existing_columns and col_name != 'id':
                    logger.info(f"Adding column {col_name} to earnings")
                    try:
                        if not _SAFE_IDENTIFIER.match(col_name):
                            raise ValueError(f"Unsafe earnings column name {col_name!r}")
                        col_type = column.type.compile(dialect=engine.dialect)

                        with engine.begin() as conn:
                            conn.execute(text(f"ALTER TABLE earnings ADD COLUMN {col_name} {col_type}"))
                    except Exception:
                        logger.exception("Could not add required column %s", col_name)
                        raise

        # Fourth & Fortune existed before practice/test modes. These defaults
        # preserve every existing room and player as a real league participant.
        _add_column_if_missing(
            inspector,
            "ff_draft_sessions",
            "mode",
            "VARCHAR NOT NULL DEFAULT 'league'",
        )
        _add_column_if_missing(
            inspector,
            "ff_draft_players",
            "is_bot",
            "BOOLEAN NOT NULL DEFAULT FALSE" if is_postgres else "BOOLEAN NOT NULL DEFAULT 0",
        )
        revealed_at_added = _add_column_if_missing(
            inspector,
            "ff_draft_sessions",
            "revealed_at",
            "TIMESTAMP" if is_postgres else "DATETIME",
        )
        if revealed_at_added:
            # Rooms completed before synchronized reveals existed have already
            # shown their results, so preserve them as revealed history.
            with engine.begin() as conn:
                conn.execute(text(
                    "UPDATE ff_draft_sessions "
                    "SET revealed_at = completed_at "
                    "WHERE state = 'complete'"
                ))

        # Turns used to advance inside the same transaction that ended them, so
        # a spectator's poll never saw the card that busted or banked a round.
        # 'playing' is the correct default for every in-flight room: nothing is
        # being held, which is exactly how they behaved before.
        _add_column_if_missing(
            inspector,
            "ff_draft_sessions",
            "turn_state",
            "VARCHAR NOT NULL DEFAULT 'playing'",
        )
        _add_column_if_missing(
            inspector,
            "ff_draft_sessions",
            "resolved_at",
            "TIMESTAMP" if is_postgres else "DATETIME",
        )
        _add_column_if_missing(
            inspector,
            "ff_draft_sessions",
            "last_event_json",
            "TEXT",
        )
        # The host's skip used to be available the moment a turn opened. NULL is
        # the right value for rooms already in flight: an unknown turn start
        # reads as "long enough ago", which is how those rooms behaved.
        _add_column_if_missing(
            inspector,
            "ff_draft_sessions",
            "turn_started_at",
            "TIMESTAMP" if is_postgres else "DATETIME",
        )

        # Version 1 consumed one personal deck across the whole game. Preserve
        # rooms that may already contain cards under those committed rules, but
        # move untouched lobbies to version 2 so they start with a fresh deck
        # for every round when their host locks the roster.
        _add_column_if_missing(
            inspector,
            "ff_draft_sessions",
            "game_version",
            "VARCHAR NOT NULL DEFAULT 'fourth-and-fortune-v1'",
        )
        # Season prop rows used to carry only the fetch time. NULL is right
        # for every row already stored: those runs never recorded when the
        # market itself last moved, and guessing it from the fetch time is the
        # exact overstatement the column exists to correct.
        _add_column_if_missing(
            inspector,
            "ff_season_prop_snapshots",
            "quoted_at",
            "TIMESTAMP" if is_postgres else "DATETIME",
        )

        refreshed = inspect(engine)
        if (
            "ff_draft_sessions" in refreshed.get_table_names()
            and "game_version" in {
                column["name"] for column in refreshed.get_columns("ff_draft_sessions")
            }
        ):
            with engine.begin() as conn:
                conn.execute(text(
                    "UPDATE ff_draft_sessions "
                    "SET game_version = 'fourth-and-fortune-v2' "
                    "WHERE state = 'lobby'"
                ))

        logger.info("Database migration complete")
        
    except Exception:
        logger.exception("Migration failed")
        raise

def init_db_with_migration():
    """Initialize DB with auto-migration"""
    # First create all tables if they don't exist
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables created (if not existed)")
    
    # Then run migrations for existing tables. A partially migrated schema is
    # not safe to serve, so failures must abort startup and fail readiness.
    migrate_database()
