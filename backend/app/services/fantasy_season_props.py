"""Kalshi client and parser for NFL regular-season player totals.

The Odds API feed used for game lines and weekly props does not expose
season-long player over/unders, and the sportsbook feeds that do are priced
for trading desks. Kalshi lists the same six categories as regulated event
contracts on a public, keyless endpoint, so it backs this module instead.

Kalshi is an exchange, not a sportsbook: it lists a *threshold* contract
("will X record 3000+ passing yards?") rather than a line with juice. Two
properties make that map cleanly onto the sportsbook shape the rest of the
app already speaks:

* ``floor_strike`` (2999.5) is literally the over/under point.
* YES on the threshold is the Over; NO is the Under. Both sides come off one
  order book, so their prices are complements of each other.

The catch is liquidity. Coverage in August 2026 was 30 QBs / 50 RBs / 87
WR-TEs, and much of it is quoted so wide that the midpoint is meaningless —
several RB1s sat at bid 0.02 / ask 0.84, whose "43%" midpoint is an artifact
of the empty book rather than a market view. Everything below therefore
treats this as an *overlay* on the projection consensus: it filters hard and
returns nothing rather than something untrustworthy.
"""
import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List, Optional, Tuple

from app.services.fantasy_common import coerce_float

# Kalshi series ticker -> the market key used by ff_season_prop_snapshots.
# KXNFLSEASONRUSHYDS is an empty legacy duplicate of KXNFLSEASONRSHYDS; it is
# listed so a provider switch back to it does not silently drop rushing yards.
SEASON_PROP_SERIES = {
    "KXNFLSEASONPASSYDS": "season_pass_yds",
    "KXNFLSEASONPASSTDS": "season_pass_tds",
    "KXNFLSEASONRSHYDS": "season_rush_yds",
    "KXNFLSEASONRUSHYDS": "season_rush_yds",
    "KXNFLSEASONRSHTD": "season_rush_tds",
    "KXNFLSEASONRECYDS": "season_rec_yds",
    "KXNFLSEASONRECTD": "season_rec_tds",
}

# Stored in the ``bookmaker`` column so the UI can label the source honestly:
# these are exchange prices, not a sportsbook's line.
BOOKMAKER = "Kalshi"

# Widest YES bid/ask (in dollars, i.e. probability) still treated as a real
# quote. At 0.20 the August 2026 board kept ~40 WRs, ~17 QBs and ~9 RBs;
# loosening it past ~0.30 starts admitting one-sided books whose midpoint
# ranks backup running backs above CMC.
DEFAULT_MAX_SPREAD = 0.20


class SeasonPropsError(Exception):
    """Raised when the season-props provider cannot serve a request."""


def probability_to_american(probability: Any) -> Optional[int]:
    """Convert a 0-1 implied probability to the American format the UI uses."""
    value = coerce_float(probability)
    if value is None or value <= 0 or value >= 1:
        return None
    if value <= 0.5:
        return int(round((1 - value) / value * 100))
    return int(round(-value / (1 - value) * 100))


def _player_key(ticker: Any) -> Optional[str]:
    """Extract Kalshi's per-player suffix from a market ticker.

    ``KXNFLSEASONPASSYDS-27C3000-TSHOUGH6`` -> ``TSHOUGH6``. Kalshi exposes no
    numeric player id (``primary_participant_key`` is the constant
    ``"football_player"``), but this suffix is stable across strikes, which is
    all the monotonicity grouping below needs.
    """
    if not isinstance(ticker, str):
        return None
    parts = ticker.split("-")
    return parts[-1] if len(parts) >= 3 and parts[-1] else None


def _quote(raw: Dict[str, Any], max_spread: float) -> Optional[float]:
    """Mid-price of a two-sided YES quote, or None if it fails the filter.

    A missing side is not a wide market, it is no market: an ask with no bid
    still produces a midpoint, and that midpoint is what puts phantom players
    at the top of a ranking.
    """
    bid = coerce_float(raw.get("yes_bid_dollars"))
    ask = coerce_float(raw.get("yes_ask_dollars"))
    if bid is None or ask is None or bid <= 0 or ask <= 0 or ask <= bid:
        return None
    if ask - bid > max_spread:
        return None
    return (bid + ask) / 2


def _monotonic(strikes: List[Tuple[float, float]]) -> bool:
    """True if probability falls as the threshold rises (allowing 1c of noise).

    P(2000+ yards) can never be below P(3000+ yards). When the board says
    otherwise one of the two quotes is stale, and there is no way to tell
    which, so the caller drops the player's whole ladder for that market.
    """
    ordered = [probability for _, probability in sorted(strikes)]
    return all(ordered[i + 1] <= ordered[i] + 0.01 for i in range(len(ordered) - 1))


