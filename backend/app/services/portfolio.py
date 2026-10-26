"""Personal portfolio: a member's holdings and trades, and the breakdown of both.

Privacy rule: every read and write here takes the caller's username and
filters on it. Nothing in this module ever lists rows across accounts, and a
row that belongs to someone else is a 404, the same as one that doesn't exist.

How the two kinds of upload combine: a holdings upload is a snapshot "as of"
a date and replaces the previous snapshot. Transactions dated after that day
are applied on top of it; ones on or before it are already in the snapshot,
so they are kept for the record but not counted twice. With no snapshot,
every transaction counts.
"""
import csv
import io
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app import accounts
from app.database import PortfolioHolding, PortfolioTransaction, SessionLocal, StockSummary
from app.services.stock_data_client import stock_data_client

logger = logging.getLogger(__name__)

MAX_CSV_CHARS = 1_000_000
MAX_ROWS = 2_000
MAX_TRANSACTIONS = 5_000
# The summary price is a daily close, so a cached row is good for most of a day.
QUOTE_MAX_AGE = timedelta(hours=12)
# Each uncached ticker is a few provider calls. Cap them per request so a
# fifty-line portfolio loads its first prices quickly; the page asks again
# for the rest.
MAX_FRESH_QUOTES = 8
QUOTE_WORKERS = 4
EPSILON = 1e-9

TICKER_PATTERN = re.compile(r"^[A-Z][A-Z0-9]{0,5}([.\-/][A-Z0-9]{1,3})?$")
NOT_FOUND = "No such transaction."


def username_for(identity: Dict[str, Any]) -> str:
    username = accounts.normalize_username(str(identity.get("username", "")))
    if not username:
        raise HTTPException(status_code=403, detail="Sign in to see your portfolio.")
    return username


def utc_today() -> date:
    return datetime.now(timezone.utc).date()


# ── CSV parsing ─────────────────────────────────────────────────────────────
#
# Brokerage exports disagree on everything: column names, a few lines of
# preamble above the header, totals rows, "$1,234.50" and "(12.00)". The
# parser finds the header by its column names and normalizes each value, and
# returns every row it couldn't use with a reason, so the page can say so.

COLUMN_ALIASES = {
    "ticker": ("symbol", "ticker", "tickersymbol", "securitysymbol", "stocksymbol"),
    "shares": ("quantity", "shares", "qty", "units", "sharesquantity", "numberofshares"),
    "price": ("price", "pricepershare", "tradeprice", "executionprice", "shareprice", "fillprice"),
    "cost_basis": ("costbasis", "costbasistotal", "totalcost", "totalcostbasis", "cost"),
    "avg_cost": (
        "averagecost", "avgcost", "averagecostbasis", "avgcostbasis", "costpershare",
        "averageprice", "avgprice", "unitcost",
    ),
    "date": ("tradedate", "date", "transactiondate", "rundate", "activitydate", "settlementdate"),
    "side": ("action", "side", "type", "transactiontype", "activity", "buysell", "activitytype"),
    "fees": ("fees", "fee", "commission", "commissions", "feescomm", "commissionfees", "commissionsandfees"),
    "amount": ("amount", "netamount", "total", "value"),
}
DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d", "%d-%b-%Y", "%b %d, %Y")


def _key(cell: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (cell or "").lower())


def _header_map(row: List[str]) -> Dict[str, int]:
    keys = [_key(cell) for cell in row]
    found: Dict[str, int] = {}
    for field, aliases in COLUMN_ALIASES.items():
        # Alias order is preference order: "Trade Date" beats "Settlement Date".
        for alias in aliases:
            if alias in keys:
                found[field] = keys.index(alias)
                break
    return found


def parse_number(value: Optional[str]) -> Optional[float]:
    text = (value or "").strip()
    if not text or text in {"-", "--", "n/a", "N/A"}:
        return None
    negative = text.startswith("(") and text.endswith(")")
    text = re.sub(r"[,$\s()%+]", "", text)
    try:
        number = float(text)
    except ValueError:
        return None
    return -number if negative else number


