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
import threading
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import accounts
from app.database import PortfolioHolding, PortfolioTransaction, PriceClose, StockSummary
from app.services.polygon_client import PolygonRateLimited
from app.services.stock_data_client import stock_data_client

logger = logging.getLogger(__name__)

MAX_CSV_CHARS = 1_000_000
MAX_ROWS = 2_000
MAX_TRANSACTIONS = 5_000
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
#
# Every price here is a daily close from one provider call per ticker: a
# range of daily bars. The newest close is the position's price and the rest
# draw the value chart. Closes are stored in `price_closes` and past ones
# never change, so after the first fill a ticker costs one small call a few
# times a day. That matters because the provider plan allows only a handful
# of calls a minute: each request spends at most CALLS_PER_REQUEST, and a 429
# stops all fetching for a minute and leaves the rest "pending", which the
# page asks about again after `retryAfter` seconds.

PRICE_HISTORY_DAYS = 365
CALLS_PER_REQUEST = 4
# How long a ticker's newest close counts as current before asking for more.
PRICE_RECHECK = timedelta(hours=4)
RATE_LIMIT_COOLDOWN = timedelta(seconds=65)
# A close this many days old (a long weekend, a holiday) is still current.
STALE_AFTER_DAYS = 5

_lock = threading.Lock()
_checked: Dict[str, datetime] = {}
# The earliest close the provider has for a ticker (it listed later), so a
# window reaching before it doesn't ask again on every request.
_listed_from: Dict[str, date] = {}
_meta: Dict[str, Dict[str, Optional[str]]] = {}
_rate_limited_until: Optional[datetime] = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def retry_after_seconds() -> int:
    if _rate_limited_until and _rate_limited_until > _now():
        return int((_rate_limited_until - _now()).total_seconds()) + 1
    return 2


def _fetch_closes(ticker: str, start: date, end: date) -> List[Tuple[date, float]]:
    if stock_data_client._use_mock():
        history = stock_data_client.mock.get_price_history(ticker, days=(end - start).days + 1)
        rows = [(parse_date(r.get("date")), r.get("close")) for r in history]
        return [(d, float(c)) for d, c in rows if d and c is not None and start <= d <= end]
    stock_data_client._require_real_data_configured()
    return stock_data_client.polygon.get_daily_closes(ticker, start, end)


def _fetch_meta(ticker: str) -> Dict[str, Optional[str]]:
    if stock_data_client._use_mock():
        data = stock_data_client.mock.get_stock_data(ticker) or {}
        return {"name": data.get("name"), "sector": data.get("sector")}
    polygon = stock_data_client.polygon
    try:
        details = polygon._get_ticker_details(ticker)
    except Exception as exc:  # noqa: BLE001 - a name is nice to have
        if "429" in str(exc):
            raise PolygonRateLimited(ticker) from exc
        return {"name": None, "sector": None}
    return {"name": details.get("name"), "sector": polygon._company_metadata(details).get("sector")}


class _Budget:
    def __init__(self, calls: int):
        self.calls = calls

    def spend(self) -> bool:
        global _rate_limited_until
        if _rate_limited_until and _rate_limited_until > _now():
            return False
        if self.calls <= 0:
            return False
        self.calls -= 1
        return True


def _rate_limited() -> None:
    global _rate_limited_until
    _rate_limited_until = _now() + RATE_LIMIT_COOLDOWN
    logger.warning("Price provider rate limit hit; pausing portfolio price fetches")


def _store(db: Session, ticker: str, rows: List[Tuple[date, float]]) -> None:
    if not rows:
        return
    have = {
        d for (d,) in db.query(PriceClose.day).filter(
            PriceClose.ticker == ticker, PriceClose.day >= rows[0][0], PriceClose.day <= rows[-1][0]
        )
    }
    for day, close in rows:
        if day not in have:
            db.add(PriceClose(ticker=ticker, day=day, close=close))
            have.add(day)
    db.commit()


