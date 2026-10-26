"""Personal portfolio: the privacy boundary, the CSV importer, and the math.

The invariant: a portfolio is only ever served to its owner. Anonymous
callers get a JSON 403 on every route, and another account's transaction is
a 404 — including to the admin.
"""
import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app import accounts
from app.database import SessionLocal
from app.main import ROLE_ADMIN, ROLE_MEMBER, SESSION_COOKIE_NAME, app, create_app_session_token
from app.services import portfolio

ADMIN = "palmer"
SECRET = "secret"
PRICES = {"AAPL": 200.0, "MSFT": 400.0, "NVDA": 100.0}
# The autouse fixture swaps quotes for fixed prices; one test needs the real one.
REAL_QUOTES = portfolio.quotes


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("APP_AUTH_USERNAME", ADMIN)
    monkeypatch.setenv("APP_AUTH_PASSWORD", SECRET)
    monkeypatch.delenv("LOCAL_SITE_ROOT", raising=False)
    monkeypatch.delenv("LOCAL_AUTH_USER", raising=False)
    # No provider calls: a fixed price per ticker.
    monkeypatch.setattr(portfolio, "quotes", lambda db, tickers: {
        t: {"price": PRICES.get(t), "name": t, "sector": "Technology", "status": "live" if t in PRICES else "unavailable"}
        for t in tickers
    })


def _member_client() -> TestClient:
    name = f"pf{uuid.uuid4().hex[:10]}"
    db = SessionLocal()
    try:
        accounts.create_user(db, name, "correct-horse-battery")
    finally:
        db.close()
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token(name, SECRET, role=ROLE_MEMBER))
    return client


def _admin_client() -> TestClient:
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, create_app_session_token(ADMIN, SECRET, role=ROLE_ADMIN))
    return client


def _buy(client, ticker="AAPL", shares=10, price=150.0, day="2026-01-05", side="buy"):
    response = client.post("/api/stocks/portfolio/transactions", json={
        "ticker": ticker, "side": side, "shares": shares, "price": price, "trade_date": day,
    })
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.parametrize("method,path", [
    ("get", "/api/stocks/portfolio"),
    ("post", "/api/stocks/portfolio/import"),
    ("post", "/api/stocks/portfolio/transactions"),
    ("delete", "/api/stocks/portfolio/transactions/1"),
    ("delete", "/api/stocks/portfolio/holdings"),
    ("delete", "/api/stocks/portfolio"),
])
def test_anonymous_callers_get_a_json_403(method, path):
    response = getattr(TestClient(app), method)(path)
    assert response.status_code == 403
    assert response.json()["detail"] == "Sign in to see your portfolio."


def test_portfolio_route_is_not_swallowed_by_the_ticker_route():
    body = _member_client().get("/api/stocks/portfolio").json()
    assert body["positions"] == [] and "totals" in body


def test_a_portfolio_is_never_served_to_another_account():
    owner, other, admin = _member_client(), _member_client(), _admin_client()
    tx_id = _buy(owner)["transactions"][0]["id"]

    for stranger in (other, admin):
        assert stranger.get("/api/stocks/portfolio").json()["positions"] == []
        assert stranger.delete(f"/api/stocks/portfolio/transactions/{tx_id}").status_code == 404
        stranger.delete("/api/stocks/portfolio")

    assert [p["ticker"] for p in owner.get("/api/stocks/portfolio").json()["positions"]] == ["AAPL"]


def test_average_cost_and_realized_gain():
    client = _member_client()
    _buy(client, shares=10, price=100.0, day="2026-01-05")
    _buy(client, shares=10, price=200.0, day="2026-02-05")
    body = _buy(client, shares=5, price=300.0, day="2026-03-05", side="sell")

    (aapl,) = body["positions"]
    assert aapl["shares"] == 15
    assert aapl["avgCost"] == pytest.approx(150.0)
    assert aapl["marketValue"] == pytest.approx(3000.0)
    assert aapl["gain"] == pytest.approx(3000.0 - 2250.0)
    assert aapl["realizedGain"] == pytest.approx(5 * (300 - 150))
    assert body["totals"]["realizedGain"] == pytest.approx(750.0)


def test_transactions_on_or_before_the_snapshot_are_not_counted_twice():
    client = _member_client()
    client.post("/api/stocks/portfolio/import", json={
        "csv": "Symbol,Quantity,Cost Basis\nAAPL,10,1500\n", "kind": "holdings", "as_of": "2026-06-30",
    })
    _buy(client, shares=10, price=150.0, day="2026-06-01")  # already in the snapshot
    body = _buy(client, shares=5, price=180.0, day="2026-07-15")

    (aapl,) = body["positions"]
    assert aapl["shares"] == 15
    assert aapl["costBasis"] == pytest.approx(1500 + 900)
    assert body["transactionsIgnored"] == 1
    assert [t["counted"] for t in body["transactions"]] == [True, False]