def parse_date(value: Optional[str]) -> Optional[date]:
    # Schwab writes "10/01/2026 as of 09/30/2026"; the first date is the trade.
    text = (value or "").strip().split(" as of ")[0].strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def parse_side(value: Optional[str]) -> Optional[str]:
    text = (value or "").lower()
    if "sell" in text or "sold" in text:
        return "sell"
    if "buy" in text or "bought" in text or "reinvest" in text:
        return "buy"
    return None


def clean_ticker(value: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """The ticker, or None and why the row was skipped."""
    raw = (value or "").strip().upper()
    if not raw:
        return None, "no symbol"
    if "*" in raw or raw in {"CASH", "PENDING ACTIVITY"} or "CASH" in raw:
        return None, "cash or money market"
    if not TICKER_PATTERN.match(raw):
        return None, f"'{raw[:20]}' isn't a stock symbol"
    return raw.replace("/", "."), None


def parse_csv(text: str, kind: str = "auto") -> Dict[str, Any]:
    if len(text) > MAX_CSV_CHARS:
        raise HTTPException(status_code=413, detail="That file is too large. Keep it under 1 MB.")
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))

    header_index, columns = None, {}
    for index, row in enumerate(rows[:25]):
        candidate = _header_map(row)
        if "ticker" in candidate and "shares" in candidate:
            header_index, columns = index, candidate
            break
    if header_index is None:
        raise HTTPException(
            status_code=422,
            detail="Couldn't find a header row with a Symbol and a Quantity (or Shares) column.",
        )

    if kind == "auto":
        # A trade has a date; a positions export doesn't. (Not "has an Action
        # column": Fidelity's positions export has a "Type" of Cash or Margin.)
        kind = "transactions" if "date" in columns else "holdings"
    body = rows[header_index + 1:]
    if len(body) > MAX_ROWS:
        raise HTTPException(status_code=413, detail=f"That file has more than {MAX_ROWS} rows.")

    def cell(row: List[str], field: str) -> Optional[str]:
        index = columns.get(field)
        return row[index] if index is not None and index < len(row) else None

    parsed: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    for offset, row in enumerate(body):
        line = header_index + offset + 2  # 1-based, and the header is a line
        if not any((c or "").strip() for c in row):
            continue
        ticker, reason = clean_ticker(cell(row, "ticker"))
        if not ticker:
            skipped.append({"line": line, "reason": reason})
            continue
        shares = parse_number(cell(row, "shares"))
        if shares is None or abs(shares) < EPSILON:
            skipped.append({"line": line, "reason": "no share count"})
            continue

        if kind == "holdings":
            cost = parse_number(cell(row, "cost_basis"))
            if cost is None:
                avg = parse_number(cell(row, "avg_cost"))
                cost = avg * abs(shares) if avg is not None else None
            parsed.append({"ticker": ticker, "shares": abs(shares), "cost_basis": abs(cost) if cost is not None else None})
            continue

        side = parse_side(cell(row, "side")) if "side" in columns else ("sell" if shares < 0 else "buy")
        if not side:
            skipped.append({"line": line, "reason": f"'{(cell(row, 'side') or '').strip()[:30]}' isn't a buy or sell"})
            continue
        trade_date = parse_date(cell(row, "date"))
        if not trade_date:
            skipped.append({"line": line, "reason": "no trade date"})
            continue
        shares = abs(shares)
        price = parse_number(cell(row, "price"))
        if price is None:
            amount = parse_number(cell(row, "amount"))
            price = abs(amount) / shares if amount is not None else None
        if price is None or price < 0:
            skipped.append({"line": line, "reason": "no price"})
            continue
        fees = abs(parse_number(cell(row, "fees")) or 0.0)
        parsed.append({
            "ticker": ticker, "side": side, "shares": shares, "price": abs(price),
            "fees": fees, "trade_date": trade_date,
        })

    return {"kind": kind, "rows": parsed, "skipped": skipped}


# ── writes ──────────────────────────────────────────────────────────────────


