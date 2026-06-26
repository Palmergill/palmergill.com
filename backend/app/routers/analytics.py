from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.database import AnalyticsEvent, get_db, utc_now

router = APIRouter(prefix="/api/analytics", tags=["analytics"])

RETENTION_DAYS = 90
ANALYTICS_RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("ANALYTICS_RATE_LIMIT_WINDOW_SECONDS", "60"))
ANALYTICS_RATE_LIMIT_MAX_EVENTS = int(os.getenv("ANALYTICS_RATE_LIMIT_MAX_EVENTS", "120"))
_analytics_rate_limit_store: dict[str, list[float]] = {}
_SENSITIVE_KEY_RE = re.compile(
    r"(password|passwd|pwd|token|secret|api[_-]?key|apikey|authorization|cookie|session)",
    re.IGNORECASE,
)
_SENSITIVE_QUERY_RE = re.compile(
    r"([?&](?:player_token|token|password|api_key|apikey|secret|authorization|cookie|session)=)([^&#\s\"]+)",
    re.IGNORECASE,
)
MAX_METADATA_JSON_BYTES = int(os.getenv("ANALYTICS_MAX_METADATA_JSON_BYTES", "8192"))
MAX_METADATA_DEPTH = int(os.getenv("ANALYTICS_MAX_METADATA_DEPTH", "6"))
MAX_METADATA_KEYS = int(os.getenv("ANALYTICS_MAX_METADATA_KEYS", "100"))
MAX_METADATA_LIST_ITEMS = int(os.getenv("ANALYTICS_MAX_METADATA_LIST_ITEMS", "50"))
MAX_METADATA_STRING_LENGTH = int(os.getenv("ANALYTICS_MAX_METADATA_STRING_LENGTH", "1000"))


def _validate_metadata_shape(value: Any, depth: int = 0) -> None:
    if depth > MAX_METADATA_DEPTH:
        raise ValueError(f"metadata is nested deeper than {MAX_METADATA_DEPTH} levels")
    if isinstance(value, dict):
        if len(value) > MAX_METADATA_KEYS:
            raise ValueError(f"metadata has more than {MAX_METADATA_KEYS} keys")
        for key, entry in value.items():
            if len(str(key)) > 120:
                raise ValueError("metadata keys must be 120 characters or fewer")
            _validate_metadata_shape(entry, depth + 1)
        return
    if isinstance(value, list):
        if len(value) > MAX_METADATA_LIST_ITEMS:
            raise ValueError(f"metadata lists may include at most {MAX_METADATA_LIST_ITEMS} items")
        for entry in value:
            _validate_metadata_shape(entry, depth + 1)
        return
    if isinstance(value, str) and len(value) > MAX_METADATA_STRING_LENGTH:
        raise ValueError(f"metadata strings must be {MAX_METADATA_STRING_LENGTH} characters or fewer")