def test_weights_and_sectors_add_up():
    client = _member_client()
    _buy(client, "AAPL", shares=10)
    body = _buy(client, "MSFT", shares=5)
    assert body["totals"]["marketValue"] == pytest.approx(10 * 200 + 5 * 400)
    assert sum(p["weight"] for p in body["positions"]) == pytest.approx(1.0)
    assert body["sectors"][0]["weight"] == pytest.approx(1.0)


def test_unpriced_position_never_reads_as_a_loss():
    client = _member_client()
    _buy(client, "AAPL", shares=1, price=100.0)
    body = _buy(client, "ZZZZ", shares=1, price=100.0)
    zzzz = next(p for p in body["positions"] if p["ticker"] == "ZZZZ")
    assert zzzz["marketValue"] is None and zzzz["gain"] is None
    assert body["totals"]["gain"] == pytest.approx(100.0)


# ── the importer ────────────────────────────────────────────────────────────

FIDELITY_POSITIONS = """﻿Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total,Average Cost Basis,Type
Z123,Individual,SPAXX**,HELD IN MONEY MARKET,,,"$1,204.11",,,Cash
Z123,Individual,AAPL,APPLE INC,10,$200.00,"$2,000.00","$1,500.00",$150.00,Cash
Z456,Roth IRA,AAPL,APPLE INC,5,$200.00,"$1,000.00",$900.00,$180.00,Margin
Z456,Roth IRA,NVDA,NVIDIA CORP,20,$100.00,"$2,000.00",--,--,Cash
,,Pending Activity,,,,$12.00,,,

"Date downloaded Oct-26-2026"
"""

SCHWAB_HISTORY = """"Transactions  for account Individual ...123 as of 10/26/2026"
"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"
"10/01/2026 as of 09/30/2026","Buy","MSFT","MICROSOFT CORP","3","$410.00","$1.00","-$1,231.00"
"09/15/2026","Sell","AAPL","APPLE INC","2","$220.00","","$440.00"
"09/10/2026","Qualified Dividend","AAPL","APPLE INC","","","","$5.00"
"09/01/2026","Reinvest Shares","VTI","VANGUARD TOTAL","0.5","","","-$140.00"
"""


def test_brokerage_positions_export_auto_detects_as_holdings():
    parsed = portfolio.parse_csv(FIDELITY_POSITIONS)
    assert parsed["kind"] == "holdings"
    assert [r["ticker"] for r in parsed["rows"]] == ["AAPL", "AAPL", "NVDA"]
    assert parsed["rows"][0]["cost_basis"] == 1500.0
    assert parsed["rows"][2]["cost_basis"] is None
    reasons = [s["reason"] for s in parsed["skipped"]]
    assert "cash or money market" in reasons


def test_holdings_upload_merges_accounts_and_replaces_the_snapshot():
    client = _member_client()
    body = client.post("/api/stocks/portfolio/import", json={"csv": FIDELITY_POSITIONS}).json()
    assert body["imported"] == {"kind": "holdings", "count": 2}
    aapl = next(p for p in body["portfolio"]["positions"] if p["ticker"] == "AAPL")
    assert aapl["shares"] == 15 and aapl["costBasis"] == pytest.approx(2400.0)

    body = client.post("/api/stocks/portfolio/import", json={"csv": "Ticker,Shares\nMSFT,1\n"}).json()
    assert [p["ticker"] for p in body["portfolio"]["positions"]] == ["MSFT"]


def test_brokerage_history_export_auto_detects_as_transactions():
    parsed = portfolio.parse_csv(SCHWAB_HISTORY)
    assert parsed["kind"] == "transactions"
    rows = {r["ticker"]: r for r in parsed["rows"]}
    assert rows["MSFT"] == {
        "ticker": "MSFT", "side": "buy", "shares": 3.0, "price": 410.0, "fees": 1.0, "trade_date": date(2026, 10, 1),
    }
    assert rows["AAPL"]["side"] == "sell"
    # Price from the amount when the export leaves it blank.
    assert rows["VTI"]["price"] == pytest.approx(280.0)
    assert len(parsed["skipped"]) == 1  # the dividend has no share count


def test_a_file_without_the_needed_columns_is_a_clear_422():
    client = _member_client()
    response = client.post("/api/stocks/portfolio/import", json={"csv": "Name,Amount\nFoo,1\n"})
    assert response.status_code == 422
    assert "Symbol" in response.json()["detail"]


# ── value over time ─────────────────────────────────────────────────────────


