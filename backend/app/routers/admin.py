"""
Admin API router - exposes log data for the admin dashboard.

Endpoints are mounted under /api/admin and protected by the same Basic Auth
middleware that protects /api/*.
"""
from __future__ import annotations

import os
import csv
import io
from collections import Counter
from datetime import datetime, timedelta
from urllib.parse import urlparse
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session
from sqlalchemy import case, desc, func, or_

from app.database import AnalyticsEvent, LogEntry, get_db, is_postgres, utc_now
from app.routers.analytics import RETENTION_DAYS, cleanup_old_analytics, classify_outcome

router = APIRouter(prefix="/api/admin", tags=["admin"])


# Path to backend.log relative to the repository root (../../logs/backend.log
# from this file -> backend/app/routers/admin.py).
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_THIS_DIR, "..", "..", ".."))
LOG_FILE_PATH = os.path.join(_REPO_ROOT, "logs", "backend.log")


class LogEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    timestamp: str
    level: str
    logger_name: Optional[str] = None
    message: str
    path: Optional[str] = None
    status_code: Optional[int] = None
    method: Optional[str] = None


class LogsResponse(BaseModel):
    entries: List[LogEntryOut]
    total: int


class FileLogResponse(BaseModel):
    lines: List[str]
    path: str
    truncated: bool


class LogSummaryResponse(BaseModel):
    success: int
    warning: int
    error: int
    total: int


class AnalyticsEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    timestamp: str
    event_type: str
    event_name: Optional[str] = None
    app: Optional[str] = None
    path: Optional[str] = None
    method: Optional[str] = None
    status_code: Optional[int] = None
    outcome: Optional[str] = None
    referrer: Optional[str] = None
    user_agent: Optional[str] = None
    ip_address: Optional[str] = None
    visitor_id: Optional[str] = None
    session_id: Optional[str] = None
    is_authenticated: bool = False
    is_admin: bool = False
    username: Optional[str] = None
    duration_ms: Optional[float] = None
    metadata_json: Optional[str] = None


class AnalyticsEventsResponse(BaseModel):
    entries: List[AnalyticsEventOut]
    total: int


class RetentionResponse(BaseModel):
    retention_days: int
    analytics_total: int
    logs_total: int
    analytics_expired: int
    logs_expired: int


def _cutoff(hours: int):
    return utc_now() - timedelta(hours=hours)


def _iso(value):
    if not value:
        return ""
    # Stored timestamps come from utc_now() which is naive UTC. Append 'Z'
    # so the admin frontend's `new Date(value)` parses them as UTC instead
    # of local time.
    text = value.isoformat()
    if getattr(value, "tzinfo", None) is None:
        return f"{text}Z"
    return text


def _top(counter: Counter, limit: int = 8):
    return [{"name": str(name or "(unknown)"), "count": count} for name, count in counter.most_common(limit)]


def _referrer_host(referrer: str | None) -> str:
    if not referrer:
        return "direct"
    try:
        parsed = urlparse(referrer)
        return parsed.netloc or referrer
    except ValueError:
        return referrer


def _csv_safe(value):
    """Neutralize CSV/spreadsheet formula injection.

    Fields like user_agent, referrer and event_name are attacker-controllable
    (any anonymous visitor can set them via POST /api/analytics/events). A value
    beginning with =, +, -, @, or a leading tab/CR is treated as a formula by
    Excel/Sheets, so prefix those with a single quote to force literal text.
    """
    if isinstance(value, str) and value and value[0] in ("=", "+", "-", "@", "\t", "\r"):
        return f"'{value}"
    return value


