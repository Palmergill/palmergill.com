"""API contract smoke tests: happy path, auth-required routes reject
anonymous calls, and demo mode returns well-formed data with no provider
credentials configured. Poker/bitcoin/admin/login contracts are already
covered in test_security_regressions.py; this file fills the stocks router
gap and adds a couple of cross-router demo-mode/auth checks.
"""
from fastapi.testclient import TestClient

from app.main import SESSION_COOKIE_NAME, app, create_app_session_token

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
