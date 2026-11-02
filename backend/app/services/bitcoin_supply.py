import csv
import io
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Tuple


HALVING_INTERVAL = 210000
SERIES_START = date(2009, 1, 1)
M2_CACHE_TTL_SECONDS = 24 * 60 * 60
FRED_API_URL = "https://api.stlouisfed.org/fred/series/observations"
FRED_M2_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=M2SL"
FRED_TIMEOUT_SECONDS = float(os.getenv("BITCOIN_M2_TIMEOUT_SECONDS", "10"))

# Known (height, date) points used to map calendar time onto block height.
# Early blocks came slower than 10 minutes, so the 2009-2011 anchors keep
# the first epoch's curve honest; the rest are the halving blocks.
HEIGHT_ANCHORS: List[Tuple[int, date]] = [
    (0, date(2009, 1, 3)),
    (32490, date(2010, 1, 1)),
    (100000, date(2010, 12, 29)),
    (210000, date(2012, 11, 28)),
    (420000, date(2016, 7, 9)),
    (630000, date(2020, 5, 11)),
    (840000, date(2024, 4, 20)),
]
BLOCKS_PER_DAY = 144

# Rough first-of-year M2 levels (billions USD) for sample mode only.
DEMO_M2_BILLIONS: Dict[int, float] = {
    2009: 8250, 2010: 8500, 2011: 8800, 2012: 9700, 2013: 10450, 2014: 11000,
    2015: 11700, 2016: 12350, 2017: 13250, 2018: 13850, 2019: 14450, 2020: 15400,
    2021: 19300, 2022: 21600, 2023: 21250, 2024: 20800, 2025: 21500, 2026: 22300,
    2027: 23200,
}

_m2_cache: Dict[str, Any] = {}


class M2Error(Exception):
    """Raised when FRED cannot serve the M2 series."""


def issued_supply_btc(height: int) -> float:
    """Cumulative coins issued through block `height` (inclusive)."""
    if height < 0:
        return 0.0
    supply = 0.0
    subsidy = 50.0
    remaining = height + 1
    while remaining > 0 and subsidy > 1e-9:
        blocks = min(remaining, HALVING_INTERVAL)
        supply += blocks * subsidy
        remaining -= blocks
        subsidy /= 2
    return supply


def estimated_height(day: date, tip: Optional[Tuple[int, date]] = None) -> int:
    anchors = list(HEIGHT_ANCHORS)
    if tip and tip[1] > anchors[-1][1] and tip[0] > anchors[-1][0]:
        anchors.append(tip)
    if day <= anchors[0][1]:
        return 0
    for (h0, d0), (h1, d1) in zip(anchors, anchors[1:]):
        if day <= d1:
            span = (d1 - d0).days or 1
            return int(h0 + (h1 - h0) * (day - d0).days / span)
    last_height, last_day = anchors[-1]
    return int(last_height + (day - last_day).days * BLOCKS_PER_DAY)


def _month_starts(start: date, end: date) -> List[date]:
    months = []
    year, month = start.year, start.month
    while date(year, month, 1) <= end:
        months.append(date(year, month, 1))
        month += 1
        if month > 12:
            year, month = year + 1, 1
    return months


def _unix(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp())