def ensure_closes(db: Session, tickers: List[str], since: date, budget: _Budget) -> Dict[str, str]:
    """Fetch what's missing, within budget. Each ticker comes back "ready"
    (closes cover `since` to recently), "pending" (not fetched yet; ask
    again) or "unavailable" (the provider has nothing for it)."""
    today = utc_today()
    status: Dict[str, str] = {}
    with _lock:  # the breakdown and the chart load together; fetch once
        for ticker in tickers:
            first, last = db.query(
                func.min(PriceClose.day), func.max(PriceClose.day)
            ).filter(PriceClose.ticker == ticker).one()
            listed = _listed_from.get(ticker)
            head_missing = first is None or (first - since).days > STALE_AFTER_DAYS and not (listed and listed >= first)
            checked = _checked.get(ticker)
            tail_due = last is None or (last < today and (not checked or _now() - checked > PRICE_RECHECK))

            if head_missing:
                if not budget.spend():
                    status[ticker] = "pending"
                    continue
                end = today if first is None else first - timedelta(days=1)
                try:
                    rows = _fetch_closes(ticker, since, end)
                except PolygonRateLimited:
                    _rate_limited()
                    status[ticker] = "pending"
                    continue
                except Exception as exc:  # noqa: BLE001 - one bad ticker shouldn't sink the page
                    logger.warning("[%s] daily closes unavailable: %s", ticker, type(exc).__name__)
                    status[ticker] = "unavailable" if first is None else "ready"
                    continue
                _store(db, ticker, rows)
                if first is None and not rows:
                    status[ticker] = "unavailable"
                    _checked[ticker] = _now()
                    continue
                _listed_from[ticker] = rows[0][0] if rows else first
                if first is None:
                    _checked[ticker] = _now()
                    tail_due = False

            elif tail_due and budget.spend():
                try:
                    _store(db, ticker, _fetch_closes(ticker, last + timedelta(days=1), today))
                    _checked[ticker] = _now()
                except PolygonRateLimited:
                    _rate_limited()
                except Exception as exc:  # noqa: BLE001 - keep serving what's stored
                    logger.warning("[%s] daily closes refresh failed: %s", ticker, type(exc).__name__)
            status[ticker] = "ready"
    return status


def _company(db: Session, tickers: List[str], budget: _Budget) -> Dict[str, Dict[str, Optional[str]]]:
    """Name and sector: the stock pages' cache if it has them, else one
    details call each, with whatever budget the prices left over."""
    summaries = {row.ticker: row for row in db.query(StockSummary).filter(StockSummary.ticker.in_(tickers))}
    result = {}
    for ticker in tickers:
        row = summaries.get(ticker)
        if row and row.sector:
            result[ticker] = {"name": row.name, "sector": row.sector}
        elif ticker in _meta:
            result[ticker] = _meta[ticker]
        elif budget.spend():
            try:
                _meta[ticker] = _fetch_meta(ticker)
            except PolygonRateLimited:
                _rate_limited()
                _meta.pop(ticker, None)
            result[ticker] = _meta.get(ticker) or {"name": row.name if row else None, "sector": None}
        else:
            result[ticker] = {"name": row.name if row else None, "sector": None}
    return result


def quotes(db: Session, tickers: List[str]) -> Dict[str, Dict[str, Any]]:
    if not tickers:
        return {}
    budget = _Budget(CALLS_PER_REQUEST)
    status = ensure_closes(db, tickers, utc_today() - timedelta(days=PRICE_HISTORY_DAYS), budget)
    latest = dict(
        db.query(PriceClose.ticker, func.max(PriceClose.day))
        .filter(PriceClose.ticker.in_(tickers)).group_by(PriceClose.ticker).all()
    )
    company = _company(db, tickers, budget)
    stale_before = utc_today() - timedelta(days=STALE_AFTER_DAYS)
    result = {}
    for ticker in tickers:
        day = latest.get(ticker)
        price = None
        if day:
            price = db.query(PriceClose.close).filter(PriceClose.ticker == ticker, PriceClose.day == day).scalar()
        if price is None:
            state = status.get(ticker, "pending")
        elif stock_data_client._use_mock():
            state = "sample"
        else:
            state = "live" if day >= stale_before else "stale"
        result[ticker] = {**company[ticker], "price": price, "status": state, "asOf": day.isoformat() if day else None}
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
        "retryAfter": retry_after_seconds(),
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
        "pending": [], "missing": [], "complete": True, "retryAfter": None,
        "sampleData": stock_data_client._use_mock(),
    }
    if not tickers:
        return base

    status = ensure_closes(db, tickers, start, _Budget(CALLS_PER_REQUEST))
    pending = [t for t, state in status.items() if state == "pending"]
    base["missing"] = [t for t, state in status.items() if state == "unavailable"]
    if pending:
        # Half a line would read as a crash, so draw nothing until every
        # ticker's closes are in. The page asks again.
        return {**base, "pending": pending, "complete": False, "retryAfter": retry_after_seconds()}

    closes: Dict[str, Dict[date, float]] = {}
    trading_days = set()
    for ticker, day, close in (
        db.query(PriceClose.ticker, PriceClose.day, PriceClose.close)
        .filter(PriceClose.ticker.in_(tickers), PriceClose.day >= start)
    ):
        closes.setdefault(ticker, {})[day] = close
        trading_days.add(day)
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
