"""
Database logging handler.

Captures Python `logging` records and persists them to the `logs` table so
the admin page can display structured logs alongside the file-based logs.
"""
import logging
from datetime import datetime

from app.database import SessionLocal, LogEntry

# Logger names we never want to persist (would create infinite loops or noise)
_EXCLUDED_LOGGERS = {
    "sqlalchemy.engine",
    "sqlalchemy.engine.Engine",
    "sqlalchemy.pool",
    "sqlalchemy.dialects",
    "sqlalchemy.orm",
}


class DatabaseLogHandler(logging.Handler):
    """A logging.Handler that writes records to the LogEntry table."""

    def emit(self, record: logging.LogRecord) -> None:
        # Avoid recursive logging from SQLAlchemy itself
        if record.name in _EXCLUDED_LOGGERS or record.name.startswith("sqlalchemy"):
            return

        try:
            session = SessionLocal()
            try:
                entry = LogEntry(
                    timestamp=datetime.utcfromtimestamp(record.created),
                    level=record.levelname,
                    logger_name=record.name,
                    message=self.format(record),
                    path=getattr(record, "path", None),
                    status_code=getattr(record, "status_code", None),
                    method=getattr(record, "method", None),
                )
                session.add(entry)
                session.commit()
            finally:
                session.close()
        except Exception:
            # Never let logging itself crash the app
            self.handleError(record)


def install_db_logging(level: int = logging.INFO) -> None:
    """Attach the DB handler to the root logger and uvicorn loggers."""
    handler = DatabaseLogHandler(level=level)
    handler.setFormatter(logging.Formatter("%(message)s"))

    root = logging.getLogger()
    # Avoid attaching twice if reload occurs
    if not any(isinstance(h, DatabaseLogHandler) for h in root.handlers):
        root.addHandler(handler)
        if root.level == logging.NOTSET or root.level > level:
            root.setLevel(level)

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "fastapi"):
        lg = logging.getLogger(name)
        if not any(isinstance(h, DatabaseLogHandler) for h in lg.handlers):
            lg.addHandler(handler)