def parse_season_props(
    payload: Any,
    max_spread: float = DEFAULT_MAX_SPREAD,
) -> List[Dict[str, Any]]:
    """Flatten Kalshi series payloads into Over/Under snapshot rows.

    ``payload`` maps a series ticker to that series' ``markets`` list. Each
    surviving threshold yields two rows (Over from YES, Under from NO) so the
    read path can summarize them exactly like a sportsbook's two-sided line.
    """
    if not isinstance(payload, dict):
        raise SeasonPropsError("season props payload was not an object")

    # (player, market) -> [(point, probability, name)], collected before any
    # rows are emitted so the ladder can be checked as a whole.
    ladders: Dict[Tuple[str, str], List[Tuple[float, float, str]]] = {}
    for series_ticker, markets in payload.items():
        market = SEASON_PROP_SERIES.get(str(series_ticker))
        if not market or not isinstance(markets, list):
            continue
        for raw in markets:
            if not isinstance(raw, dict) or raw.get("status") != "active":
                continue
            player_key = _player_key(raw.get("ticker"))
            name = raw.get("yes_sub_title")
            point = coerce_float(raw.get("floor_strike"))
            if not player_key or not name or point is None:
                continue
            probability = _quote(raw, max_spread)
            if probability is None:
                continue
            ladders.setdefault((player_key, market), []).append(
                (point, probability, str(name))
            )

    rows: List[Dict[str, Any]] = []
    for (player_key, market), strikes in ladders.items():
        if not _monotonic([(point, probability) for point, probability, _ in strikes]):
            continue
        for point, probability, name in strikes:
            # YES and NO trade against one shared order book, so the Under is
            # the exact complement rather than an independently posted price.
            rows.append(
                {
                    "provider_player_id": player_key,
                    "player_name_raw": name,
                    "bookmaker": BOOKMAKER,
                    "market": market,
                    "outcome": "Over",
                    "price": probability_to_american(probability),
                    "point": point,
                }
            )
            rows.append(
                {
                    "provider_player_id": player_key,
                    "player_name_raw": name,
                    "bookmaker": BOOKMAKER,
                    "market": market,
                    "outcome": "Under",
                    "price": probability_to_american(1 - probability),
                    "point": point,
                }
            )
    return rows


class KalshiClient:
    def __init__(
        self,
        base_url: Optional[str] = None,
        timeout: Optional[float] = None,
        max_spread: Optional[float] = None,
        series: Optional[Iterable[str]] = None,
    ):
        self.base_url = (
            base_url
            or os.getenv("KALSHI_API_URL")
            or "https://api.elections.kalshi.com/trade-api/v2"
        ).rstrip("/")
        self.timeout = timeout or float(os.getenv("KALSHI_TIMEOUT_SECONDS", "20"))
        self.max_spread = (
            max_spread
            if max_spread is not None
            else float(os.getenv("KALSHI_MAX_SPREAD", str(DEFAULT_MAX_SPREAD)))
        )
        self.series = tuple(series) if series is not None else tuple(SEASON_PROP_SERIES)

    @property
    def configured(self) -> bool:
        """Kalshi's market data is public, so there is nothing to configure."""
        return True

    def get_season_props(self) -> Dict[str, List[Dict[str, Any]]]:
        return {ticker: self._get_series(ticker) for ticker in self.series}

    def _get_series(self, series_ticker: str) -> List[Dict[str, Any]]:
        markets: List[Dict[str, Any]] = []
        cursor: Optional[str] = None
        # Ladders run to a few hundred markets per series; the bound stops a
        # cursor that never advances from looping forever.
        for _ in range(10):
            params = {"series_ticker": series_ticker, "status": "open", "limit": "1000"}
            if cursor:
                params["cursor"] = cursor
            payload = self._request("/markets", params)
            page = payload.get("markets")
            if not isinstance(page, list) or not page:
                break
            markets.extend(row for row in page if isinstance(row, dict))
            cursor = payload.get("cursor")
            if not cursor:
                break
        return markets

    def _request(self, path: str, params: Dict[str, str]) -> Dict[str, Any]:
        query = urllib.parse.urlencode(params)
        request = urllib.request.Request(
            f"{self.base_url}{path}?{query}",
            headers={
                "Accept": "application/json",
                "User-Agent": "palmergill-fantasy/1.0",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
        except socket.timeout as exc:
            raise SeasonPropsError("Timed out waiting for the season props provider") from exc
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise SeasonPropsError(f"Season props provider returned HTTP {exc.code}: {detail[:200]}") from exc
        except urllib.error.URLError as exc:
            raise SeasonPropsError(f"Could not reach the season props provider: {exc}") from exc
        try:
            data = json.loads(body)
        except json.JSONDecodeError as exc:
            raise SeasonPropsError("Season props provider returned invalid JSON") from exc
        if not isinstance(data, dict):
            raise SeasonPropsError("Season props provider returned an unexpected response")
        return data


season_props_client = KalshiClient()
