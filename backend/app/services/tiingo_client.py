"""
Tiingo Client - long daily price history

Used by the portfolio for the years the Polygon plan doesn't reach: Polygon
serves about two years of daily bars, and a trade history can go back ten.
Free tier: a limited number of requests an hour, so callers fetch each
symbol once and store it.

Closes come back split-adjusted and nothing else, to match Polygon's
`adjusted=true` bars: Tiingo's raw close divided by every split after that
day. (Its own adjClose also takes out dividends, which would put old prices
on a different footing from the recent ones.)
"""

import logging
import os
from datetime import date, datetime
from typing import List, Tuple

import requests

logger = logging.getLogger(__name__)


class TiingoRateLimited(Exception):
    """Tiingo said the hourly or daily request allowance is spent."""


class TiingoClient:
    BASE_URL = "https://api.tiingo.com"

    def __init__(self):
        self.api_key = os.getenv("TIINGO_API_KEY")

    def is_configured(self) -> bool:
        return bool(self.api_key)

    def _get(self, path: str, params: dict):
        response = requests.get(
            f"{self.BASE_URL}{path}",
            params=params,
            headers={"Authorization": f"Token {self.api_key}", "Content-Type": "application/json"},
            timeout=20,
        )
        if response.status_code == 429:
            raise TiingoRateLimited(path)
        if response.status_code == 404:
            return []
        response.raise_for_status()
        data = response.json()
        # An exhausted allowance can also come back as a 200 with a message.
        if isinstance(data, dict):
            message = str(data.get("detail") or data.get("message") or data)
            if "allocation" in message.lower() or "limit" in message.lower():
                raise TiingoRateLimited(message[:120])
            raise RuntimeError(message[:200])
        return data

    def get_daily_closes(self, ticker: str, start: date) -> List[Tuple[date, float]]:
        """(date, split-adjusted close) from `start` through the latest day.

        Always runs to the latest day, so every split after `start` is in the
        response and the adjustment is complete.
        """
        rows = self._get(
            f"/tiingo/daily/{ticker.replace('.', '-').lower()}/prices",
            {"startDate": start.isoformat()},
        )
        closes = []
        cumulative = 1.0
        for row in reversed(rows):
            close = row.get("close")
            day = row.get("date")
            if close is not None and day:
                closes.append((datetime.fromisoformat(day[:10]).date(), float(close) / cumulative))
            # A split on this day applies to every day before it.
            cumulative *= float(row.get("splitFactor") or 1.0)
        return sorted(closes)

    def get_crypto_closes(self, pair: str, start: date) -> List[Tuple[date, float]]:
        """(date, close) for a crypto pair like "btcusd", one bar a day."""
        data = self._get(
            "/tiingo/crypto/prices",
            {"tickers": pair.lower(), "startDate": start.isoformat(), "resampleFreq": "1day"},
        )
        closes = {}
        for series in data or []:
            for row in series.get("priceData") or []:
                if row.get("close") is not None and row.get("date"):
                    closes[datetime.fromisoformat(row["date"][:10]).date()] = float(row["close"])
        return sorted(closes.items())


tiingo_client = TiingoClient()
