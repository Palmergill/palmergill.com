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


def _is_excluded_record(record: logging.LogRecord) -> bool:
    """Skip recursive/noisy records that are not useful in the admin log view."""
    if record.name in _EXCLUDED_LOGGERS or record.name.startswith("sqlalchemy"):
        return True

    if record.name == "uvicorn.access":
        path = getattr(record, "path", None)
        if path and str(path).startswith("/api/admin/logs"):
            return True

        # Uvicorn access records include the request path in args. Fall back to
        # the formatted message for compatibility with alternate access formats.
        args = record.args if isinstance(record.args, tuple) else ()
        if any(str(arg).startswith("/api/admin/logs") for arg in args):
            return True

        message = record.getMessage()
        if ' /api/admin/logs' in message or '"GET /api/admin/logs' in message:
            return True

    return False


class DatabaseLogHandler(logging.Handler):
    """A logging.Handler that writes records to the LogEntry table."""

    def emit(self, record: logging.LogRecord) -> None:
        if _is_excluded_record(record):
            return
        if getattr(record, "_db_log_persisted", False):
            return
        record._db_log_persisted = True

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
    """Attach one DB handler where app and server logs are emitted."""
    root = logging.getLogger()
    handler = next((h for h in root.handlers if isinstance(h, DatabaseLogHandler)), None)

    # Avoid attaching twice if reload occurs
    if handler is None:
        handler = DatabaseLogHandler(level=level)
        handler.setFormatter(logging.Formatter("%(message)s"))
        root.addHandler(handler)

    if root.level == logging.NOTSET or root.level > level:
        root.setLevel(level)

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "fastapi"):
        logger = logging.getLogger(name)
        if not any(isinstance(h, DatabaseLogHandler) for h in logger.handlers):
            logger.addHandler(handler)
