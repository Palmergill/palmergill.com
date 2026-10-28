"""Personal portfolio: a member's holdings and trades, and the breakdown of both.

Privacy rule: every read and write here takes the caller's username and
filters on it. Nothing in this module ever lists rows across accounts, and a
row that belongs to someone else is a 404, the same as one that doesn't exist.

How the two kinds of upload combine: a holdings upload is a snapshot "as of"
a date and replaces the previous snapshot. Transactions dated after that day
are applied on top of it; ones on or before it are already in the snapshot,
so they are kept for the record but not counted twice. With no snapshot,
every transaction counts.

Positions are per security across every account, at average cost. Account
labels in real exports don't line up (one brokerage's history under two
names, say), so splitting cost basis by account would sell shares an account
never bought; the per-account view is activity, not cost basis.
"""
import csv
import io
import logging
import re
import math
import threading
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app import accounts
from app.database import (
    PortfolioHolding, PortfolioTransaction, PriceBackfill, PriceClose, PriceCoverage, SplitCheck, StockSplit,
    StockSummary,
)
from app.services.polygon_client import PolygonPlanLimited, PolygonRateLimited
from app.services.stock_data_client import stock_data_client
from app.services.tiingo_client import TiingoRateLimited, tiingo_client

logger = logging.getLogger(__name__)

MAX_CSV_CHARS = 5_000_000
MAX_ROWS = 20_000
MAX_TRANSACTIONS = 20_000
EPSILON = 1e-9
# Fewer shares than this left after a sell is rounding between sources, not
# a position: a full sale recorded as 12.04173 against 12.04174 bought.
DUST_SHARES = 1e-4

TICKER_PATTERN = re.compile(r"^[A-Z][A-Z0-9]{0,5}([.\-/][A-Z0-9]{1,3})?$")
NOT_FOUND = "No such transaction."

# Symbols that are crypto wherever they appear. Others count as crypto only
# when the row's account or source says so ("Crypto Account", "BTC log").
ALWAYS_CRYPTO = {"BTC", "ETH", "DOGE", "SHIB"}
CRYPTO_SYMBOLS = ALWAYS_CRYPTO | {
    "SOL", "LTC", "BCH", "ADA", "XRP", "AVAX", "DOT", "LINK", "MATIC", "ETC",
    "XLM", "UNI", "AAVE", "COMP", "USDC", "USDT", "PEPE", "XTZ", "ATOM",
}
CRYPTO_NAMES = {"BTC": "Bitcoin", "ETH": "Ethereum", "DOGE": "Dogecoin", "SOL": "Solana", "LTC": "Litecoin"}


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
    "ticker": ("symbol", "ticker", "tickersymbol", "securitysymbol", "stocksymbol", "security", "instrument", "asset"),
    "shares": ("quantity", "shares", "qty", "units", "sharesquantity", "numberofshares"),
    "price": ("price", "priceusd", "pricepershare", "tradeprice", "executionprice", "shareprice", "fillprice"),
    "cost_basis": ("costbasis", "costbasistotal", "totalcost", "totalcostbasis", "cost"),
    "avg_cost": (
        "averagecost", "avgcost", "averagecostbasis", "avgcostbasis", "costpershare",
        "averageprice", "avgprice", "unitcost",
    ),
    "date": ("tradedate", "date", "transactiondate", "rundate", "activitydate", "settlementdate"),
    "side": ("action", "side", "type", "transactiontype", "activity", "buysell", "activitytype"),
    "fees": (
        "fees", "feesusd", "fee", "commission", "commissions", "feescomm", "commissionfees",
        "commissionsandfees",
    ),
    "amount": ("amount", "amountusd", "netamount", "total", "totalusd", "value"),
    "account": ("account", "accountname", "accountnumber", "portfolio"),
    "source": ("source", "broker", "brokerage", "institution"),
    "notes": ("notes", "note", "description", "memo"),
    "realized": ("realizedgainloss", "realizedgain", "realizedpl", "gainloss", "realized"),
}
DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d", "%d-%b-%Y", "%b %d, %Y")


def _key(cell: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (cell or "").lower())


def _header_map(row: List[str]) -> Dict[str, int]:
    keys = [_key(cell) for cell in row]
    found: Dict[str, int] = {}
    taken = set()
    for field, aliases in COLUMN_ALIASES.items():
        # Alias order is preference order: "Trade Date" beats "Settlement Date".
        for alias in aliases:
            if alias in keys and keys.index(alias) not in taken:
                found[field] = keys.index(alias)
                taken.add(found[field])
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
    if "T" in text[:11] and len(text) > 10:
        text = text[:10]  # an ISO timestamp: the day is enough
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
    if "buy" in text or "bought" in text or "reinvest" in text or "purchase" in text:
        return "buy"
    return None


def _is_cash(raw: str) -> bool:
    return "*" in raw or raw in {"CASH", "PENDING ACTIVITY"} or "CASH" in raw.split()


