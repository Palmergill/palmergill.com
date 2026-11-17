"""The 3-month Treasury bill rate by month, from FRED: the risk-free rate the
portfolio's Sharpe ratio is measured against.

FRED's TB3MS series is the monthly average of the secondary-market rate, in
percent. With FRED_API_KEY set it comes from the FRED API, otherwise from
FRED's public CSV download. One fetch serves every account for a day; a
failed fetch is retried in an hour rather than on every page load."""
import csv
import io
import json
import logging
import os
import threading
import time
import urllib.parse
import urllib.request
from datetime import date
from typing import Dict, List, Optional, Tuple

from app.services.stock_data_client import stock_data_client

logger = logging.getLogger(__name__)

SERIES = "TB3MS"
FRED_API_URL = "https://api.stlouisfed.org/fred/series/observations"
FRED_CSV_URL = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={SERIES}"
TIMEOUT_SECONDS = float(os.getenv("TREASURY_TIMEOUT_SECONDS", "6"))
KEEP_SECONDS = 24 * 60 * 60
RETRY_SECONDS = 60 * 60
START = date(2000, 1, 1)

_lock = threading.Lock()
_cache: Dict[str, Tuple[float, Dict[str, float]]] = {}


def _fetch_text(url: str) -> str:
    request = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return response.read().decode("utf-8")


def _parse(rows: List[Tuple[str, str]]) -> Dict[str, float]:
    """{"YYYY-MM": rate as a fraction}; FRED marks a missing month with "."."""
    out: Dict[str, float] = {}
    for day_text, value_text in rows:
        try:
            day = date.fromisoformat(day_text)
            out[f"{day.year:04d}-{day.month:02d}"] = round(float(value_text) / 100, 6)
        except ValueError:
            continue
    return out


def _fetch() -> Dict[str, float]:
    api_key = os.getenv("FRED_API_KEY", "").strip()
    if api_key:
        query = urllib.parse.urlencode({
            "series_id": SERIES, "api_key": api_key, "file_type": "json",
            "observation_start": START.isoformat(),
        })
        observations = json.loads(_fetch_text(f"{FRED_API_URL}?{query}")).get("observations") or []
        return _parse([(o.get("date", ""), o.get("value", "")) for o in observations])
    body = _fetch_text(FRED_CSV_URL)
    return _parse([(row[0], row[1]) for row in csv.reader(io.StringIO(body)) if len(row) >= 2])


def _sample(today: date) -> Dict[str, float]:
    """Sample data's rates: near 4%, easing slowly, the same on every load."""
    out = {}
    for back in range(0, 120):
        index = today.year * 12 + today.month - 1 - back
        out[f"{index // 12:04d}-{index % 12 + 1:02d}"] = round(0.04 + back * 0.00008, 6)
    return out


def monthly_rates(today: Optional[date] = None) -> Dict[str, float]:
    """The 3-month T-bill rate for each month FRED has, as a fraction. Empty
    when FRED can't be reached: the Sharpe ratio is an extra."""
    if stock_data_client._use_mock():
        return _sample(today or date.today())
    with _lock:
        hit = _cache.get(SERIES)
        if hit and hit[0] > time.time():
            return hit[1]
        try:
            rates, keep = _fetch(), KEEP_SECONDS
            if not rates:
                raise ValueError("no values")
        except Exception as exc:  # noqa: BLE001 - an extra, never a failure
            logger.warning("T-bill rates unavailable: %s", exc)
            rates, keep = (hit[1] if hit else {}), RETRY_SECONDS
        _cache[SERIES] = (time.time() + keep, rates)
        return rates


def rates_since(first: str, today: Optional[date] = None) -> List[Dict[str, float]]:
    """[{"month", "rate"}] from the month of ISO day `first` on, oldest first."""
    since = first[:7]
    return [{"month": m, "rate": r} for m, r in sorted(monthly_rates(today).items()) if m >= since]