def replace_holdings(db: Session, username: str, rows: Iterable[Dict[str, Any]], as_of: date) -> int:
    # One statement can list a ticker once per account; fold them together.
    merged: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        entry = merged.setdefault(row["ticker"], {"shares": 0.0, "cost_basis": 0.0})
        entry["shares"] += row["shares"]
        if entry["cost_basis"] is None or row["cost_basis"] is None:
            entry["cost_basis"] = None
        else:
            entry["cost_basis"] += row["cost_basis"]

    db.query(PortfolioHolding).filter(PortfolioHolding.username == username).delete()
    for ticker, entry in merged.items():
        db.add(PortfolioHolding(
            username=username, ticker=ticker, shares=entry["shares"],
            cost_basis=entry["cost_basis"], as_of=as_of,
        ))
    db.commit()
    return len(merged)


def add_transactions(db: Session, username: str, rows: List[Dict[str, Any]], replace: bool = False) -> int:
    query = db.query(PortfolioTransaction).filter(PortfolioTransaction.username == username)
    if replace:
        query.delete()
    elif query.count() + len(rows) > MAX_TRANSACTIONS:
        raise HTTPException(status_code=422, detail=f"A portfolio holds up to {MAX_TRANSACTIONS} transactions.")
    for row in rows:
        db.add(PortfolioTransaction(username=username, **row))
    db.commit()
    return len(rows)


def delete_transaction(db: Session, username: str, transaction_id: int) -> None:
    deleted = (
        db.query(PortfolioTransaction)
        .filter(PortfolioTransaction.username == username, PortfolioTransaction.id == transaction_id)
        .delete()
    )
    if not deleted:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    db.commit()


def clear(db: Session, username: str, holdings: bool = True, transactions: bool = True) -> None:
    if holdings:
        db.query(PortfolioHolding).filter(PortfolioHolding.username == username).delete()
    if transactions:
        db.query(PortfolioTransaction).filter(PortfolioTransaction.username == username).delete()
    db.commit()


# ── positions ───────────────────────────────────────────────────────────────


def build_positions(
    holdings: List[PortfolioHolding], transactions: List[PortfolioTransaction]
) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Any]]:
    """Fold the snapshot and the later trades into positions, at average cost.

    `cost` is None for a position whose cost the statement didn't give, and
    stays None: a gain on top of an unknown basis would be invented.
    """
    as_of = holdings[0].as_of if holdings else None
    positions: Dict[str, Dict[str, Any]] = {}
    for holding in holdings:
        positions[holding.ticker] = {"shares": holding.shares, "cost": holding.cost_basis, "realized": 0.0}

    counted = ignored = sells = 0
    oversold: List[str] = []
    for tx in sorted(transactions, key=lambda t: (t.trade_date, t.id)):
        if as_of and tx.trade_date <= as_of:
            ignored += 1
            continue
        counted += 1
        position = positions.setdefault(tx.ticker, {"shares": 0.0, "cost": 0.0, "realized": 0.0})
        if tx.side == "buy":
            position["shares"] += tx.shares
            if position["cost"] is not None:
                position["cost"] += tx.shares * tx.price + (tx.fees or 0.0)
            continue

        sells += 1
        sold = min(tx.shares, position["shares"])
        if tx.shares - sold > EPSILON and tx.ticker not in oversold:
            oversold.append(tx.ticker)
        if position["cost"] is not None and position["shares"] > EPSILON:
            average = position["cost"] / position["shares"]
            position["cost"] -= average * sold
            if position["realized"] is not None:
                position["realized"] += sold * tx.price - (tx.fees or 0.0) - average * sold
        else:
            position["realized"] = None
        position["shares"] -= sold
        if position["shares"] < EPSILON:
            position["shares"] = 0.0
            if position["cost"] is not None:
                position["cost"] = 0.0

    return positions, {"as_of": as_of, "counted": counted, "ignored": ignored, "sells": sells, "oversold": oversold}


# ── prices ──────────────────────────────────────────────────────────────────


def _quote_from_summary(row: StockSummary, status: str) -> Dict[str, Any]:
    return {"price": row.current_price, "name": row.name, "sector": row.sector, "status": status}