def clean_ticker(value: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """The ticker, or None and why the row was skipped."""
    raw = (value or "").strip().upper()
    if not raw:
        return None, "no symbol"
    if _is_cash(raw):
        return None, "cash or money market"
    if not TICKER_PATTERN.match(raw):
        return None, f"'{raw[:20]}' isn't a stock symbol"
    return raw.replace("/", "."), None


def classify_security(value: Optional[str], account: str = "", source: str = "") -> Tuple[Optional[str], str, Optional[str]]:
    """(security, asset, reason skipped) for a trade row.

    A trade can name something with no market symbol ("IBIT call $100", a
    company name from the trade description). It's still a real position, so
    it's kept as asset "other" under its own label rather than dropped.
    """
    raw = (value or "").strip()
    upper = raw.upper()
    if not raw:
        return None, "stock", "no symbol"
    if _is_cash(upper):
        return None, "stock", "cash or money market"
    hint = f"{account} {source}".lower()
    crypto_hint = any(word in hint for word in ("crypto", "btc", "bitcoin", "coin"))
    if upper in ALWAYS_CRYPTO or (crypto_hint and upper in CRYPTO_SYMBOLS):
        return upper, "crypto", None
    if TICKER_PATTERN.match(upper):
        return upper.replace("/", "."), "stock", None
    return raw[:60], "other", None


def parse_csv(text: str, kind: str = "auto") -> Dict[str, Any]:
    if len(text) > MAX_CSV_CHARS:
        raise HTTPException(status_code=413, detail="That file is too large. Keep it under 5 MB.")
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
            detail="Couldn't find a header row with a Symbol (or Ticker, or Security) and a Quantity (or Shares) column.",
        )

    if kind == "auto":
        # A trade has a date; a positions export doesn't. (Not "has an Action
        # column": Fidelity's positions export has a "Type" of Cash or Margin.)
        kind = "transactions" if "date" in columns else "holdings"
    body = rows[header_index + 1:]
    if len(body) > MAX_ROWS:
        raise HTTPException(status_code=413, detail=f"That file has more than {MAX_ROWS:,} rows.")

    def cell(row: List[str], field: str) -> Optional[str]:
        index = columns.get(field)
        return row[index] if index is not None and index < len(row) else None

    def text_cell(row: List[str], field: str, limit: int) -> Optional[str]:
        value = (cell(row, field) or "").strip()
        return value[:limit] or None

    parsed: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    for offset, row in enumerate(body):
        line = header_index + offset + 2  # 1-based, and the header is a line
        if not any((c or "").strip() for c in row):
            continue

        if kind == "holdings":
            ticker, reason = clean_ticker(cell(row, "ticker"))
            if not ticker:
                skipped.append({"line": line, "reason": reason})
                continue
            shares = parse_number(cell(row, "shares"))
            if shares is None or abs(shares) < EPSILON:
                skipped.append({"line": line, "reason": "no share count"})
                continue
            cost = parse_number(cell(row, "cost_basis"))
            if cost is None:
                avg = parse_number(cell(row, "avg_cost"))
                cost = avg * abs(shares) if avg is not None else None
            parsed.append({"ticker": ticker, "shares": abs(shares), "cost_basis": abs(cost) if cost is not None else None})
            continue

        account = text_cell(row, "account", 120)
        source = text_cell(row, "source", 120)
        ticker, asset, reason = classify_security(cell(row, "ticker"), account or "", source or "")
        if not ticker:
            skipped.append({"line": line, "reason": reason})
            continue
        shares = parse_number(cell(row, "shares"))
        if shares is None or abs(shares) < EPSILON:
            skipped.append({"line": line, "reason": "no share count"})
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
        amount = parse_number(cell(row, "amount"))
        price = parse_number(cell(row, "price"))
        if price is None and amount is not None:
            price = abs(amount) / shares
        if price is None or price < 0:
            skipped.append({"line": line, "reason": "no price"})
            continue
        parsed.append({
            "ticker": ticker, "asset": asset, "side": side, "shares": shares, "price": abs(price),
            "fees": abs(parse_number(cell(row, "fees")) or 0.0), "trade_date": trade_date,
            "amount": abs(amount) if amount is not None else None,
            "account": account, "source": source,
            "notes": text_cell(row, "notes", 500),
            "realized_reported": parse_number(cell(row, "realized")),
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


# The page's "Try a sample" trades, before they were tagged with a source.
# A real upload on top of exactly these replaces them, so nobody's history
# is quietly mixed with thirteen made-up trades.
_LEGACY_SAMPLE = {
    ("AAPL", "buy", 20.0, 228.0), ("MSFT", "buy", 8.0, 415.0), ("NVDA", "buy", 40.0, 135.0),
    ("JPM", "buy", 15.0, 240.0), ("AAPL", "buy", 15.0, 240.0), ("GOOGL", "buy", 25.0, 170.0),
    ("NVDA", "sell", 15.0, 120.0), ("AMZN", "buy", 20.0, 195.0), ("XOM", "buy", 30.0, 108.0),
    ("MSFT", "buy", 6.0, 455.0), ("JPM", "sell", 5.0, 265.0), ("NVDA", "buy", 20.0, 170.0),
    ("GOOGL", "buy", 10.0, 245.0),
}
SAMPLE_SOURCE = "Sample"


def _trade_key(ticker: str, side: str, shares: float, price: float, day: date, account: Optional[str]) -> tuple:
    return (ticker, side, round(shares, 6), round(price, 4), day, account or "")


def add_transactions(
    db: Session, username: str, rows: List[Dict[str, Any]], replace: bool = False, upload: bool = True,
) -> Dict[str, int]:
    """Save trades. From an upload, rows identical to one already saved are
    skipped, so the same export twice doesn't double it, and the sample's
    trades make way for real ones. A trade added by hand is just added."""
    query = db.query(PortfolioTransaction).filter(PortfolioTransaction.username == username)
    existing = query.all()
    removed_sample = 0
    is_sample_upload = rows and all(r.get("source") == SAMPLE_SOURCE for r in rows)
    if upload and not replace and existing and not is_sample_upload:
        legacy = {(t.ticker, t.side, t.shares, t.price) for t in existing}
        if all(t.source == SAMPLE_SOURCE for t in existing) or (
            len(existing) == len(_LEGACY_SAMPLE) and legacy == _LEGACY_SAMPLE and not any(t.source for t in existing)
        ):
            replace, removed_sample = True, len(existing)
        else:
            sample_rows = [t for t in existing if t.source == SAMPLE_SOURCE]
            for t in sample_rows:
                db.delete(t)
            removed_sample = len(sample_rows)
            existing = [t for t in existing if t.source != SAMPLE_SOURCE]
    if replace:
        query.delete()
        existing = []

    seen = {_trade_key(t.ticker, t.side, t.shares, t.price, t.trade_date, t.account) for t in existing}
    fresh = rows if not upload else [
        r for r in rows
        if _trade_key(r["ticker"], r["side"], r["shares"], r["price"], r["trade_date"], r.get("account")) not in seen
    ]
    if len(existing) + len(fresh) > MAX_TRANSACTIONS:
        db.rollback()
        raise HTTPException(status_code=422, detail=f"A portfolio holds up to {MAX_TRANSACTIONS:,} transactions.")
    db.bulk_insert_mappings(PortfolioTransaction, [{"username": username, "asset": "stock", **row} for row in fresh])
    db.commit()
    return {"added": len(fresh), "duplicates": len(rows) - len(fresh), "removedSample": removed_sample}


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


def _load(db: Session, username: str) -> Tuple[List[PortfolioHolding], List[PortfolioTransaction]]:
    holdings = db.query(PortfolioHolding).filter(PortfolioHolding.username == username).all()
    transactions = (
        db.query(PortfolioTransaction)
        .filter(PortfolioTransaction.username == username)
        .order_by(PortfolioTransaction.trade_date, PortfolioTransaction.id)
        .all()
    )
    return holdings, transactions


def build_positions(
    holdings: List[PortfolioHolding], transactions: List[PortfolioTransaction]
) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Any]]:
    """Fold the snapshot and the later trades into positions, at average cost.

    `cost` is None for a position whose cost the statement didn't give, and
    stays None: a gain on top of an unknown basis would be invented. Each
    position also keeps its trade history in brief (first and last trade,
    totals bought and sold), and each counted sell's realized gain is kept by
    transaction id and by year.
    """
    as_of = holdings[0].as_of if holdings else None
    positions: Dict[str, Dict[str, Any]] = {}

    def blank(ticker: str, asset: str = "stock") -> Dict[str, Any]:
        return {
            "shares": 0.0, "cost": 0.0, "realized": 0.0, "asset": asset, "trades": 0,
            "bought": 0.0, "sold": 0.0, "first": None, "last": None, "lastPrice": None,
            "lastTradeDate": None, "realizedCounted": False,
        }

    for holding in holdings:
        positions[holding.ticker] = {**blank(holding.ticker), "shares": holding.shares, "cost": holding.cost_basis}

    counted = ignored = sells = 0
    oversold: List[str] = []
    realized_by_tx: Dict[int, float] = {}
    by_year: Dict[int, Dict[str, float]] = {}
    for tx in sorted(transactions, key=lambda t: (t.trade_date, t.id)):
        position = positions.setdefault(tx.ticker, blank(tx.ticker, tx.asset or "stock"))
        position["asset"] = tx.asset or position["asset"]
        position["trades"] += 1
        position["first"] = position["first"] or tx.trade_date
        position["last"] = tx.trade_date
        position["lastPrice"], position["lastTradeDate"] = tx.price, tx.trade_date
        value = tx.shares * tx.price
        year = by_year.setdefault(tx.trade_date.year, {"bought": 0.0, "sold": 0.0, "realized": 0.0, "trades": 0, "fees": 0.0})
        year["trades"] += 1
        year["fees"] += tx.fees or 0.0
        year["bought" if tx.side == "buy" else "sold"] += value
        position["bought" if tx.side == "buy" else "sold"] += value

        if as_of and tx.trade_date <= as_of:
            ignored += 1
            continue
        counted += 1
        if tx.side == "buy":
            position["shares"] += tx.shares
            if position["cost"] is not None:
                position["cost"] += value + (tx.fees or 0.0)
            continue

        sells += 1
        sold = min(tx.shares, position["shares"])
        if tx.shares - sold > EPSILON and tx.ticker not in oversold:
            oversold.append(tx.ticker)
        if position["cost"] is None:
            # A snapshot with no cost basis: any gain would be invented.
            position["realized"] = None
        elif position["shares"] > EPSILON:
            average = position["cost"] / position["shares"]
            position["cost"] -= average * sold
            gain = sold * tx.price - (tx.fees or 0.0) - average * sold
            realized_by_tx[tx.id] = gain
            year["realized"] += gain
            if position["realized"] is not None:
                position["realized"] += gain
                position["realizedCounted"] = True
        # else: nothing on record to sell (it's in `oversold`); later sells of
        # shares that were bought still count.
        position["shares"] -= sold
        if position["shares"] < DUST_SHARES:
            position["shares"] = 0.0
            if position["cost"] is not None:
                position["cost"] = 0.0

    return positions, {
        "as_of": as_of, "counted": counted, "ignored": ignored, "sells": sells,
        "oversold": oversold, "realized_by_tx": realized_by_tx, "by_year": by_year,
    }


# ── prices ──────────────────────────────────────────────────────────────────
#
# Every market price here is a daily close from one provider call per symbol:
# a range of daily bars. The newest close is a position's price and the rest
# draw the value chart. Closes are stored in `price_closes`, and which days
# have been asked about in `price_coverage`, so after the first fill a symbol
# costs one small call a few times a day and history the plan can't serve is
# never asked for twice. The provider plan allows only a handful of calls a
# minute: each request spends at most CALLS_PER_REQUEST, and a 429 stops all
# fetching for a minute and leaves the rest "pending", which the page asks
# about again after `retryAfter` seconds.
#
# Where there's no close — a day older than the plan's history, a position
# with no market symbol — the position is valued at its own last trade price,
# and the page labels that as an estimate.

