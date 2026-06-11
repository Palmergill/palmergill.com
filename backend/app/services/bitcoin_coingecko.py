import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional


class CoinGeckoError(Exception):
    """Raised when CoinGecko cannot serve a BTC price-history request."""


class CoinGeckoClient:
    def __init__(self, base_url: Optional[str] = None, timeout: Optional[float] = None):
        self.base_url = (base_url or os.getenv("BITCOIN_PRICE_API_URL") or "https://api.coingecko.com/api/v3").rstrip("/")
        self.timeout = timeout or float(os.getenv("BITCOIN_PRICE_TIMEOUT_SECONDS", "10"))

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    def get_market_chart(self, days: int, vs_currency: str = "usd") -> Dict[str, Any]:
        query = urllib.parse.urlencode({"vs_currency": vs_currency, "days": days})
        return self._request(f"/coins/bitcoin/market_chart?{query}")

    def _request(self, path: str) -> Any:
        url = f"{self.base_url}{path}"
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "palmergill-bitcoin-chat/1.0",
            },
            method="GET",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
        except socket.timeout as exc:
            raise CoinGeckoError("Timed out waiting for CoinGecko response") from exc
        except urllib.error.HTTPError as exc:
            if exc.code == 429:
                raise CoinGeckoError("CoinGecko rate limit reached; try again shortly") from exc
            raise CoinGeckoError(f"CoinGecko returned HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise CoinGeckoError(f"Could not reach CoinGecko: {exc}") from exc

        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise CoinGeckoError("CoinGecko returned invalid JSON") from exc


coingecko_client = CoinGeckoClient()