def _fetch_quote(ticker: str) -> Dict[str, Any]:
    # Each worker thread gets its own session: a Session isn't thread-safe.
    db = SessionLocal()
    try:
        data = stock_data_client.get_stock_data(ticker, db)
        summary = data.get("summary") or {}
        return {
            "price": summary.get("current_price"), "name": data.get("name"),
            "sector": data.get("sector"), "status": "live",
        }
    except Exception as exc:  # noqa: BLE001 - one bad ticker shouldn't sink the page
        logger.warning("[%s] portfolio quote unavailable: %s", ticker, type(exc).__name__)
        return {"price": None, "name": None, "sector": None, "status": "unavailable"}
    finally:
        db.close()


def quotes(db: Session, tickers: List[str]) -> Dict[str, Dict[str, Any]]:
    if not tickers:
        return {}
    if stock_data_client._use_mock():
        result = {}
        for ticker in tickers:
            data = stock_data_client.mock.get_stock_data(ticker) or {}
            result[ticker] = {
                "price": (data.get("summary") or {}).get("current_price"), "name": data.get("name"),
                "sector": data.get("sector"), "status": "sample",
            }
        return result

    cached = {row.ticker: row for row in db.query(StockSummary).filter(StockSummary.ticker.in_(tickers))}
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    result: Dict[str, Dict[str, Any]] = {}
    to_fetch: List[str] = []
    for ticker in tickers:
        row = cached.get(ticker)
        if row and row.current_price is not None and row.fetched_at and now - row.fetched_at <= QUOTE_MAX_AGE:
            result[ticker] = _quote_from_summary(row, "live")
        else:
            to_fetch.append(ticker)

    fetching, waiting = to_fetch[:MAX_FRESH_QUOTES], to_fetch[MAX_FRESH_QUOTES:]
    if fetching:
        with ThreadPoolExecutor(max_workers=QUOTE_WORKERS) as pool:
            for ticker, quote in zip(fetching, pool.map(_fetch_quote, fetching)):
                result[ticker] = quote
    for ticker in fetching + waiting:
        row = cached.get(ticker)
        if result.get(ticker, {}).get("price") is None and row and row.current_price is not None:
            result[ticker] = _quote_from_summary(row, "stale")
        elif ticker not in result:
            result[ticker] = {"price": None, "name": None, "sector": None, "status": "pending"}
    return result


# ── the breakdown ───────────────────────────────────────────────────────────


def _serialize_transaction(tx: PortfolioTransaction, counted: bool) -> Dict[str, Any]:
    return {
        "id": tx.id, "ticker": tx.ticker, "side": tx.side, "shares": tx.shares,
        "price": tx.price, "fees": tx.fees or 0.0, "tradeDate": tx.trade_date.isoformat(),
        "counted": counted,
    }


def _ratio(numerator: Optional[float], denominator: Optional[float]) -> Optional[float]:
    if numerator is None or not denominator:
        return None
    return numerator / denominator