CALLS_PER_REQUEST = 4
# How long a symbol's newest close counts as current before asking for more.
PRICE_RECHECK = timedelta(hours=4)
RATE_LIMIT_COOLDOWN = timedelta(seconds=65)
# A close this many days old (a long weekend, a holiday) is still current.
STALE_AFTER_DAYS = 5
# Short-history plans refuse a range that starts further back than this.
PLAN_HISTORY_DAYS = 729

_lock = threading.Lock()
_meta: Dict[str, Dict[str, Optional[str]]] = {}
_rate_limited_until: Optional[datetime] = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _naive_now() -> datetime:
    return _now().replace(tzinfo=None)


def retry_after_seconds() -> int:
    if _rate_limited_until and _rate_limited_until > _now():
        return int((_rate_limited_until - _now()).total_seconds()) + 1
    return 2


def market_symbol(ticker: str, asset: str) -> Optional[str]:
    """The provider's symbol for a position, or None if it has none."""
    if asset == "crypto":
        return f"X:{ticker}USD"
    if asset == "other":
        return None
    return ticker


def _coingecko_closes(start: date, end: date) -> List[Tuple[date, float]]:
    """Bitcoin's daily closes from CoinGecko, which the Bitcoin page already
    uses; its free tier covers the last year."""
    from app.services.bitcoin_coingecko import CoinGeckoClient

    days = min(365, max(1, (utc_today() - start).days + 1))
    data = CoinGeckoClient().get_market_chart(days)
    closes: Dict[date, float] = {}
    for stamp, price in data.get("prices") or []:
        day = datetime.fromtimestamp(stamp / 1000, tz=timezone.utc).date()
        if start <= day <= end:
            closes[day] = float(price)
    return sorted(closes.items())


def _fetch_closes(symbol: str, start: date, end: date) -> List[Tuple[date, float]]:
    if stock_data_client._use_mock():
        history = stock_data_client.mock.get_price_history(symbol.replace("X:", "").replace("USD", "") if symbol.startswith("X:") else symbol, days=min(4000, (end - start).days + 1))
        rows = [(parse_date(r.get("date")), r.get("close")) for r in history]
        return [(d, float(c)) for d, c in rows if d and c is not None and start <= d <= end]
    stock_data_client._require_real_data_configured()
    try:
        return stock_data_client.polygon.get_daily_closes(symbol, start, end)
    except PolygonRateLimited:
        raise
    except Exception:
        if symbol == "X:BTCUSD":
            return _coingecko_closes(start, end)
        raise


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


def _store(db: Session, symbol: str, rows: List[Tuple[date, float]]) -> None:
    if not rows:
        return
    have = {
        d for (d,) in db.query(PriceClose.day).filter(
            PriceClose.ticker == symbol, PriceClose.day >= rows[0][0], PriceClose.day <= rows[-1][0]
        )
    }
    fresh = []
    for day, close in rows:
        if day not in have:
            fresh.append({"ticker": symbol, "day": day, "close": close})
            have.add(day)
    if fresh:
        db.bulk_insert_mappings(PriceClose, fresh)
    db.commit()


def _fetch_range(db: Session, symbol: str, start: date, end: date, budget: _Budget) -> Optional[str]:
    """Fetch and store one range. Returns None on success, or "pending" /
    "failed". A plan that can't reach `start` is asked again from as far back
    as it can go."""
    if start > end:
        return None
    if not budget.spend():
        return "pending"
    try:
        rows = _fetch_closes(symbol, start, end)
    except PolygonRateLimited:
        _rate_limited()
        return "pending"
    except PolygonPlanLimited:
        floor = utc_today() - timedelta(days=PLAN_HISTORY_DAYS)
        if start >= floor or floor > end:
            return "failed"
        return _fetch_range(db, symbol, floor, end, budget)
    except Exception as exc:  # noqa: BLE001 - one bad symbol shouldn't sink the page
        logger.warning("[%s] daily closes unavailable: %s", symbol, type(exc).__name__)
        return "failed"
    _store(db, symbol, rows)
    return None


def ensure_closes(db: Session, wants: Dict[str, Tuple[date, date]], budget: _Budget) -> Dict[str, str]:
    """For each symbol, make sure closes for its (from, to) window have been
    asked for, within budget. Symbols come back "ready" (asked; whatever the
    provider had is stored) or "pending" (not asked yet; ask again)."""
    today = utc_today()
    status: Dict[str, str] = {}
    with _lock:  # the breakdown and the chart load together; fetch once
        coverage = {c.symbol: c for c in db.query(PriceCoverage).filter(PriceCoverage.symbol.in_(list(wants)))}
        for symbol, (start, end) in wants.items():
            end = min(end, today)
            row = coverage.get(symbol)
            if row is None:
                outcome = _fetch_range(db, symbol, start, end, budget)
                if outcome == "pending":
                    status[symbol] = "pending"
                    continue
                # A failed first fetch is recorded as asked-for-nothing, so it's
                # tried again after PRICE_RECHECK rather than on every request.
                asked_to = end if outcome is None else start - timedelta(days=1)
                db.add(PriceCoverage(symbol=symbol, requested_from=start, requested_to=asked_to, checked_at=_naive_now()))
                db.commit()
                status[symbol] = "ready"
                continue

            pending = False
            if start < row.requested_from - timedelta(days=STALE_AFTER_DAYS):
                outcome = _fetch_range(db, symbol, start, row.requested_from - timedelta(days=1), budget)
                if outcome == "pending":
                    pending = True
                else:
                    row.requested_from = start
            due = _naive_now() - row.checked_at > PRICE_RECHECK
            if not pending and due and (end > row.requested_to or end >= today - timedelta(days=1)):
                last = db.query(func.max(PriceClose.day)).filter(PriceClose.ticker == symbol).scalar()
                begin = (last + timedelta(days=1)) if last else row.requested_to + timedelta(days=1)
                outcome = _fetch_range(db, symbol, max(begin, row.requested_from), end, budget) if begin <= end else None
                if outcome == "pending":
                    pending = True
                else:
                    row.requested_to = max(row.requested_to, end)
                    row.checked_at = _naive_now()
            db.commit()
            status[symbol] = "pending" if pending else "ready"
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


