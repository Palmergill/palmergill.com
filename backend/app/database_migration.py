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
        logger.warning("Skipping unsafe migration identifier %s.%s", table_name, column_name)
        return False

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
            expected_columns = [col.name for col in StockSummary.__table__.columns]
            
            for col_name in expected_columns:
                if col_name not in existing_columns and col_name != 'id':
                    logger.info(f"Adding column {col_name} to stock_summaries")
                    try:
                        if not _SAFE_IDENTIFIER.match(col_name):
                            logger.warning(f"Skipping column with invalid name: {col_name!r}")
                            continue
                        col_type = "FLOAT"
                        if col_name in ['ticker', 'name']:
                            col_type = "VARCHAR"
                        elif col_name in ['next_earnings_date']:
                            col_type = "DATE"
                        elif col_name in ['fetched_at']:
                            col_type = "TIMESTAMP" if is_postgres else "DATETIME"

                        with engine.connect() as conn:
                            conn.execute(text(f"ALTER TABLE stock_summaries ADD COLUMN {col_name} {col_type}"))
                            conn.commit()
                    except Exception as e:
                        logger.warning(f"Could not add column {col_name}: {e}")
        
        if 'earnings' in inspector.get_table_names():
            existing_columns = [col['name'] for col in inspector.get_columns('earnings')]
            
            from app.database import EarningsRecord
            expected_columns = [col.name for col in EarningsRecord.__table__.columns]
            
            for col_name in expected_columns:
                if col_name not in existing_columns and col_name != 'id':
                    logger.info(f"Adding column {col_name} to earnings")
                    try:
                        if not _SAFE_IDENTIFIER.match(col_name):
                            logger.warning(f"Skipping column with invalid name: {col_name!r}")
                            continue
                        col_type = "FLOAT"
                        if col_name in ['ticker', 'name', 'period']:
                            col_type = "VARCHAR"
                        elif col_name in ['fiscal_date', 'fetched_at']:
                            col_type = "TIMESTAMP" if is_postgres else "DATETIME"

                        with engine.connect() as conn:
                            conn.execute(text(f"ALTER TABLE earnings ADD COLUMN {col_name} {col_type}"))
                            conn.commit()
                    except Exception as e:
                        logger.warning(f"Could not add column {col_name}: {e}")

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
        
        logger.info("Database migration complete")
        
    except Exception as e:
        logger.error(f"Migration error: {e}")

def init_db_with_migration():
    """Initialize DB with auto-migration"""
    # First create all tables if they don't exist
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables created (if not existed)")
    
    # Then run migrations for existing tables
    try:
        migrate_database()
    except Exception as e:
        logger.warning(f"Migration step failed (may be OK for fresh DB): {e}")
