"""
Admin API router - exposes log data for the admin dashboard.

Endpoints are mounted under /api/admin and protected by the same Basic Auth
middleware that protects /api/*.
"""
import os
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.database import LogEntry, get_db

router = APIRouter(prefix="/api/admin", tags=["admin"])


# Path to backend.log relative to the repository root (../../logs/backend.log
# from this file -> backend/app/routers/admin.py).
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_THIS_DIR, "..", "..", ".."))
LOG_FILE_PATH = os.path.join(_REPO_ROOT, "logs", "backend.log")


class LogEntryOut(BaseModel):
    id: int
    timestamp: str
    level: str
    logger_name: Optional[str] = None
    message: str
    path: Optional[str] = None
    status_code: Optional[int] = None
    method: Optional[str] = None

    class Config:
        from_attributes = True


class LogsResponse(BaseModel):
    entries: List[LogEntryOut]
    total: int


class FileLogResponse(BaseModel):
    lines: List[str]
    path: str
    truncated: bool


@router.get("/logs", response_model=LogsResponse)
def list_logs(
    level: Optional[str] = Query(None, description="Filter by level: DEBUG/INFO/WARNING/ERROR"),
    q: Optional[str] = Query(None, description="Substring search across message"),
    limit: int = Query(200, ge=1, le=5000),
    after_id: Optional[int] = Query(None, description="Only return entries with id > after_id (for live tail)"),
    db: Session = Depends(get_db),
):
    """Return structured log entries from the database, newest first."""
    query = db.query(LogEntry)

    if level:
        query = query.filter(LogEntry.level == level.upper())
    if q:
        query = query.filter(LogEntry.message.ilike(f"%{q}%"))
    if after_id is not None:
        query = query.filter(LogEntry.id > after_id)

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


@router.delete("/logs")
def clear_logs(db: Session = Depends(get_db)):
    """Delete all stored log entries."""
    deleted = db.query(LogEntry).delete()
    db.commit()
    return {"deleted": deleted}


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
