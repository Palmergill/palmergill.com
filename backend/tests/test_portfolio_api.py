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
    monkeypatch.setattr(portfolio, "quotes", lambda db, positions: {
        t: {
            "price": PRICES.get(t), "name": t, "sector": "Technology", "asOf": None,
            "status": "live" if t in PRICES else "unavailable",
        }
        for t in positions
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
    ("get", "/api/stocks/portfolio/history"),
    ("get", "/api/stocks/portfolio/transactions"),
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
    _buy(owner)
    tx_id = owner.get("/api/stocks/portfolio/transactions").json()["rows"][0]["id"]

    for stranger in (other, admin):
        assert stranger.get("/api/stocks/portfolio").json()["positions"] == []
        assert stranger.get("/api/stocks/portfolio/transactions").json()["total"] == 0
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
    rows = client.get("/api/stocks/portfolio/transactions").json()["rows"]
    assert [t["counted"] for t in rows] == [True, False]


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
    assert body["imported"]["kind"] == "holdings" and body["imported"]["count"] == 2
    aapl = next(p for p in body["portfolio"]["positions"] if p["ticker"] == "AAPL")
    assert aapl["shares"] == 15 and aapl["costBasis"] == pytest.approx(2400.0)

    body = client.post("/api/stocks/portfolio/import", json={"csv": "Ticker,Shares\nMSFT,1\n"}).json()
    assert [p["ticker"] for p in body["portfolio"]["positions"]] == ["MSFT"]


def test_brokerage_history_export_auto_detects_as_transactions():
    parsed = portfolio.parse_csv(SCHWAB_HISTORY)
    assert parsed["kind"] == "transactions"
    rows = {r["ticker"]: r for r in parsed["rows"]}
    msft = rows["MSFT"]
    assert {k: msft[k] for k in ("ticker", "asset", "side", "shares", "price", "fees", "trade_date", "amount", "notes")} == {
        "ticker": "MSFT", "asset": "stock", "side": "buy", "shares": 3.0, "price": 410.0, "fees": 1.0,
        "trade_date": date(2026, 10, 1), "amount": 1231.0, "notes": "MICROSOFT CORP",
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
    from app.database import PriceCoverage

    db = SessionLocal()
    try:
        db.query(PriceCoverage).delete()
        db.commit()
    finally:
        db.close()
    portfolio._meta.clear()
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
    assert body["points"][0] == {"date": first.isoformat(), "value": 20.0, "invested": 20.0, "estimated": False}
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
    # Drawn as it fills in: unpriced tickers are estimated from trade prices.
    assert first["complete"] is False and first["retryAfter"] and first["pending"]
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


# ── a full multi-broker history, like the one the importer was fixed for ────

MULTI_BROKER = """date,source,account,type,security,quantity,price,amount_usd,fees_usd,realized_gain_loss,notes
2017-02-06,Uploaded CSV,Robinhood,buy,NVDA,10,25.00,250.00,0,,10 shares of NVDA purchased
2018-05-01,Uploaded CSV,Robinhood,sell,NVDA,4,60.00,240.00,0,135.00,4 shares of NVDA sold
2020-01-02,M1 Finance,M1 Finance My Portfolio,buy,VOO,0.12345,300.00,37.04,0,,0.12345 shares of VOO purchased
2021-03-01,BTC transactions CSV,Crypto Account,buy,BTC,0.01,50000.00,500.00,1.50,,Bought BTC
2025-01-06,Robinhood,Robinhood individual,buy,IBIT call $100,2,4.10,8.20,0,,IBIT $100 Call 3/21/2025
2025-12-10,Robinhood,Robinhood Roth IRA,buy,Twenty One Capital,40,11.50,460.00,0,,Twenty One Capital Class A purchased
"""


def test_a_multi_broker_history_imports_every_row_with_its_details():
    parsed = portfolio.parse_csv(MULTI_BROKER)
    assert parsed["kind"] == "transactions" and parsed["skipped"] == []
    by_ticker = {r["ticker"]: r for r in parsed["rows"]}
    assert set(by_ticker) == {"NVDA", "VOO", "BTC", "IBIT call $100", "Twenty One Capital"}
    assert by_ticker["BTC"]["asset"] == "crypto" and by_ticker["BTC"]["fees"] == 1.5
    assert by_ticker["Twenty One Capital"]["asset"] == "other"
    assert by_ticker["VOO"]["shares"] == pytest.approx(0.12345)
    sell = next(r for r in parsed["rows"] if r["side"] == "sell")
    assert (sell["account"], sell["source"], sell["realized_reported"]) == ("Robinhood", "Uploaded CSV", 135.0)


def test_uploading_the_same_history_twice_adds_nothing_the_second_time():
    client = _member_client()
    first = client.post("/api/stocks/portfolio/import", json={"csv": MULTI_BROKER}).json()["imported"]
    second = client.post("/api/stocks/portfolio/import", json={"csv": MULTI_BROKER}).json()["imported"]
    assert (first["added"], second["added"], second["duplicates"]) == (6, 0, 6)


def test_a_real_upload_replaces_the_sample_trades():
    client = _member_client()
    sample = "Date,Action,Symbol,Quantity,Price,Source\n2026-01-05,Buy,AAPL,20,228,Sample\n"
    client.post("/api/stocks/portfolio/import", json={"csv": sample})
    imported = client.post("/api/stocks/portfolio/import", json={"csv": MULTI_BROKER}).json()["imported"]
    assert imported["removedSample"] == 1
    assert client.get("/api/stocks/portfolio/transactions").json()["total"] == 6


def test_the_breakdown_reports_accounts_years_closed_and_reported_gains():
    client = _member_client()
    body = client.post("/api/stocks/portfolio/import", json={"csv": MULTI_BROKER}).json()["portfolio"]
    assert {a["name"] for a in body["accounts"]} >= {"Robinhood", "Crypto Account", "Robinhood Roth IRA"}
    assert [y["year"] for y in body["years"]][:2] == [2025, 2021]
    nvda_sell_realized = 4 * 60.0 - 4 * 25.0
    assert body["reportedRealized"] == {"count": 1, "reported": 135.0, "computed": pytest.approx(nvda_sell_realized)}
    assert body["totals"]["realizedGain"] == pytest.approx(nvda_sell_realized)
    # The option was bought and never sold here, so it is still open.
    assert "IBIT call $100" in {p["ticker"] for p in body["positions"]}


def test_the_trade_list_pages_and_filters():
    client = _member_client()
    client.post("/api/stocks/portfolio/import", json={"csv": MULTI_BROKER})
    page = client.get("/api/stocks/portfolio/transactions", params={"limit": 2}).json()
    assert page["total"] == 6 and len(page["rows"]) == 2
    assert page["rows"][0]["ticker"] == "Twenty One Capital"  # newest first
    sells = client.get("/api/stocks/portfolio/transactions", params={"side": "sell"}).json()
    assert sells["total"] == 1 and sells["rows"][0]["realized"] == pytest.approx(140.0)
    crypto = client.get("/api/stocks/portfolio/transactions", params={"asset": "crypto"}).json()
    assert [r["ticker"] for r in crypto["rows"]] == ["BTC"]
    by_year = client.get("/api/stocks/portfolio/transactions", params={"year": 2017}).json()
    assert by_year["total"] == 1
    found = client.get("/api/stocks/portfolio/transactions", params={"q": "class a"}).json()
    assert found["total"] == 1


def test_history_reaches_back_to_the_first_trade_and_estimates_without_closes(monkeypatch):
    _reset_prices(monkeypatch)
    # The provider has nothing: every point is valued at trade prices.
    monkeypatch.setattr(portfolio, "_fetch_closes", lambda symbol, start, end: [])
    client = _member_client()
    client.post("/api/stocks/portfolio/import", json={"csv": MULTI_BROKER})
    body = client.get("/api/stocks/portfolio/history").json()
    assert body["points"][0]["date"] == "2017-02-06"
    assert body["points"][0]["value"] == 250.0 and body["points"][0]["estimated"] is True
    assert body["points"][0]["invested"] == 250.0


def test_a_sell_with_nothing_on_record_does_not_erase_later_gains():
    client = _member_client()
    _buy(client, "AAPL", shares=5, price=100.0, day="2020-01-02", side="sell")  # no buy before it
    _buy(client, "AAPL", shares=10, price=100.0, day="2020-02-03")
    body = _buy(client, "AAPL", shares=4, price=150.0, day="2020-03-02", side="sell")
    assert body["oversold"] == ["AAPL"]
    assert body["totals"]["realizedGain"] == pytest.approx(4 * 50.0)
    assert body["realizedByTicker"][0]["realizedGain"] == pytest.approx(200.0)
