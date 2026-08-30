"""API contract smoke tests: happy path, auth-required routes reject
anonymous calls, and demo mode returns well-formed data with no provider
credentials configured. Poker/bitcoin/admin/login contracts are already
covered in test_security_regressions.py; this file fills the stocks router
gap and adds a couple of cross-router demo-mode/auth checks.
"""
from fastapi.testclient import TestClient
import json
from pathlib import Path

from app import main
from app.main import SESSION_COOKIE_NAME, app, create_app_session_token
from app.version import APP_VERSION

client = TestClient(app)


# ── /api/stocks — demo mode, no provider credentials in the test env ────

def test_stock_search_returns_demo_results():
    response = client.get("/api/stocks/search", params={"q": "AAPL"})

    assert response.status_code == 200
    body = response.json()
    assert body["demo"] is True
    assert "warning" in body
    assert isinstance(body["results"], list)


def test_stock_search_rejects_empty_query():
    response = client.get("/api/stocks/search", params={"q": ""})
    assert response.status_code == 422


def test_get_stock_returns_demo_data_shaped_for_a_ticker():
    response = client.get("/api/stocks/AAPL")

    assert response.status_code == 200
    body = response.json()
    assert body["_demo"] is True
    assert "_warning" in body


def test_get_price_history_returns_demo_series():
    response = client.get("/api/stocks/AAPL/prices", params={"days": 30})

    assert response.status_code == 200
    body = response.json()
    assert body["ticker"] == "AAPL"
    assert body["demo"] is True
    assert body["count"] == len(body["prices"])


def test_get_earnings_returns_demo_data():
    response = client.get("/api/stocks/AAPL/earnings")
    assert response.status_code == 200


# ── Auth-required routes reject anonymous callers ────────────────────────

def test_admin_api_rejects_anonymous_request(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    auth_client = TestClient(app)

    response = auth_client.get("/api/admin/analytics/summary")

    assert response.status_code == 401


def test_admin_api_accepts_valid_session_cookie(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    auth_client = TestClient(app)
    auth_client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token("palmer", "secret"))

    response = auth_client.get("/api/admin/analytics/summary")

    assert response.status_code == 200


def test_health_check_is_public_and_unauthenticated(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", "palmer")
    monkeypatch.setenv("APP_AUTH_PASSWORD", "secret")
    auth_client = TestClient(app)

    response = auth_client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": APP_VERSION, "database": "ok"}


def test_health_check_fails_when_database_is_unavailable(monkeypatch):
    monkeypatch.setattr(
        main,
        "_check_database_readiness",
        lambda: (_ for _ in ()).throw(RuntimeError("database unavailable")),
    )

    response = TestClient(app).get("/health")

    assert response.status_code == 503
    assert response.json() == {
        "status": "unhealthy",
        "version": APP_VERSION,
        "database": "unavailable",
    }


def test_release_version_is_consistent_across_runtime_metadata():
    root = Path(__file__).resolve().parents[2]
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    package_lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))

    assert (root / "VERSION").read_text(encoding="utf-8").strip() == APP_VERSION
    assert package["version"] == APP_VERSION
    assert package_lock["version"] == APP_VERSION
    assert package_lock["packages"][""]["version"] == APP_VERSION
    assert app.version == APP_VERSION


# ── timestamp serialization ────────────────────────────────────────────

def test_iso_utc_marks_naive_stored_timestamps_as_utc():
    """Every stored timestamp is naive UTC (see `utc_now`).

    An offsetless date-time string is read by JavaScript's `new Date()` as
    *local* time, so a browser west of UTC parses it hours into the future.
    Serializing through `iso_utc` is what keeps a stored timestamp meaning
    the same instant on the client.
    """
    from datetime import datetime, timedelta, timezone

    from app.database import iso_utc, utc_now

    assert iso_utc(None) is None

    naive = datetime(2026, 8, 22, 14, 26, 8)
    assert iso_utc(naive) == "2026-08-22T14:26:08Z"

    # An aware value is normalized to UTC rather than trusted as-is.
    aware = datetime(2026, 8, 22, 9, 26, 8, tzinfo=timezone(timedelta(hours=-5)))
    assert iso_utc(aware) == "2026-08-22T14:26:08Z"

    # The round trip a client actually performs must land back on the
    # instant that was stored.
    stored = utc_now()
    parsed = datetime.fromisoformat(iso_utc(stored).replace("Z", "+00:00"))
    assert parsed == stored.replace(tzinfo=timezone.utc)