def breakdown(db: Session, username: str) -> Dict[str, Any]:
    holdings = db.query(PortfolioHolding).filter(PortfolioHolding.username == username).all()
    transactions = (
        db.query(PortfolioTransaction)
        .filter(PortfolioTransaction.username == username)
        .order_by(PortfolioTransaction.trade_date.desc(), PortfolioTransaction.id.desc())
        .all()
    )
    positions, meta = build_positions(holdings, transactions)
    open_tickers = sorted(t for t, p in positions.items() if p["shares"] > EPSILON)
    prices = quotes(db, open_tickers)

    rows: List[Dict[str, Any]] = []
    for ticker in open_tickers:
        position, quote = positions[ticker], prices[ticker]
        value = position["shares"] * quote["price"] if quote["price"] is not None else None
        cost = position["cost"]
        gain = value - cost if value is not None and cost is not None else None
        rows.append({
            "ticker": ticker,
            "name": quote["name"],
            "sector": quote["sector"] if quote["sector"] not in (None, "", "-") else None,
            "shares": position["shares"],
            "price": quote["price"],
            "priceStatus": quote["status"],
            "marketValue": value,
            "costBasis": cost,
            "avgCost": _ratio(cost, position["shares"]),
            "gain": gain,
            "gainPct": _ratio(gain, cost),
            "realizedGain": position["realized"],
            "weight": None,
        })

    total_value = sum(r["marketValue"] for r in rows if r["marketValue"] is not None)
    for row in rows:
        row["weight"] = _ratio(row["marketValue"], total_value)
    rows.sort(key=lambda r: (r["marketValue"] is None, -(r["marketValue"] or 0), r["ticker"]))

    # Gain only over positions that have both a price and a known basis, so a
    # missing price never reads as a loss.
    comparable = [r for r in rows if r["gain"] is not None]
    cost_total = sum(r["costBasis"] for r in comparable)
    gain_total = sum(r["gain"] for r in comparable)
    realized = [p["realized"] for p in positions.values() if p["realized"] is not None]

    sectors: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        if row["marketValue"] is None:
            continue
        entry = sectors.setdefault(row["sector"] or "Other", {"marketValue": 0.0, "count": 0})
        entry["marketValue"] += row["marketValue"]
        entry["count"] += 1
    sector_rows = sorted(
        ({"sector": name, **entry, "weight": _ratio(entry["marketValue"], total_value)} for name, entry in sectors.items()),
        key=lambda s: -s["marketValue"],
    )

    as_of = meta["as_of"]
    return {
        "totals": {
            "marketValue": total_value,
            "costBasis": cost_total,
            "gain": gain_total if comparable else None,
            "gainPct": _ratio(gain_total, cost_total) if comparable else None,
            # None, not $0, until a counted sell has realized something.
            "realizedGain": sum(realized) if realized and meta["sells"] else None,
            "positions": len(rows),
            "pricedPositions": sum(1 for r in rows if r["marketValue"] is not None),
            "pendingPrices": sum(1 for r in rows if r["priceStatus"] == "pending"),
        },
        "positions": rows,
        "sectors": sector_rows,
        "holdings": {"count": len(holdings), "asOf": as_of.isoformat() if as_of else None},
        "transactions": [
            _serialize_transaction(tx, counted=not (as_of and tx.trade_date <= as_of)) for tx in transactions
        ],
        "transactionsIgnored": meta["ignored"],
        "oversold": meta["oversold"],
        "sampleData": stock_data_client._use_mock(),
    }


# ── value over time ─────────────────────────────────────────────────────────
#
# The value on a day is the shares held that day times that day's close.
# Shares come from the same two sources as the breakdown: with a holdings
# snapshot, days after it add later trades and days before it take back the
# trades between that day and the snapshot; with no snapshot, shares are the
# running total of trades. Before the earliest record we know about, a
# snapshot's shares are assumed held, which the page says in words.

HISTORY_DEFAULT_DAYS = 365
HISTORY_MAX_DAYS = 1000
# Daily closes only change once a day; keep each ticker's for a few hours.
HISTORY_CACHE_TTL = timedelta(hours=6)
MAX_FRESH_HISTORIES = 8
_history_cache: Dict[Tuple[str, int], Tuple[datetime, List[Dict[str, Any]]]] = {}


def _fetch_history(ticker: str, days: int) -> Optional[List[Dict[str, Any]]]:
    try:
        return stock_data_client.get_price_history(ticker, days=days)
    except Exception as exc:  # noqa: BLE001 - reported as a missing ticker
        logger.warning("[%s] portfolio history unavailable: %s", ticker, type(exc).__name__)
        return None