def _csv_response(filename: str, headers: list[str], rows) -> StreamingResponse:
    """Stream CSV rows row-by-row so we never materialize the full payload.

    `rows` may be a list or any iterable / generator. Each yielded chunk is one
    encoded CSV line — the StringIO buffer is reused after each emit.
    """

    def generate():
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(headers)
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate()
        for row in rows:
            writer.writerow([_csv_safe(cell) for cell in row])
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate()

    return StreamingResponse(
        generate(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _analytics_out(row: AnalyticsEvent) -> AnalyticsEventOut:
    return AnalyticsEventOut(
        id=row.id,
        timestamp=_iso(row.timestamp),
        event_type=row.event_type,
        event_name=row.event_name,
        app=row.app,
        path=row.path,
        method=row.method,
        status_code=row.status_code,
        outcome=row.outcome,
        referrer=row.referrer,
        user_agent=row.user_agent,
        ip_address=row.ip_address,
        visitor_id=row.visitor_id,
        session_id=row.session_id,
        is_authenticated=bool(row.is_authenticated),
        is_admin=bool(row.is_admin),
        username=row.username,
        duration_ms=row.duration_ms,
        metadata_json=row.metadata_json,
    )


def cleanup_old_logs(db: Session, days: int = RETENTION_DAYS) -> int:
    cutoff = utc_now() - timedelta(days=days)
    deleted = db.query(LogEntry).filter(LogEntry.timestamp < cutoff).delete()
    db.commit()
    return deleted


def _apply_log_filters(query, level=None, outcome=None, q=None, after_id=None):
    if level:
        query = query.filter(LogEntry.level == level.upper())
    if outcome:
        outcome = outcome.lower()
        if outcome == "success":
            query = query.filter(LogEntry.level.notin_(["WARNING", "ERROR", "CRITICAL"]))
            query = query.filter((LogEntry.status_code == None) | (LogEntry.status_code < 400))  # noqa: E711
        elif outcome == "warning":
            query = query.filter(
                (LogEntry.level == "WARNING")
                | ((LogEntry.status_code >= 400) & (LogEntry.status_code < 500))
            )
        elif outcome == "error":
            query = query.filter(
                LogEntry.level.in_(["ERROR", "CRITICAL"])
                | (LogEntry.status_code >= 500)
            )
    if q:
        like = f"%{q}%"
        query = query.filter(
            or_(
                LogEntry.message.ilike(like),
                LogEntry.path.ilike(like),
                LogEntry.logger_name.ilike(like),
                LogEntry.method.ilike(like),
            )
        )
    if after_id is not None:
        query = query.filter(LogEntry.id > after_id)
    return query


def _apply_analytics_filters(query, hours=24, event_type=None, app=None, outcome=None, q=None):
    query = query.filter(AnalyticsEvent.timestamp >= _cutoff(hours))
    if event_type:
        query = query.filter(AnalyticsEvent.event_type == event_type)
    if app:
        query = query.filter(AnalyticsEvent.app == app)
    if outcome:
        query = query.filter(AnalyticsEvent.outcome == outcome)
    if q:
        like = f"%{q}%"
        query = query.filter(
            AnalyticsEvent.path.ilike(like)
            | AnalyticsEvent.event_name.ilike(like)
            | AnalyticsEvent.referrer.ilike(like)
        )
    return query


@router.get("/logs", response_model=LogsResponse)
def list_logs(
    level: Optional[str] = Query(None, description="Filter by level: DEBUG/INFO/WARNING/ERROR"),
    outcome: Optional[str] = Query(None, description="Filter by outcome: success/warning/error"),
    q: Optional[str] = Query(None, description="Substring search across message"),
    limit: int = Query(200, ge=1, le=5000),
    after_id: Optional[int] = Query(None, description="Only return entries with id > after_id (for live tail)"),
    db: Session = Depends(get_db),
):
    """Return structured log entries from the database, newest first."""
    query = _apply_log_filters(db.query(LogEntry), level, outcome, q, after_id)

    total = query.count()
    rows = query.order_by(desc(LogEntry.id)).limit(limit).all()

    entries = [
        LogEntryOut(
            id=r.id,
            timestamp=r.timestamp.isoformat() if r.timestamp else "",
            level=r.level or "",
            logger_name=r.logger_name,
            message=r.message or "",
            path=r.path,
            status_code=r.status_code,
            method=r.method,
        )
        for r in rows
    ]
    return LogsResponse(entries=entries, total=total)


@router.get("/logs/export")
def export_logs(
    level: Optional[str] = Query(None),
    outcome: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    limit: int = Query(5000, ge=1, le=5000),
    db: Session = Depends(get_db),
):
    query = _apply_log_filters(db.query(LogEntry), level, outcome, q)
    rows = query.order_by(desc(LogEntry.id)).limit(limit).all()
    return _csv_response(
        "admin-logs.csv",
        ["id", "timestamp", "level", "logger", "method", "path", "status_code", "message"],
        [
            [
                row.id,
                _iso(row.timestamp),
                row.level,
                row.logger_name,
                row.method,
                row.path,
                row.status_code,
                row.message,
            ]
            for row in rows
        ],
    )


@router.get("/logs/summary", response_model=LogSummaryResponse)
def summarize_logs(
    hours: int = Query(24, ge=1, le=2160),
    db: Session = Depends(get_db),
):
    """Return condensed success/warning/error log counts."""
    rows = db.query(LogEntry).filter(LogEntry.timestamp >= _cutoff(hours)).all()
    counts = Counter()
    for row in rows:
        counts[classify_outcome(row.status_code, row.level)] += 1

    return LogSummaryResponse(
        success=counts["success"],
        warning=counts["warning"],
        error=counts["error"],
        total=sum(counts.values()),
    )


@router.delete("/logs")
def clear_logs(db: Session = Depends(get_db)):
    """Delete all stored log entries."""
    deleted = db.query(LogEntry).delete()
    db.commit()
    return {"deleted": deleted}


@router.delete("/logs/retention")
def prune_logs(db: Session = Depends(get_db)):
    deleted = cleanup_old_logs(db)
    return {"deleted": deleted, "retention_days": RETENTION_DAYS}


@router.get("/logs/file", response_model=FileLogResponse)
def read_log_file(
    lines: int = Query(500, ge=1, le=5000, description="Number of trailing lines to return"),
):
    """Return the last N lines of the file-based backend.log."""
    if not os.path.exists(LOG_FILE_PATH):
        return FileLogResponse(lines=[], path=LOG_FILE_PATH, truncated=False)

    try:
        with open(LOG_FILE_PATH, "rb") as f:
            # Seek-based tail to avoid loading huge files
            f.seek(0, os.SEEK_END)
            size = f.tell()
            block = 8192
            data = b""
            while size > 0 and data.count(b"\n") <= lines:
                read = min(block, size)
                size -= read
                f.seek(size)
                data = f.read(read) + data
            text = data.decode("utf-8", errors="replace")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not read log file: {e}")

    all_lines = text.splitlines()
    truncated = len(all_lines) > lines
    return FileLogResponse(
        lines=all_lines[-lines:],
        path=LOG_FILE_PATH,
        truncated=truncated,
    )


def _grouped_top(db: Session, column, cutoff, *extra_filters, limit: int = 8):
    """SELECT column, COUNT(*) ... GROUP BY column ORDER BY COUNT(*) DESC LIMIT.

    Lets the database do the counting and top-N cutoff instead of pulling
    every row of the window into Python to build a Counter over it.
    """
    rows = (
        db.query(column, func.count())
        .filter(AnalyticsEvent.timestamp >= cutoff, *extra_filters)
        .group_by(column)
        .order_by(desc(func.count()))
        .limit(limit)
        .all()
    )
    return [{"name": name, "count": count} for name, count in rows]


@router.get("/analytics/summary")
def analytics_summary(
    hours: int = Query(24, ge=1, le=2160),
    db: Session = Depends(get_db),
):
    """Return dashboard-ready analytics aggregates.

    Each aggregate is its own indexed GROUP BY / COUNT query rather than one
    `.all()` that pulls the whole window's rows into Python and scans them
    ~8 times to build Counters — the row count here is unbounded by traffic,
    while every query below returns at most a handful of rows.
    """
    cutoff = _cutoff(hours)
    window_filter = AnalyticsEvent.timestamp >= cutoff

    total = db.query(func.count()).filter(window_filter).scalar() or 0
    authenticated = (
        db.query(func.count()).filter(window_filter, AnalyticsEvent.is_authenticated.is_(True)).scalar() or 0
    )
    admin_count = db.query(func.count()).filter(window_filter, AnalyticsEvent.is_admin.is_(True)).scalar() or 0

    event_type_counts = dict(
        db.query(func.coalesce(AnalyticsEvent.event_type, "unknown"), func.count())
        .filter(window_filter)
        .group_by(func.coalesce(AnalyticsEvent.event_type, "unknown"))
        .all()
    )
    outcome_counts = dict(
        db.query(func.coalesce(AnalyticsEvent.outcome, "success"), func.count())
        .filter(window_filter)
        .group_by(func.coalesce(AnalyticsEvent.outcome, "success"))
        .all()
    )

    unique_visitors = (
        db.query(func.count(func.distinct(AnalyticsEvent.visitor_id)))
        .filter(window_filter, AnalyticsEvent.visitor_id.isnot(None), AnalyticsEvent.visitor_id != "")
        .scalar()
        or 0
    )
    unique_sessions = (
        db.query(func.count(func.distinct(AnalyticsEvent.session_id)))
        .filter(window_filter, AnalyticsEvent.session_id.isnot(None), AnalyticsEvent.session_id != "")
        .scalar()
        or 0
    )

    avg_duration_ms = (
        db.query(func.avg(AnalyticsEvent.duration_ms))
        .filter(window_filter, AnalyticsEvent.event_type == "request", AnalyticsEvent.duration_ms.isnot(None))
        .scalar()
        or 0
    )

    top_pages = _grouped_top(
        db,
        AnalyticsEvent.path,
        cutoff,
        AnalyticsEvent.event_type == "page_view",
        AnalyticsEvent.path.isnot(None),
        AnalyticsEvent.path != "",
    )
    top_apps = _grouped_top(
        db, AnalyticsEvent.app, cutoff, AnalyticsEvent.app.isnot(None), AnalyticsEvent.app != ""
    )
    casino_app_events = _grouped_top(
        db,
        AnalyticsEvent.app,
        cutoff,
        AnalyticsEvent.event_type == "app_event",
        AnalyticsEvent.app.in_(["poker", "craps", "blackjack"]),
    )
    top_events = _grouped_top(
        db,
        AnalyticsEvent.event_name,
        cutoff,
        AnalyticsEvent.event_type == "app_event",
        AnalyticsEvent.event_name.isnot(None),
        AnalyticsEvent.event_name != "",
    )

    # Referrer hostnames need Python-side URL parsing (_referrer_host), so
    # this one still leaves the database as raw values — but only the single
    # `referrer` column for page views, not full rows for the whole window.
    referrer_values = [
        row[0]
        for row in db.query(AnalyticsEvent.referrer)
        .filter(window_filter, AnalyticsEvent.event_type == "page_view")
        .all()
    ]
    top_referrers = _top(Counter(_referrer_host(value) for value in referrer_values))

    recent_error_rows = (
        db.query(AnalyticsEvent)
        .filter(window_filter, AnalyticsEvent.outcome == "error")
        .order_by(desc(AnalyticsEvent.timestamp))
        .limit(8)
        .all()
    )
    recent_errors = [
        {
            "id": row.id,
            "timestamp": _iso(row.timestamp),
            "app": row.app,
            "path": row.path,
            "event_name": row.event_name,
            "status_code": row.status_code,
            "duration_ms": row.duration_ms,
        }
        for row in recent_error_rows
    ]

    return {
        "window_hours": hours,
        "total": total,
        "page_views": event_type_counts.get("page_view", 0),
        "requests": event_type_counts.get("request", 0),
        "app_events": event_type_counts.get("app_event", 0),
        "unique_visitors": unique_visitors,
        "sessions": unique_sessions,
        "success": outcome_counts.get("success", 0),
        "warning": outcome_counts.get("warning", 0),
        "error": outcome_counts.get("error", 0),
        "authenticated": authenticated,
        "public": total - authenticated,
        "admin": admin_count,
        "avg_duration_ms": round(avg_duration_ms, 1),
        "top_pages": top_pages,
        "top_apps": top_apps,
        "casino_app_events": casino_app_events,
        "top_events": top_events,
        "top_referrers": top_referrers,
        "recent_errors": recent_errors,
    }


def _hour_bucket_expr():
    """An hour-truncated expression over AnalyticsEvent.timestamp.

    SQLite and Postgres have no shared date-trunc function, so this branches
    once on the configured dialect (mirroring the same is_postgres branch
    already used for column types in database_migration.py).
    """
    if is_postgres:
        return func.date_trunc("hour", AnalyticsEvent.timestamp)
    return func.strftime("%Y-%m-%d %H:00:00", AnalyticsEvent.timestamp)


def _parse_hour_bucket(value):
    if isinstance(value, str):
        return datetime.strptime(value, "%Y-%m-%d %H:00:00")
    return value.replace(minute=0, second=0, microsecond=0, tzinfo=None)


@router.get("/analytics/timeseries")
def analytics_timeseries(
    hours: int = Query(24, ge=1, le=2160),
    db: Session = Depends(get_db),
):
    """Return hourly success/warning/error buckets for the selected window.

    A single grouped query does the hourly bucketing and conditional counts
    in the database, returning one row per hour instead of pulling every
    event row in the window into Python to bucket by hand.
    """
    cutoff = _cutoff(hours)
    bucket = _hour_bucket_expr()
    outcome = func.coalesce(AnalyticsEvent.outcome, "success")

    def count_when(condition):
        return func.sum(case((condition, 1), else_=0))

    rows = (
        db.query(
            bucket.label("bucket"),
            count_when(outcome == "success"),
            count_when(outcome == "warning"),
            count_when(outcome == "error"),
            count_when(AnalyticsEvent.event_type == "page_view"),
            count_when(AnalyticsEvent.event_type == "request"),
        )
        .filter(AnalyticsEvent.timestamp >= cutoff)
        .group_by(bucket)
        .order_by(bucket)
        .all()
    )

    return {
        "points": [
            {
                "timestamp": _iso(_parse_hour_bucket(bucket_value)),
                "success": success or 0,
                "warning": warning or 0,
                "error": error or 0,
                "page_views": page_views or 0,
                "requests": requests or 0,
            }
            for bucket_value, success, warning, error, page_views, requests in rows
        ]
    }


@router.get("/analytics/events", response_model=AnalyticsEventsResponse)
def list_analytics_events(
    event_type: Optional[str] = Query(None),
    app: Optional[str] = Query(None),
    outcome: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    hours: int = Query(24, ge=1, le=2160),
    limit: int = Query(200, ge=1, le=5000),
    db: Session = Depends(get_db),
):
    query = _apply_analytics_filters(db.query(AnalyticsEvent), hours, event_type, app, outcome, q)
    total = query.count()
    rows = query.order_by(desc(AnalyticsEvent.id)).limit(limit).all()
    return AnalyticsEventsResponse(
        total=total,
        entries=[_analytics_out(row) for row in rows],
    )


@router.get("/analytics/export")
def export_analytics_events(
    event_type: Optional[str] = Query(None),
    app: Optional[str] = Query(None),
    outcome: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    hours: int = Query(24, ge=1, le=2160),
    limit: int = Query(5000, ge=1, le=5000),
    db: Session = Depends(get_db),
):
    query = _apply_analytics_filters(db.query(AnalyticsEvent), hours, event_type, app, outcome, q)
    rows = query.order_by(desc(AnalyticsEvent.id)).limit(limit).all()
    return _csv_response(
        "analytics-events.csv",
        [
            "id", "timestamp", "type", "event", "app", "method", "path", "status_code",
            "outcome", "duration_ms", "admin", "authenticated", "username", "visitor_id",
            "session_id", "ip_address", "referrer", "user_agent", "metadata_json",
        ],
        [
            [
                row.id,
                _iso(row.timestamp),
                row.event_type,
                row.event_name,
                row.app,
                row.method,
                row.path,
                row.status_code,
                row.outcome,
                row.duration_ms,
                row.is_admin,
                row.is_authenticated,
                row.username,
                row.visitor_id,
                row.session_id,
                row.ip_address,
                row.referrer,
                row.user_agent,
                row.metadata_json,
            ]
            for row in rows
        ],
    )


@router.get("/analytics/slow")
def slow_analytics_events(
    hours: int = Query(24, ge=1, le=2160),
    limit: int = Query(8, ge=1, le=50),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(AnalyticsEvent)
        .filter(AnalyticsEvent.timestamp >= _cutoff(hours))
        .filter(AnalyticsEvent.duration_ms != None)  # noqa: E711
        .order_by(desc(AnalyticsEvent.duration_ms))
        .limit(limit)
        .all()
    )
    return {"entries": [_analytics_out(row) for row in rows]}


@router.get("/analytics/error-groups")
def analytics_error_groups(
    hours: int = Query(24, ge=1, le=2160),
    limit: int = Query(8, ge=1, le=50),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(AnalyticsEvent)
        .filter(AnalyticsEvent.timestamp >= _cutoff(hours))
        .filter(AnalyticsEvent.outcome == "error")
        .all()
    )
    groups = {}
    for row in rows:
        key = (row.app or "", row.path or "", row.event_name or "", row.status_code or "")
        group = groups.setdefault(
            key,
            {
                "app": row.app,
                "path": row.path,
                "event_name": row.event_name,
                "status_code": row.status_code,
                "count": 0,
                "last_seen": _iso(row.timestamp),
                "sample_id": row.id,
            },
        )
        group["count"] += 1
        if row.timestamp and _iso(row.timestamp) >= group["last_seen"]:
            group["last_seen"] = _iso(row.timestamp)
            group["sample_id"] = row.id

    return {
        "groups": sorted(groups.values(), key=lambda item: (item["count"], item["last_seen"]), reverse=True)[:limit]
    }


@router.get("/analytics/apps")
def analytics_apps(
    hours: int = Query(24, ge=1, le=2160),
    db: Session = Depends(get_db),
):
    rows = db.query(AnalyticsEvent.app).filter(AnalyticsEvent.timestamp >= _cutoff(hours)).distinct().all()
    return {"apps": sorted(row[0] for row in rows if row[0])}


@router.delete("/analytics/retention")
def prune_analytics(db: Session = Depends(get_db)):
    deleted = cleanup_old_analytics(db)
    return {"deleted": deleted, "retention_days": RETENTION_DAYS}


@router.get("/retention", response_model=RetentionResponse)
def retention_status(db: Session = Depends(get_db)):
    cutoff = utc_now() - timedelta(days=RETENTION_DAYS)
    analytics_total = db.query(AnalyticsEvent).count()
    logs_total = db.query(LogEntry).count()
    analytics_expired = db.query(AnalyticsEvent).filter(AnalyticsEvent.timestamp < cutoff).count()
    logs_expired = db.query(LogEntry).filter(LogEntry.timestamp < cutoff).count()
    return RetentionResponse(
        retention_days=RETENTION_DAYS,
        analytics_total=analytics_total,
        logs_total=logs_total,
        analytics_expired=analytics_expired,
        logs_expired=logs_expired,
    )


@router.delete("/retention")
def prune_retained_data(db: Session = Depends(get_db)):
    analytics_deleted = cleanup_old_analytics(db)
    logs_deleted = cleanup_old_logs(db)
    return {
        "analytics_deleted": analytics_deleted,
        "logs_deleted": logs_deleted,
        "retention_days": RETENTION_DAYS,
    }