def quotes(db: Session, positions: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Price and name for each open position. Fetches each symbol's closes
    back to its first trade in the same call, so the chart rarely needs
    another."""
    if not positions:
        return {}
    budget = _Budget(CALLS_PER_REQUEST)
    today = utc_today()
    symbols = {t: market_symbol(t, p["asset"]) for t, p in positions.items()}
    wants = {
        s: (p["first"] or today - timedelta(days=365), today)
        for t, p in positions.items() if (s := symbols[t])
    }
    status = ensure_closes(db, wants, budget)
    latest = dict(
        db.query(PriceClose.ticker, func.max(PriceClose.day))
        .filter(PriceClose.ticker.in_(list(wants))).group_by(PriceClose.ticker).all()
    )
    stocks = [t for t, p in positions.items() if p["asset"] == "stock"]
    company = _company(db, stocks, budget)
    stale_before = today - timedelta(days=STALE_AFTER_DAYS)
    result = {}
    for ticker, position in positions.items():
        symbol = symbols[ticker]
        day = latest.get(symbol) if symbol else None
        price = prev = None
        if day:
            price = db.query(PriceClose.close).filter(PriceClose.ticker == symbol, PriceClose.day == day).scalar()
            # The close before it, for the day's change.
            prev = (
                db.query(PriceClose.day, PriceClose.close)
                .filter(PriceClose.ticker == symbol, PriceClose.day < day)
                .order_by(PriceClose.day.desc()).first()
            )
        if position["asset"] == "crypto":
            info = {"name": CRYPTO_NAMES.get(ticker, ticker), "sector": "Crypto"}
        elif position["asset"] == "other":
            info = {"name": None, "sector": "Other holdings"}
        else:
            info = company.get(ticker, {"name": None, "sector": None})

        if price is not None:
            state = "sample" if stock_data_client._use_mock() else ("live" if day >= stale_before else "stale")
        elif symbol and status.get(symbol) == "pending":
            state = "pending"
        elif position["lastPrice"] is not None:
            # No market price to be had: value it at the last trade.
            price, day, state = position["lastPrice"], position["lastTradeDate"], "trade"
        else:
            state = "unavailable"
        result[ticker] = {
            **info, "price": price, "status": state, "asOf": day.isoformat() if day else None,
            "day": day, "prevClose": prev[1] if prev and state != "trade" else None,
        }
    return result


# ── stock splits ────────────────────────────────────────────────────────────
#
# A trade from before a split is recorded in the old shares: 10 NVDA bought
# in 2017 are 400 today. Trades are stored exactly as uploaded and adjusted
# when read, so every share count, average cost and chart point is in
# today's shares (which is also how the provider's closes are adjusted).
# Splits come from the provider, one call per ticker, rechecked weekly; until
# it answers, a built-in list of well-known splits stands in.
#
# Some sources adjust old trades themselves. A trade whose price already
# matches that day's split-adjusted close is left alone rather than
# adjusted twice.

SPLIT_RECHECK = timedelta(days=7)
SPLIT_CALLS_PER_REQUEST = 2
# (ticker, execution date, split_from, split_to)
KNOWN_SPLITS = [
    ("AAPL", date(2020, 8, 31), 1, 4),
    ("TSLA", date(2020, 8, 31), 1, 5), ("TSLA", date(2022, 8, 25), 1, 3),
    ("NVDA", date(2021, 7, 20), 1, 4), ("NVDA", date(2024, 6, 10), 1, 10),
    ("AMZN", date(2022, 6, 6), 1, 20),
    ("GOOGL", date(2022, 7, 18), 1, 20), ("GOOG", date(2022, 7, 18), 1, 20),
    ("SHOP", date(2022, 6, 29), 1, 10),
    ("AVGO", date(2024, 7, 15), 1, 10),
    ("CMG", date(2024, 6, 26), 1, 50),
    ("WMT", date(2024, 2, 26), 1, 3),
    ("SCHD", date(2024, 10, 11), 1, 3),
    ("SMCI", date(2024, 10, 1), 1, 10),
    ("LRCX", date(2024, 10, 3), 1, 10),
    ("MSTR", date(2024, 8, 8), 1, 10),
    ("NFLX", date(2025, 11, 17), 1, 10),
]


def _fetch_splits(ticker: str) -> List[Tuple[date, float, float]]:
    if stock_data_client._use_mock():
        return [(d, f, t) for k, d, f, t in KNOWN_SPLITS if k == ticker]
    stock_data_client._require_real_data_configured()
    return stock_data_client.polygon.get_splits(ticker)


def ensure_splits(db: Session, tickers: List[str], budget: _Budget) -> None:
    """Ask the provider for each stock's splits once a week, within budget."""
    checks = {c.ticker: c for c in db.query(SplitCheck).filter(SplitCheck.ticker.in_(tickers))}
    for ticker in tickers:
        check = checks.get(ticker)
        if check and _naive_now() - check.checked_at < SPLIT_RECHECK:
            continue
        if not budget.spend():
            return
        try:
            found = _fetch_splits(ticker)
        except PolygonRateLimited:
            _rate_limited()
            return
        except Exception as exc:  # noqa: BLE001 - the built-in list stands in
            logger.warning("[%s] splits unavailable: %s", ticker, type(exc).__name__)
            found = None
        if found is not None:
            db.query(StockSplit).filter(StockSplit.ticker == ticker).delete()
            for day, split_from, split_to in found:
                db.add(StockSplit(ticker=ticker, execution_date=day, split_from=split_from, split_to=split_to))
        if check is None:
            check = SplitCheck(ticker=ticker, checked_at=_naive_now(), found=found is not None)
            db.add(check)
            checks[ticker] = check
        else:
            check.checked_at = _naive_now()
            check.found = check.found or found is not None
        db.commit()


def splits_for(db: Session, tickers: List[str]) -> Dict[str, List[Tuple[date, float]]]:
    """Each ticker's splits as (execution date, new shares per old share):
    the provider's where it has answered, else the built-in list."""
    answered = {c.ticker for c in db.query(SplitCheck).filter(SplitCheck.ticker.in_(tickers), SplitCheck.found.is_(True))}
    result: Dict[str, List[Tuple[date, float]]] = {}
    for row in db.query(StockSplit).filter(StockSplit.ticker.in_(list(answered))):
        if row.split_from > 0 and row.split_to > 0:
            result.setdefault(row.ticker, []).append((row.execution_date, row.split_to / row.split_from))
    for ticker, day, split_from, split_to in KNOWN_SPLITS:
        if ticker in tickers and ticker not in answered:
            result.setdefault(ticker, []).append((day, split_to / split_from))
    return {t: sorted(v) for t, v in result.items()}


def _split_factor(splits: List[Tuple[date, float]], day: date) -> float:
    # A split takes effect from the open on its execution date, so a trade
    # on that day is already in the new shares.
    factor = 1.0
    for execution_date, ratio in splits:
        if execution_date > day:
            factor *= ratio
    return factor


def _already_adjusted(price: float, factor: float, close: Optional[float]) -> bool:
    """True when the trade's price sits nearer the split-adjusted close than
    the unadjusted one would: the source has adjusted it already."""
    if not close or price <= 0:
        return False
    ratio = price / close
    return abs(math.log(ratio)) < abs(math.log(ratio / factor))


# ── duplicates across sources ───────────────────────────────────────────────
#
# A history merged from several feeds often has one trade twice: once from a
# brokerage feed and once from an older export of the same account. The two
# copies rarely match exactly (a price a cent apart, a settlement date a day
# or three after the trade date), so an exact-match dedupe lets them through
# and the shares count double. When reading, two rows from different
# sources or accounts with the same security, side and quantity, prices
# within a cent or two and dates a few days apart are treated as one trade:
# the earlier is counted and the other is marked as its duplicate. Rows from
# the same source and account are never paired, since a repeated buy there is
# real. Nothing stored is changed.

DUPLICATE_DAYS = 4


def _same_amount(a: float, b: float) -> bool:
    return abs(a - b) <= max(1e-6, 1e-6 * max(abs(a), abs(b)))


def _same_price(a: float, b: float) -> bool:
    return abs(a - b) <= max(0.02, 0.002 * max(a, b))


def find_duplicates(transactions: List[Any], across_labels: bool = False) -> Dict[int, Any]:
    """Map each duplicate trade's id to the trade it duplicates. With
    `across_labels`, trades pair whatever security they're filed under."""
    groups: Dict[Tuple[str, str], List[Any]] = {}
    for tx in transactions:
        groups.setdefault(("*" if across_labels else tx.ticker, tx.side), []).append(tx)
    duplicates: Dict[int, Any] = {}
    paired = set()
    for group in groups.values():
        group.sort(key=lambda t: (t.trade_date, t.id))
        for i, first in enumerate(group):
            if first.id in paired:
                continue
            origin = (first.source or "", first.account or "")
            for second in group[i + 1:]:
                if (second.trade_date - first.trade_date).days > DUPLICATE_DAYS:
                    break
                if second.id in paired or (second.source or "", second.account or "") == origin:
                    continue
                if _same_amount(first.shares, second.shares) and _same_price(first.price, second.price):
                    paired.update({first.id, second.id})
                    duplicates[second.id] = first
                    break
    return duplicates


def find_aliases(transactions: List[Any]) -> Dict[str, str]:
    """Names that are really tickers: {"Twenty One Capital": "XXI"}.

    One feed can label a security by name where another export gives its
    ticker, so the same buys show up under both and neither label holds the
    whole position. A name is taken to be a ticker when at least two of its
    trades repeat that ticker's trades from another source (same side and
    quantity, prices within a cent or two, dates a few days apart), and those
    repeats are at least half of the smaller side's trades.
    """
    named: Dict[str, List[Any]] = {}
    tickers: Dict[str, List[Any]] = {}
    for tx in transactions:
        (named if tx.asset == "other" else tickers).setdefault(tx.ticker, []).append(tx)
    aliases: Dict[str, str] = {}
    for name, own in named.items():
        best, best_pairs = None, 0
        for ticker, theirs in tickers.items():
            # Only pairs with one trade under each label say they're the same
            # security; a ticker's own repeats across feeds say nothing.
            pairs = sum(
                1 for dup_id, kept in find_duplicates(own + theirs, across_labels=True).items()
                if (kept.ticker == name) != (dup_id in {t.id for t in own})
            )
            if pairs > best_pairs:
                best, best_pairs = ticker, pairs
        if best and best_pairs >= 2 and best_pairs * 2 >= min(len(own), len(tickers[best])):
            aliases[name] = best
    return aliases


def load_adjusted(db: Session, username: str, budget: Optional[_Budget] = None) -> Tuple[list, list, Dict[str, Any]]:
    """Holdings and trades in today's shares, without cross-source duplicates,
    plus what was adjusted and what was left out."""
    holdings, rows = _load(db, username)
    # Plain copies: the stored rows are never changed by what follows.
    stored = [
        SimpleNamespace(
            id=t.id, ticker=t.ticker, asset=t.asset or "stock", side=t.side, trade_date=t.trade_date,
            shares=t.shares, price=t.price, fees=t.fees or 0.0, account=t.account, source=t.source,
            notes=t.notes, amount=t.amount, realized_reported=t.realized_reported, label=t.ticker,
        )
        for t in rows
    ]
    aliases = find_aliases(stored)
    for tx in stored:
        if tx.ticker in aliases:
            tx.ticker, tx.asset = aliases[tx.ticker], "stock"
    duplicates = find_duplicates(stored)
    transactions = [t for t in stored if t.id not in duplicates]
    stocks = sorted({t.ticker for t in transactions if (t.asset or "stock") == "stock"} | {h.ticker for h in holdings})
    if budget is not None and stocks:
        ensure_splits(db, stocks, budget)
    splits = splits_for(db, stocks)

    # Closes near each pre-split trade, to spot trades already adjusted.
    affected = {t.ticker for t in transactions if t.ticker in splits and _split_factor(splits[t.ticker], t.trade_date) != 1.0}
    closes: Dict[str, List[Tuple[date, float]]] = {}
    if affected and not stock_data_client._use_mock():
        for ticker, day, close in (
            db.query(PriceClose.ticker, PriceClose.day, PriceClose.close)
            .filter(PriceClose.ticker.in_(list(affected))).order_by(PriceClose.day)
        ):
            closes.setdefault(ticker, []).append((day, close))

    def close_near(ticker: str, day: date) -> Optional[float]:
        best = None
        for close_day, close in closes.get(ticker, []):
            if close_day > day:
                break
            if (day - close_day).days <= STALE_AFTER_DAYS:
                best = close
        return best

    adjusted_trades = []
    applied: Dict[Tuple[str, date], Dict[str, Any]] = {}
    already = 0
    for tx in transactions:
        factor = _split_factor(splits.get(tx.ticker, []), tx.trade_date) if (tx.asset or "stock") == "stock" else 1.0
        if factor != 1.0 and _already_adjusted(tx.price, factor, close_near(tx.ticker, tx.trade_date)):
            factor, already = 1.0, already + 1
        view = SimpleNamespace(
            id=tx.id, ticker=tx.ticker, asset=tx.asset or "stock", side=tx.side, trade_date=tx.trade_date,
            shares=tx.shares * factor, price=tx.price / factor, fees=tx.fees or 0.0,
            account=tx.account, source=tx.source, notes=tx.notes, amount=tx.amount,
            realized_reported=tx.realized_reported, split_factor=factor,
            original_shares=tx.shares, original_price=tx.price,
        )
        adjusted_trades.append(view)
        if factor != 1.0:
            for execution_date, ratio in splits[tx.ticker]:
                if execution_date > tx.trade_date:
                    entry = applied.setdefault((tx.ticker, execution_date), {
                        "ticker": tx.ticker, "date": execution_date.isoformat(), "ratio": ratio, "trades": 0,
                    })
                    entry["trades"] += 1

    as_of = holdings[0].as_of if holdings else None
    adjusted_holdings = []
    for h in holdings:
        # A snapshot is in its own day's shares; later splits still apply.
        factor = 1.0
        for execution_date, ratio in splits.get(h.ticker, []):
            if as_of and execution_date > as_of:
                factor *= ratio
        adjusted_holdings.append(SimpleNamespace(
            ticker=h.ticker, shares=h.shares * factor, cost_basis=h.cost_basis, as_of=h.as_of,
        ))

    pair_counts: Dict[Tuple[str, str], int] = {}
    for dup_id, kept in duplicates.items():
        dup = next(t for t in stored if t.id == dup_id)
        key = (_label(dup.source, "No source"), _label(kept.source, "No source"))
        pair_counts[key] = pair_counts.get(key, 0) + 1
    info = {
        "applied": sorted(applied.values(), key=lambda a: a["date"], reverse=True),
        "tradesAdjusted": sum(1 for t in adjusted_trades if t.split_factor != 1.0),
        "alreadyAdjusted": already,
        "duplicates": {
            dup_id: {"id": kept.id, "source": kept.source, "account": kept.account, "date": kept.trade_date.isoformat()}
            for dup_id, kept in duplicates.items()
        },
        "aliases": [{"name": name, "ticker": ticker} for name, ticker in sorted(aliases.items())],
        "duplicatePairs": [
            {"duplicateSource": a, "keptSource": b, "count": n}
            for (a, b), n in sorted(pair_counts.items(), key=lambda kv: -kv[1])
        ],
    }
    return adjusted_holdings, adjusted_trades, info


# ── the breakdown ───────────────────────────────────────────────────────────


def _ratio(numerator: Optional[float], denominator: Optional[float]) -> Optional[float]:
    if numerator is None or not denominator:
        return None
    return numerator / denominator


def _label(value: Optional[str], fallback: str) -> str:
    return (value or "").strip() or fallback


def _activity_summary(transactions: List[PortfolioTransaction], field: str, fallback: str) -> List[Dict[str, Any]]:
    groups: Dict[str, Dict[str, Any]] = {}
    for tx in transactions:
        name = _label(getattr(tx, field), fallback)
        entry = groups.setdefault(name, {
            "name": name, "trades": 0, "buys": 0, "sells": 0, "bought": 0.0, "sold": 0.0, "fees": 0.0,
            "first": tx.trade_date, "last": tx.trade_date, "securities": set(), "realizedReported": None,
        })
        entry["trades"] += 1
        value = tx.shares * tx.price
        if tx.side == "buy":
            entry["buys"] += 1
            entry["bought"] += value
        else:
            entry["sells"] += 1
            entry["sold"] += value
        entry["fees"] += tx.fees or 0.0
        entry["first"] = min(entry["first"], tx.trade_date)
        entry["last"] = max(entry["last"], tx.trade_date)
        entry["securities"].add(tx.ticker)
        if tx.realized_reported is not None:
            entry["realizedReported"] = (entry["realizedReported"] or 0.0) + tx.realized_reported
    rows = []
    for entry in groups.values():
        rows.append({
            **entry, "securities": len(entry["securities"]), "net": entry["bought"] - entry["sold"],
            "first": entry["first"].isoformat(), "last": entry["last"].isoformat(),
        })
    return sorted(rows, key=lambda r: -r["trades"])


def _day_change(shares: float, price: float, prev_close: float, trades: List[Any]) -> Tuple[float, float]:
    """(change, base) for a position over its latest day. Shares bought that
    day count from their buy price, not the close before; shares sold that day
    count to their sell price. The base is what the change is a percent of."""
    bought_shares = sold_shares = bought = change = 0.0
    for tx in trades:
        if tx.side == "buy":
            bought_shares += tx.shares
            bought += tx.shares * tx.price
            change += tx.shares * (price - tx.price)
        else:
            sold_shares += tx.shares
            change += tx.shares * (tx.price - prev_close)
    # Held through the day: everything now that wasn't bought today.
    change += max(shares - bought_shares, 0.0) * (price - prev_close)
    start_shares = max(shares - bought_shares + sold_shares, 0.0)
    return change, start_shares * prev_close + bought


def breakdown(db: Session, username: str) -> Dict[str, Any]:
    holdings, transactions, split_info = load_adjusted(db, username, _Budget(SPLIT_CALLS_PER_REQUEST))
    positions, meta = build_positions(holdings, transactions)
    open_positions = {t: p for t, p in positions.items() if p["shares"] > EPSILON}
    prices = quotes(db, open_positions)

    rows: List[Dict[str, Any]] = []
    for ticker, position in open_positions.items():
        quote = prices[ticker]
        value = position["shares"] * quote["price"] if quote["price"] is not None else None
        day_change = day_change_pct = None
        if value is not None and quote["prevClose"]:
            day_change, base = _day_change(position["shares"], quote["price"], quote["prevClose"], [
                t for t in transactions if t.ticker == ticker and t.trade_date == quote["day"]
            ])
            day_change_pct = _ratio(day_change, base)
        cost = position["cost"]
        gain = value - cost if value is not None and cost is not None else None
        rows.append({
            "ticker": ticker,
            "asset": position["asset"],
            "name": quote["name"],
            "sector": quote["sector"] if quote["sector"] not in (None, "", "-") else None,
            "shares": position["shares"],
            "price": quote["price"],
            "priceStatus": quote["status"],
            "priceAsOf": quote["asOf"],
            "marketValue": value,
            "prevClose": quote["prevClose"],
            "dayChange": day_change,
            "dayChangePct": day_change_pct,
            "costBasis": cost,
            "avgCost": _ratio(cost, position["shares"]),
            "gain": gain,
            "gainPct": _ratio(gain, cost),
            "realizedGain": position["realized"] if position["realizedCounted"] else None,
            "firstTrade": position["first"].isoformat() if position["first"] else None,
            "trades": position["trades"],
            "weight": None,
        })

    total_value = sum(r["marketValue"] for r in rows if r["marketValue"] is not None)
    for row in rows:
        row["weight"] = _ratio(row["marketValue"], total_value)
    rows.sort(key=lambda r: (r["marketValue"] is None, -(r["marketValue"] or 0), r["ticker"]))

    closed = sorted((
        {
            "ticker": ticker, "asset": p["asset"], "trades": p["trades"],
            "bought": p["bought"], "sold": p["sold"],
            "realizedGain": p["realized"] if p["realizedCounted"] else None,
            "first": p["first"].isoformat() if p["first"] else None,
            "last": p["last"].isoformat() if p["last"] else None,
        }
        for ticker, p in positions.items() if p["shares"] <= EPSILON and p["trades"]
    ), key=lambda r: r["last"] or "", reverse=True)

    # Gain only over positions that have both a price and a known basis, so a
    # missing price never reads as a loss.
    comparable = [r for r in rows if r["gain"] is not None]
    cost_total = sum(r["costBasis"] for r in comparable)
    gain_total = sum(r["gain"] for r in comparable)
    realized_total = sum(meta["realized_by_tx"].values())

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

    # The day's change over positions that have one; its percent is of what
    # they were worth at the close before (plus anything bought that day).
    moved = [r for r in rows if r["dayChange"] is not None]
    day_total = sum(r["dayChange"] for r in moved)
    day_base = sum(r["dayChange"] / r["dayChangePct"] for r in moved if r["dayChangePct"])
    day_dates = Counter(prices[r["ticker"]]["asOf"] for r in moved)

    reported = [t for t in transactions if t.realized_reported is not None]
    years = [
        {"year": year, **stats, "net": stats["bought"] - stats["sold"]}
        for year, stats in sorted(meta["by_year"].items(), reverse=True)
    ]
    realized_by_ticker = sorted(
        ({"ticker": t, "realizedGain": p["realized"], "sold": p["sold"]} for t, p in positions.items() if p["realizedCounted"]),
        key=lambda r: -abs(r["realizedGain"] or 0),
    )

    as_of = meta["as_of"]
    return {
        "totals": {
            "marketValue": total_value,
            "costBasis": cost_total,
            "gain": gain_total if comparable else None,
            "gainPct": _ratio(gain_total, cost_total) if comparable else None,
            # None, not $0, until a counted sell has realized something.
            "realizedGain": realized_total if meta["realized_by_tx"] else None,
            "dayChange": day_total if moved else None,
            "dayChangePct": _ratio(day_total, day_base) if moved else None,
            # Most positions' latest close; crypto can be a day ahead.
            "dayChangeAsOf": day_dates.most_common(1)[0][0] if moved else None,
            "positions": len(rows),
            "pricedPositions": sum(1 for r in rows if r["marketValue"] is not None),
            "pendingPrices": sum(1 for r in rows if r["priceStatus"] == "pending"),
            "estimatedPositions": sum(1 for r in rows if r["priceStatus"] == "trade"),
            "closedPositions": len(closed),
            "invested": sum(t.shares * t.price for t in transactions if t.side == "buy"),
            "withdrawn": sum(t.shares * t.price for t in transactions if t.side == "sell"),
            "fees": sum(t.fees or 0.0 for t in transactions),
        },
        "retryAfter": retry_after_seconds(),
        "positions": rows,
        "closedPositions": closed,
        "sectors": sector_rows,
        "holdings": {"count": len(holdings), "asOf": as_of.isoformat() if as_of else None},
        "transactionCount": len(transactions),
        # Changes whenever the trades do; the page reloads the chart on it.
        "transactionVersion": f"{len(transactions)}:{max((t.id for t in transactions), default=0)}",
        "firstTrade": transactions[0].trade_date.isoformat() if transactions else None,
        "lastTrade": transactions[-1].trade_date.isoformat() if transactions else None,
        "transactionsIgnored": meta["ignored"],
        "oversold": meta["oversold"],
        "accounts": _activity_summary(transactions, "account", "No account"),
        "sources": _activity_summary(transactions, "source", "No source"),
        "years": years,
        "realizedByTicker": realized_by_ticker,
        "reportedRealized": {
            "count": len(reported),
            "reported": sum(t.realized_reported for t in reported) if reported else None,
            # The page's own figure for the same sells, to set beside it.
            "computed": sum(meta["realized_by_tx"].get(t.id, 0.0) for t in reported) if reported else None,
        },
        "splits": {k: v for k, v in split_info.items() if k not in ("duplicates", "duplicatePairs", "aliases")},
        "aliases": split_info["aliases"],
        "duplicates": {"count": len(split_info["duplicates"]), "pairs": split_info["duplicatePairs"]},
        "facets": {
            "accounts": sorted({_label(t.account, "No account") for t in transactions}),
            "sources": sorted({_label(t.source, "No source") for t in transactions}),
            "years": sorted({t.trade_date.year for t in transactions}, reverse=True),
            "assets": sorted({t.asset or "stock" for t in transactions}),
        },
        "sampleData": stock_data_client._use_mock(),
    }


# ── the trade list ──────────────────────────────────────────────────────────

TRADE_PAGE_MAX = 200


def list_transactions(
    db: Session, username: str, *, offset: int = 0, limit: int = 50, q: str = "", side: str = "",
    account: str = "", source: str = "", year: Optional[int] = None, asset: str = "",
) -> Dict[str, Any]:
    """One page of trades, newest first, filtered. Each row carries the
    page's realized gain for a sell beside the one the source reported."""
    holdings, transactions, info = load_adjusted(db, username)
    _, meta = build_positions(holdings, transactions)
    as_of = meta["as_of"]
    adjusted = {t.id: t for t in transactions}
    duplicates = info["duplicates"]

    query = db.query(PortfolioTransaction).filter(PortfolioTransaction.username == username)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(or_(PortfolioTransaction.ticker.ilike(like), PortfolioTransaction.notes.ilike(like)))
    if side in ("buy", "sell"):
        query = query.filter(PortfolioTransaction.side == side)
    for field, value, fallback in (("account", account, "No account"), ("source", source, "No source")):
        if value:
            column = getattr(PortfolioTransaction, field)
            query = query.filter(or_(column.is_(None), column == "") if value == fallback else column == value)
    if asset:
        query = query.filter(PortfolioTransaction.asset == asset)
    if year:
        query = query.filter(PortfolioTransaction.trade_date >= date(year, 1, 1), PortfolioTransaction.trade_date <= date(year, 12, 31))

    total = query.count()
    page = (
        query.order_by(PortfolioTransaction.trade_date.desc(), PortfolioTransaction.id.desc())
        .offset(offset).limit(min(limit, TRADE_PAGE_MAX)).all()
    )
    return {
        "total": total,
        "offset": offset,
        "rows": [
            {
                "id": tx.id, "ticker": tx.ticker, "asset": tx.asset or "stock", "side": tx.side,
                "shares": tx.shares, "price": tx.price, "fees": tx.fees or 0.0,
                "amount": tx.amount if tx.amount is not None else tx.shares * tx.price,
                "tradeDate": tx.trade_date.isoformat(), "account": tx.account, "source": tx.source,
                "notes": tx.notes, "realizedReported": tx.realized_reported,
                "realized": meta["realized_by_tx"].get(tx.id),
                "counted": tx.id not in duplicates and not (as_of and tx.trade_date <= as_of),
                # The trade this one repeats from another source, if it does.
                "duplicateOf": duplicates.get(tx.id),
                # The ticker a named security was matched to, if it was.
                "aliasOf": adjusted[tx.id].ticker if tx.id in adjusted and adjusted[tx.id].ticker != tx.ticker else None,
                # In today's shares, when a later split changed them.
                "splitFactor": adjusted[tx.id].split_factor if tx.id in adjusted else 1.0,
                "adjustedShares": adjusted[tx.id].shares if tx.id in adjusted else tx.shares,
                "adjustedPrice": adjusted[tx.id].price if tx.id in adjusted else tx.price,
            }
            for tx in page
        ],
    }


# ── one holding ─────────────────────────────────────────────────────────────

# What the detail view shows from the stock pages' cached summary.
COMPANY_FACTS = (
    "market_cap", "pe_ratio", "beta", "profit_margin", "revenue_growth", "next_earnings_date",
)


def _company_facts(db: Session, ticker: str) -> Optional[Dict[str, Any]]:
    """The research page's summary of a stock, if it has one: only what's
    cached (or mock data), never a provider call, since a full summary costs
    a burst of calls the plan can't spare. Opening the research page fills it."""
    if stock_data_client._use_mock():
        data = stock_data_client.mock.get_stock_data(ticker)
        if not data:
            return None
    else:
        row = db.query(StockSummary).filter(StockSummary.ticker == ticker).first()
        if not row:
            return None
        data = stock_data_client._format_response(ticker, row, [])
    summary = data.get("summary") or {}
    return {
        "name": data.get("name"), "description": data.get("description"),
        "sector": data.get("sector"), "industry": data.get("industry"),
        "website": data.get("website"), "headquarters": data.get("headquarters"),
        "employees": data.get("employees"),
        **{key: summary.get(key) for key in COMPANY_FACTS},
    }


def holding_detail(db: Session, username: str, ticker: str) -> Dict[str, Any]:
    """One security the caller holds or has held: its daily closes back past
    the first trade, the trades on it, the position, and what the stock
    pages know about the company."""
    holdings, transactions, _ = load_adjusted(db, username, _Budget(SPLIT_CALLS_PER_REQUEST))
    positions, meta = build_positions(holdings, transactions)
    ticker = ticker.strip().upper()
    position = positions.get(ticker)
    if position is None:
        raise HTTPException(status_code=404, detail="Not in your portfolio.")

    today = utc_today()
    symbol = market_symbol(ticker, position["asset"])
    start = min(position["first"] or today, today - timedelta(days=365))
    status, backfilling = "ready", []
    if symbol:
        status = ensure_closes(db, {symbol: (start, today)}, _Budget(CALLS_PER_REQUEST)).get(symbol, "ready")
        if status == "ready":
            backfilling = backfill_closes(db, {symbol: (start, today)}, 1)
    closes = [
        {"date": day.isoformat(), "close": round(close, 4)}
        for day, close in (
            db.query(PriceClose.day, PriceClose.close)
            .filter(PriceClose.ticker == symbol, PriceClose.day >= start)
            .order_by(PriceClose.day)
        )
    ] if symbol else []

    is_open = position["shares"] > EPSILON
    quote = quotes(db, {ticker: position})[ticker] if is_open else None
    price = quote["price"] if quote else (closes[-1]["close"] if closes else None)
    value = position["shares"] * price if is_open and price is not None else None
    cost = position["cost"] if is_open else None
    gain = value - cost if value is not None and cost is not None else None
    day_change = base = None
    if quote and value is not None and quote["prevClose"]:
        day_change, base = _day_change(position["shares"], price, quote["prevClose"], [
            t for t in transactions if t.ticker == ticker and t.trade_date == quote["day"]
        ])

    def since(days: Optional[int]) -> Optional[float]:
        """The price change since `days` ago (None: since Jan 1)."""
        if not closes:
            return None
        cutoff = (date(today.year, 1, 1) if days is None else today - timedelta(days=days)).isoformat()
        before = [c for c in closes if c["date"] <= cutoff]
        return _ratio(closes[-1]["close"] - before[-1]["close"], before[-1]["close"]) if before else None

    year = [c["close"] for c in closes if c["date"] >= (today - timedelta(days=365)).isoformat()]
    trades = sorted((t for t in transactions if t.ticker == ticker), key=lambda t: (t.trade_date, t.id))
    facts = _company_facts(db, ticker) if position["asset"] == "stock" else None
    name = (facts or {}).get("name") or (quote or {}).get("name") or CRYPTO_NAMES.get(ticker)
    return {
        "ticker": ticker,
        "asset": position["asset"],
        "name": name,
        "open": is_open,
        "price": price,
        "priceStatus": quote["status"] if quote else ("closed" if closes else "unavailable"),
        "priceAsOf": quote["asOf"] if quote else (closes[-1]["date"] if closes else None),
        "dayChange": day_change,
        "dayChangePct": _ratio(day_change, base) if day_change is not None else None,
        "position": {
            "shares": position["shares"] if is_open else 0.0,
            "marketValue": value,
            "costBasis": cost,
            "avgCost": _ratio(cost, position["shares"]) if is_open else None,
            "gain": gain,
            "gainPct": _ratio(gain, cost),
            "realizedGain": position["realized"] if position["realizedCounted"] else None,
            "bought": position["bought"],
            "sold": position["sold"],
            "trades": position["trades"],
            "firstTrade": position["first"].isoformat() if position["first"] else None,
            "lastTrade": position["last"].isoformat() if position["last"] else None,
        },
        "performance": {
            "1M": since(31), "YTD": since(None), "1Y": since(365),
            "high52w": max(year) if year else None, "low52w": min(year) if year else None,
        },
        "closes": closes,
        "trades": [
            {
                "id": t.id, "date": t.trade_date.isoformat(), "side": t.side, "shares": t.shares,
                "price": t.price, "fees": t.fees or 0.0, "account": t.account, "source": t.source,
                "realized": meta["realized_by_tx"].get(t.id),
            }
            for t in trades
        ],
        "company": facts,
        "pending": status == "pending" or bool(backfilling),
        "retryAfter": retry_after_seconds() if status == "pending" else (min(backfill_retry_after() or 2, 120) if backfilling else None),
        "sampleData": stock_data_client._use_mock(),
    }


# ── older history ───────────────────────────────────────────────────────────
#
# The main provider's plan reaches back about two years; a trade history can
# reach back ten. For the chart, each symbol's days before its earliest
# stored close are asked of Tiingo once (one call, from the first day wanted
# through today so every later split is in it) and stored with the rest.
# Only the days before the main provider's own closes are kept, so the two
# sources never overlap. Tiingo's free tier allows a limited number of calls
# an hour: a few per request, and a pause when it says the allowance is spent.

BACKFILL_CALLS_PER_REQUEST = 3
BACKFILL_COOLDOWN = timedelta(minutes=10)
# A symbol Tiingo had nothing for is asked again after this long.
BACKFILL_RETRY = timedelta(hours=24)
_backfill_paused_until: Optional[datetime] = None


def backfill_configured() -> bool:
    return not stock_data_client._use_mock() and tiingo_client.is_configured()


def _fetch_old_closes(symbol: str, start: date) -> List[Tuple[date, float]]:
    if symbol.startswith("X:"):
        return tiingo_client.get_crypto_closes(symbol[2:], start)
    return tiingo_client.get_daily_closes(symbol, start)


def backfill_retry_after() -> Optional[int]:
    if _backfill_paused_until and _backfill_paused_until > _now():
        return int((_backfill_paused_until - _now()).total_seconds()) + 1
    return None


def backfill_closes(db: Session, wants: Dict[str, Tuple[date, date]], calls: int) -> List[str]:
    """Fill each symbol's days before its earliest stored close. Returns the
    symbols still waiting for a call."""
    global _backfill_paused_until
    if not wants or not backfill_configured():
        return []
    pending: List[str] = []
    with _lock:
        earliest = dict(
            db.query(PriceClose.ticker, func.min(PriceClose.day))
            .filter(PriceClose.ticker.in_(list(wants))).group_by(PriceClose.ticker).all()
        )
        checks = {c.symbol: c for c in db.query(PriceBackfill).filter(PriceBackfill.symbol.in_(list(wants)))}
        for symbol, (start, _end) in wants.items():
            first = earliest.get(symbol)
            if first is not None and (first - start).days <= STALE_AFTER_DAYS:
                continue  # the main provider already covers it
            check = checks.get(symbol)
            if check and check.requested_from <= start + timedelta(days=STALE_AFTER_DAYS) and (
                check.found or _naive_now() - check.checked_at < BACKFILL_RETRY
            ):
                continue
            if (_backfill_paused_until and _backfill_paused_until > _now()) or calls <= 0:
                pending.append(symbol)
                continue
            calls -= 1
            try:
                rows = _fetch_old_closes(symbol, start)
            except TiingoRateLimited:
                _backfill_paused_until = _now() + BACKFILL_COOLDOWN
                logger.warning("Tiingo allowance spent; pausing portfolio backfill")
                pending.append(symbol)
                continue
            except Exception as exc:  # noqa: BLE001 - the chart keeps its estimates
                logger.warning("[%s] older closes unavailable: %s", symbol, type(exc).__name__)
                rows = []
            _store(db, symbol, [r for r in rows if first is None or r[0] < first])
            if check is None:
                check = PriceBackfill(symbol=symbol, requested_from=start, checked_at=_naive_now(), found=bool(rows))
                db.add(check)
            else:
                check.requested_from, check.checked_at = min(check.requested_from, start), _naive_now()
                check.found = bool(rows)
            db.commit()
    return pending


# ── value over time ─────────────────────────────────────────────────────────
#
# The value on a day is the shares held that day times that day's price. A
# day's price is the symbol's close if there is one within a few days, else
# the position's own most recent trade price (an estimate, flagged per point).
# Shares come from the same two sources as the breakdown: with a holdings
# snapshot, the window starts from the snapshot less the trades between the
# window's start and it, then replays forward; with no snapshot, it starts at
# the first trade. "Invested" is the cost basis of what's held that day.

HISTORY_MAX_POINTS = 4_000
# A point is an estimate when more than this share of its value came from
# trade prices rather than closes.
ESTIMATE_SHARE = 0.02


def value_history(db: Session, username: str) -> Dict[str, Any]:
    holdings, transactions, _ = load_adjusted(db, username)
    today = utc_today()
    as_of = holdings[0].as_of if holdings else None
    first_trade = transactions[0].trade_date if transactions else None
    if as_of:
        start = min(first_trade or as_of, as_of - timedelta(days=365))
    else:
        start = first_trade or today
    start = max(start, today - timedelta(days=HISTORY_MAX_POINTS * 7 // 5))

    base = {
        "points": [], "start": start.isoformat(), "asOf": as_of.isoformat() if as_of else None,
        "pending": [], "missing": [], "complete": True, "retryAfter": None,
        "sampleData": stock_data_client._use_mock(),
    }
    if not holdings and not transactions:
        return base

    assets = {h.ticker: "stock" for h in holdings}
    held: Dict[str, List[date]] = {}
    for tx in transactions:
        assets[tx.ticker] = tx.asset or "stock"
        held.setdefault(tx.ticker, []).append(tx.trade_date)
    # Each symbol's closes are wanted from its first trade (or the window's
    # start) to its last, or today if it's still held.
    positions, _ = build_positions(holdings, transactions)
    wants: Dict[str, Tuple[date, date]] = {}
    for ticker, asset in assets.items():
        symbol = market_symbol(ticker, asset)
        if not symbol:
            continue
        dates = held.get(ticker, [])
        begin = max(start, min(dates)) if dates and ticker not in {h.ticker for h in holdings} else start
        end = today if positions.get(ticker, {}).get("shares", 0) > EPSILON else (max(dates) if dates else today)
        wants[symbol] = (begin, end)
    # Recently held symbols first, so the recent end of the chart fills first.
    wants = dict(sorted(wants.items(), key=lambda kv: kv[1][1], reverse=True))
    status = ensure_closes(db, wants, _Budget(CALLS_PER_REQUEST))
    pending = [s for s, state in status.items() if state == "pending"]
    # Older days only once the main provider has said what it has.
    backfilling = backfill_closes(
        db, {s: w for s, w in wants.items() if status.get(s) == "ready"}, BACKFILL_CALLS_PER_REQUEST,
    )

    closes: Dict[str, List[Tuple[date, float]]] = {}
    for symbol, day, close in (
        db.query(PriceClose.ticker, PriceClose.day, PriceClose.close)
        .filter(PriceClose.ticker.in_(list(wants)), PriceClose.day >= start)
        .order_by(PriceClose.day)
    ):
        closes.setdefault(symbol, []).append((day, close))
    base["missing"] = sorted(t for t, a in assets.items() if (s := market_symbol(t, a)) and s not in pending and not closes.get(s))

    # Replay state: shares, cost (None = unknown) and last trade price.
    shares: Dict[str, float] = {}
    cost: Dict[str, Optional[float]] = {}
    last_trade: Dict[str, float] = {}
    if as_of:
        for h in holdings:
            shares[h.ticker] = h.shares
            last_trade[h.ticker] = (h.cost_basis / h.shares) if h.cost_basis and h.shares else 0.0
        for tx in transactions:
            if start < tx.trade_date <= as_of:
                shares[tx.ticker] = shares.get(tx.ticker, 0.0) - (tx.shares if tx.side == "buy" else -tx.shares)
        for ticker in shares:
            cost[ticker] = None
    trades = [tx for tx in transactions if tx.trade_date > start or (not as_of and tx.trade_date >= start)]
    snapshot_cost = {h.ticker: h.cost_basis for h in holdings}

    cursor = {symbol: 0 for symbol in closes}
    current: Dict[str, Tuple[date, float]] = {}
    points = []
    snapshot_applied = False
    t_index = 0
    day = start
    while day <= today:
        if day.weekday() < 5 or day == today:
            while t_index < len(trades) and trades[t_index].trade_date <= day:
                tx = trades[t_index]
                t_index += 1
                held_now = shares.get(tx.ticker, 0.0)
                basis = cost.get(tx.ticker, 0.0) if tx.ticker in cost else 0.0
                if tx.side == "buy":
                    shares[tx.ticker] = held_now + tx.shares
                    cost[tx.ticker] = None if basis is None else basis + tx.shares * tx.price + (tx.fees or 0.0)
                else:
                    sold = min(tx.shares, max(held_now, 0.0))
                    if basis is not None and held_now > EPSILON:
                        cost[tx.ticker] = basis - basis / held_now * sold
                    shares[tx.ticker] = held_now - tx.shares
                last_trade[tx.ticker] = tx.price
            if as_of and day >= as_of and not snapshot_applied:
                # The snapshot's day is where its cost basis is known: after
                # that day's trades, which it already includes.
                cost.update(snapshot_cost)
                snapshot_applied = True
            for symbol, series in closes.items():
                i = cursor[symbol]
                while i < len(series) and series[i][0] <= day:
                    current[symbol] = series[i]
                    i += 1
                cursor[symbol] = i

            value = estimated = 0.0
            invested: Optional[float] = 0.0
            for ticker, count in shares.items():
                if count < DUST_SHARES:
                    continue
                symbol = market_symbol(ticker, assets.get(ticker, "stock"))
                close = current.get(symbol) if symbol else None
                if close and (day - close[0]).days <= STALE_AFTER_DAYS + 2:
                    value += count * close[1]
                else:
                    mark = count * last_trade.get(ticker, 0.0)
                    value += mark
                    estimated += mark
                basis = cost.get(ticker)
                invested = None if invested is None or basis is None else invested + basis
            if value > 0 or points:
                points.append({
                    "date": day.isoformat(),
                    "value": round(value, 2),
                    "invested": round(invested, 2) if invested is not None else None,
                    "estimated": value > 0 and estimated / value > ESTIMATE_SHARE,
                })
        day += timedelta(days=1)

    waiting = pending + backfilling
    retry = None
    if waiting:
        # A paused backfill is worth asking about every minute or two, not
        # every couple of seconds.
        retry = max(retry_after_seconds() if pending else 2, min(backfill_retry_after() or 2, 120) if backfilling else 2)
    return {
        **base, "points": points, "pending": waiting, "backfilling": backfilling,
        "complete": not waiting, "retryAfter": retry,
    }