def _flat_history(monkeypatch, closes, calls=None):
    """Every ticker closes at closes[ticker] on every weekday of the window."""
    from datetime import timedelta

    def fake(ticker, start, end):
        if calls is not None:
            calls.append(ticker)
        days = (end - start).days + 1
        return [
            (start + timedelta(days=i), closes[ticker])
            for i in range(days) if (start + timedelta(days=i)).weekday() < 5
        ]

    _reset_prices(monkeypatch)
    monkeypatch.setattr(portfolio, "_fetch_closes", fake)


def _reset_prices(monkeypatch):
    from app.database import PriceClose

    db = SessionLocal()
    try:
        db.query(PriceClose).delete()
        db.commit()
    finally:
        db.close()
    for cache in (portfolio._checked, portfolio._listed_from, portfolio._meta):
        cache.clear()
    monkeypatch.setattr(portfolio, "_rate_limited_until", None)
    monkeypatch.setattr(portfolio, "_fetch_meta", lambda t: {"name": t, "sector": "Technology"})


def test_history_is_member_only():
    assert TestClient(app).get("/api/stocks/portfolio/history").status_code == 403


def test_history_follows_trades_from_the_first_one(monkeypatch):
    from datetime import timedelta

    _flat_history(monkeypatch, {"AAPL": 10.0})
    client = _member_client()
    today = portfolio.utc_today()
    first = today - timedelta(days=30)
    while first.weekday() >= 5:
        first -= timedelta(days=1)
    _buy(client, shares=2, price=10.0, day=first.isoformat())
    _buy(client, shares=3, price=10.0, day=(today - timedelta(days=7)).isoformat())

    body = client.get("/api/stocks/portfolio/history").json()
    assert body["complete"] is True
    assert body["points"][0] == {"date": first.isoformat(), "value": 20.0}
    assert body["points"][-1]["value"] == 50.0


def test_history_rolls_a_snapshot_back_through_earlier_trades(monkeypatch):
    from datetime import timedelta

    _flat_history(monkeypatch, {"AAPL": 10.0})
    client = _member_client()
    today = portfolio.utc_today()
    client.post("/api/stocks/portfolio/import", json={
        "csv": "Symbol,Quantity\nAAPL,10\n", "kind": "holdings", "as_of": today.isoformat(),
    })
    # Bought 4 of the 10 twenty days ago: before that, only 6 were held.
    _buy(client, shares=4, price=10.0, day=(today - timedelta(days=20)).isoformat())

    points = client.get("/api/stocks/portfolio/history").json()["points"]
    assert points[0]["value"] == 60.0
    assert points[-1]["value"] == 100.0


def test_history_waits_until_every_ticker_has_prices(monkeypatch):
    tickers = "ABCDEFGHIJ"
    _flat_history(monkeypatch, {t: 1.0 for t in tickers})
    client = _member_client()
    rows = "\n".join(f"{t},1" for t in tickers)
    client.post("/api/stocks/portfolio/import", json={"csv": f"Symbol,Quantity\n{rows}\n", "kind": "holdings"})

    # Each request spends a few provider calls, never all ten at once.
    first = client.get("/api/stocks/portfolio/history").json()
    assert first["complete"] is False and first["points"] == [] and first["retryAfter"]
    for _ in range(5):
        body = client.get("/api/stocks/portfolio/history").json()
        if body["complete"]:
            break
    assert body["complete"] is True and body["points"][-1]["value"] == 10.0


def test_stored_closes_are_not_fetched_again(monkeypatch):
    calls = []
    _flat_history(monkeypatch, {"AAPL": 10.0}, calls)
    client = _member_client()
    _buy(client, shares=1, price=10.0)
    client.get("/api/stocks/portfolio/history")
    client.get("/api/stocks/portfolio/history")
    assert calls == ["AAPL"]


def test_a_rate_limit_pauses_fetching_and_leaves_tickers_pending(monkeypatch):
    from app.services.polygon_client import PolygonRateLimited

    calls = []

    def limited(ticker, start, end):
        calls.append(ticker)
        raise PolygonRateLimited(ticker)

    _reset_prices(monkeypatch)
    monkeypatch.setattr(portfolio, "_fetch_closes", limited)
    client = _member_client()
    _buy(client, "AAPL", shares=1)

    body = client.get("/api/stocks/portfolio/history").json()
    assert body["complete"] is False and body["pending"] == ["AAPL"]
    assert body["retryAfter"] > 2
    client.get("/api/stocks/portfolio/history")
    assert calls == ["AAPL"]  # no second call inside the cooldown


def test_the_breakdown_prices_positions_from_stored_closes(monkeypatch):
    _flat_history(monkeypatch, {"AAPL": 12.0})
    monkeypatch.setattr(portfolio, "quotes", REAL_QUOTES)
    client = _member_client()
    body = _buy(client, "AAPL", shares=2, price=10.0)
    (aapl,) = body["positions"]
    assert aapl["price"] == 12.0 and aapl["marketValue"] == 24.0 and aapl["sector"] == "Technology"