class AnalyticsEventIn(BaseModel):
    event_type: str = Field(default="app_event", max_length=40)
    event_name: Optional[str] = Field(default=None, max_length=120)
    app: Optional[str] = Field(default=None, max_length=80)
    path: Optional[str] = Field(default=None, max_length=500)
    referrer: Optional[str] = Field(default=None, max_length=1000)
    visitor_id: Optional[str] = Field(default=None, max_length=120)
    session_id: Optional[str] = Field(default=None, max_length=120)
    metadata: Optional[dict[str, Any]] = None

    @field_validator("metadata")
    @classmethod
    def validate_metadata(cls, value: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
        if value is None:
            return value
        _validate_metadata_shape(value)
        encoded = json.dumps(value, separators=(",", ":"), default=str).encode("utf-8")
        if len(encoded) > MAX_METADATA_JSON_BYTES:
            raise ValueError(f"metadata JSON must be {MAX_METADATA_JSON_BYTES} bytes or fewer")
        return value


def classify_outcome(status_code: int | None, level: str | None = None) -> str:
    if level and level.upper() in {"ERROR", "CRITICAL"}:
        return "error"
    if level and level.upper() == "WARNING":
        return "warning"
    if status_code is None:
        return "success"
    if status_code >= 500:
        return "error"
    if status_code >= 400:
        return "warning"
    return "success"


def app_from_path(path: str | None) -> str:
    if not path or path == "/":
        return "home"
    first = path.strip("/").split("/", 1)[0]
    if first == "api":
        parts = path.strip("/").split("/")
        return f"api:{parts[1]}" if len(parts) > 1 else "api"
    return first or "home"


def redact_sensitive_text(value: str | None) -> str | None:
    if not value:
        return value
    return _SENSITIVE_QUERY_RE.sub(r"\1[REDACTED]", value)


def redact_metadata(value: Any) -> Any:
    if isinstance(value, dict):
        redacted = {}
        for key, entry in value.items():
            if _SENSITIVE_KEY_RE.search(str(key)):
                redacted[key] = "[REDACTED]"
            else:
                redacted[key] = redact_metadata(entry)
        return redacted
    if isinstance(value, list):
        return [redact_metadata(entry) for entry in value[:50]]
    if isinstance(value, str):
        return redact_sensitive_text(value)
    return value


def safe_json(value: dict[str, Any] | None) -> str | None:
    if not value:
        return None
    return json.dumps(redact_metadata(value), separators=(",", ":"), default=str)[:8000]


def _analytics_client_key(request: Request) -> str:
    # Route through the shared helper so this respects TRUST_PROXY_HEADERS.
    # Behind a proxy, request.client.host is the proxy's IP and every visitor
    # collapses to the same bucket — defeating the rate limit.
    from app.main import client_ip

    return client_ip(request)


def _analytics_rate_limited(request: Request, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    key = _analytics_client_key(request)
    cutoff = now - ANALYTICS_RATE_LIMIT_WINDOW_SECONDS
    attempts = [t for t in _analytics_rate_limit_store.get(key, []) if t > cutoff]
    if len(attempts) >= ANALYTICS_RATE_LIMIT_MAX_EVENTS:
        _analytics_rate_limit_store[key] = attempts
        return True
    attempts.append(now)
    _analytics_rate_limit_store[key] = attempts
    return False


def record_analytics_event(
    db: Session,
    *,
    event_type: str,
    event_name: str | None = None,
    app: str | None = None,
    path: str | None = None,
    method: str | None = None,
    status_code: int | None = None,
    referrer: str | None = None,
    user_agent: str | None = None,
    ip_address: str | None = None,
    visitor_id: str | None = None,
    session_id: str | None = None,
    is_authenticated: bool = False,
    is_admin: bool = False,
    username: str | None = None,
    duration_ms: float | None = None,
    metadata: dict[str, Any] | None = None,
) -> AnalyticsEvent:
    event = AnalyticsEvent(
        event_type=event_type[:40],
        event_name=event_name[:120] if event_name else None,
        app=(app or app_from_path(path))[:80],
        path=redact_sensitive_text(path)[:500] if path else None,
        method=method[:12] if method else None,
        status_code=status_code,
        outcome=classify_outcome(status_code),
        referrer=redact_sensitive_text(referrer)[:1000] if referrer else None,
        user_agent=user_agent[:1000] if user_agent else None,
        ip_address=ip_address[:120] if ip_address else None,
        visitor_id=visitor_id[:120] if visitor_id else None,
        session_id=session_id[:120] if session_id else None,
        is_authenticated=is_authenticated,
        is_admin=is_admin,
        username=username[:120] if username else None,
        duration_ms=duration_ms,
        metadata_json=safe_json(metadata),
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


def cleanup_old_analytics(db: Session, days: int = RETENTION_DAYS) -> int:
    cutoff = utc_now() - timedelta(days=days)
    deleted = db.query(AnalyticsEvent).filter(AnalyticsEvent.timestamp < cutoff).delete()
    db.commit()
    return deleted


@router.post("/events")
async def create_event(
    payload: AnalyticsEventIn,
    request: Request,
    db: Session = Depends(get_db),
):
    if _analytics_rate_limited(request):
        raise HTTPException(status_code=429, detail="Too many analytics events. Try again later.")

    from app.main import client_ip

    path = payload.path or request.headers.get("x-analytics-path") or request.url.path
    is_admin = path == "/admin" or path.startswith("/admin/") or path.startswith("/api/admin")
    event = record_analytics_event(
        db,
        event_type=payload.event_type,
        event_name=payload.event_name,
        app=payload.app,
        path=path,
        method=None,
        status_code=None,
        referrer=payload.referrer or request.headers.get("referer"),
        user_agent=request.headers.get("user-agent"),
        ip_address=client_ip(request),
        visitor_id=payload.visitor_id,
        session_id=payload.session_id,
        is_authenticated=bool(getattr(request.state, "app_auth_authenticated", False)),
        is_admin=is_admin,
        metadata=payload.metadata,
    )
    return {"ok": True, "id": event.id}