def price_histories(tickers: List[str], days: int) -> Tuple[Dict[str, List[Dict[str, Any]]], List[str], List[str]]:
    """Closes per ticker, plus the tickers still to fetch and those that failed."""
    now = datetime.now(timezone.utc)
    found: Dict[str, List[Dict[str, Any]]] = {}
    to_fetch: List[str] = []
    for ticker in tickers:
        cached = _history_cache.get((ticker, days))
        if cached and now - cached[0] <= HISTORY_CACHE_TTL:
            found[ticker] = cached[1]
        else:
            to_fetch.append(ticker)

    fetching, pending = to_fetch[:MAX_FRESH_HISTORIES], to_fetch[MAX_FRESH_HISTORIES:]
    failed: List[str] = []
    if fetching:
        with ThreadPoolExecutor(max_workers=QUOTE_WORKERS) as pool:
            for ticker, history in zip(fetching, pool.map(lambda t: _fetch_history(t, days), fetching)):
                if history:
                    _history_cache[(ticker, days)] = (now, history)
                    found[ticker] = history
                else:
                    failed.append(ticker)
    return found, pending, failed


def _shares_by_day(
    holdings: List[PortfolioHolding], transactions: List[PortfolioTransaction], days: List[date]
) -> Dict[str, List[float]]:
    as_of = holdings[0].as_of if holdings else None
    base = {h.ticker: h.shares for h in holdings}
    deltas: Dict[str, List[Tuple[date, float]]] = {}
    for tx in transactions:
        sign = 1.0 if tx.side == "buy" else -1.0
        deltas.setdefault(tx.ticker, []).append((tx.trade_date, sign * tx.shares))

    series: Dict[str, List[float]] = {}
    for ticker in set(base) | set(deltas):
        trades = deltas.get(ticker, [])
        values = []
        for day in days:
            if as_of is None:
                shares = sum(n for d, n in trades if d <= day)
            elif day >= as_of:
                shares = base.get(ticker, 0.0) + sum(n for d, n in trades if as_of < d <= day)
            else:
                shares = base.get(ticker, 0.0) - sum(n for d, n in trades if day < d <= as_of)
            values.append(max(shares, 0.0))
        series[ticker] = values
    return series


def value_history(db: Session, username: str, days: int = HISTORY_DEFAULT_DAYS) -> Dict[str, Any]:
    holdings = db.query(PortfolioHolding).filter(PortfolioHolding.username == username).all()
    transactions = db.query(PortfolioTransaction).filter(PortfolioTransaction.username == username).all()
    today = utc_today()
    as_of = holdings[0].as_of if holdings else None

    # Trades-only: start at the first trade, so the line doesn't open on a
    # year of zeros. Either way, reach back far enough to show every trade.
    first_trade = min((tx.trade_date for tx in transactions), default=None)
    if as_of is None and first_trade:
        days = (today - first_trade).days + 1
    elif first_trade:
        days = max(days, (today - first_trade).days + 1)
    days = max(7, min(days, HISTORY_MAX_DAYS))
    start = today - timedelta(days=days - 1)

    tickers = sorted({h.ticker for h in holdings} | {tx.ticker for tx in transactions})
    base = {
        "points": [], "start": start.isoformat(), "asOf": as_of.isoformat() if as_of else None,
        "pending": [], "missing": [], "complete": True, "sampleData": stock_data_client._use_mock(),
    }
    if not tickers:
        return base

    histories, pending, failed = price_histories(tickers, days)
    base["missing"] = failed
    if pending:
        # Half a line would read as a crash, so draw nothing until every
        # ticker's closes are in. The page asks again.
        return {**base, "pending": pending, "complete": False}

    closes: Dict[str, Dict[date, float]] = {}
    trading_days = set()
    for ticker, history in histories.items():
        by_day = {}
        for row in history:
            day = parse_date(row.get("date"))
            if day and day >= start and row.get("close") is not None:
                by_day[day] = float(row["close"])
        closes[ticker] = by_day
        trading_days |= set(by_day)
    day_list = sorted(trading_days)
    shares = _shares_by_day(holdings, transactions, day_list)

    points = []
    last_close: Dict[str, float] = {}
    for index, day in enumerate(day_list):
        value = 0.0
        for ticker, by_day in closes.items():
            if day in by_day:
                last_close[ticker] = by_day[day]
            if ticker in last_close:
                value += shares[ticker][index] * last_close[ticker]
        points.append({"date": day.isoformat(), "value": round(value, 2)})
    # Leading zeros are days before anything was bought.
    while points and points[0]["value"] == 0:
        points.pop(0)
    return {**base, "points": points}