def _fred_request(url: str) -> str:
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=FRED_TIMEOUT_SECONDS) as response:
            return response.read().decode("utf-8")
    except socket.timeout as exc:
        raise M2Error("Timed out waiting for FRED") from exc
    except urllib.error.HTTPError as exc:
        raise M2Error(f"FRED returned HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise M2Error(f"Could not reach FRED: {exc}") from exc


def _parse_m2_rows(rows: List[Tuple[str, str]]) -> Dict[date, float]:
    values: Dict[date, float] = {}
    for day_text, value_text in rows:
        try:
            values[date.fromisoformat(day_text)] = float(value_text)
        except ValueError:
            continue  # header row or "." for a missing month
    if not values:
        raise M2Error("FRED returned no M2 values")
    return values


def fetch_m2_billions() -> Dict[date, float]:
    """Monthly M2 (billions USD). Uses the FRED API when FRED_API_KEY is set,
    otherwise FRED's public CSV download."""
    api_key = os.getenv("FRED_API_KEY", "").strip()
    if api_key:
        query = urllib.parse.urlencode({
            "series_id": "M2SL",
            "api_key": api_key,
            "file_type": "json",
            "observation_start": SERIES_START.isoformat(),
        })
        body = _fred_request(f"{FRED_API_URL}?{query}")
        try:
            observations = json.loads(body).get("observations") or []
        except json.JSONDecodeError as exc:
            raise M2Error("FRED returned invalid JSON") from exc
        return _parse_m2_rows([(o.get("date", ""), o.get("value", "")) for o in observations])

    body = _fred_request(FRED_M2_CSV_URL)
    return _parse_m2_rows([(row[0], row[1]) for row in csv.reader(io.StringIO(body)) if len(row) >= 2])


def _cached_m2() -> Tuple[Optional[Dict[date, float]], Optional[str]]:
    cached = _m2_cache.get("m2")
    if cached and time.time() - cached[0] < M2_CACHE_TTL_SECONDS:
        return cached[1], None
    try:
        values = fetch_m2_billions()
    except M2Error as exc:
        if cached:
            return cached[1], None
        return None, str(exc)
    _m2_cache["m2"] = (time.time(), values)
    return values, None


def _demo_m2_billions(months: List[date]) -> Dict[date, float]:
    values = {}
    for day in months:
        low = DEMO_M2_BILLIONS.get(day.year)
        high = DEMO_M2_BILLIONS.get(day.year + 1, low)
        if low is None:
            continue
        values[day] = round(low + (high - low) * (day.month - 1) / 12, 1)
    return values


def build_supply_history(
    today: date,
    m2_billions: Optional[Dict[date, float]],
    tip: Optional[Tuple[int, date]] = None,
    source: str = "live",
    warnings: Optional[List[str]] = None,
) -> Dict[str, Any]:
    points = []
    for day in _month_starts(SERIES_START, today):
        m2 = (m2_billions or {}).get(day)
        points.append({
            "t": _unix(day),
            "btc": round(issued_supply_btc(estimated_height(day, tip))),
            "m2_usd": m2 * 1e9 if m2 is not None else None,
        })
    # End the BTC line on today rather than the first of the month.
    if today.day != 1:
        height = tip[0] if tip and tip[1] == today else estimated_height(today, tip)
        points.append({"t": _unix(today), "btc": round(issued_supply_btc(height)), "m2_usd": None})

    first, last = points[0], points[-1]
    m2_points = [p for p in points if p["m2_usd"] is not None]
    return {
        "source": source,
        "points": points,
        "btc_first": first["btc"],
        "btc_last": last["btc"],
        "m2_first": m2_points[0]["m2_usd"] if m2_points else None,
        "m2_last": m2_points[-1]["m2_usd"] if m2_points else None,
        "m2_last_time": m2_points[-1]["t"] if m2_points else None,
        "warnings": warnings or [],
    }


def get_supply_history(tip_height: Optional[int] = None) -> Dict[str, Any]:
    today = datetime.now(timezone.utc).date()
    tip = (tip_height, today) if isinstance(tip_height, int) and tip_height > 0 else None
    m2, error = _cached_m2()
    warnings = ["I cannot reach the M2 money supply data right now."] if error else []
    return build_supply_history(today, m2, tip, source="live", warnings=warnings)


def get_demo_supply_history(warning: str) -> Dict[str, Any]:
    today = datetime.now(timezone.utc).date()
    months = _month_starts(SERIES_START, today)
    # FRED publishes with a lag; drop the last two months like the real feed.
    m2 = _demo_m2_billions(months[:-2])
    return build_supply_history(today, m2, source="demo", warnings=[warning])
