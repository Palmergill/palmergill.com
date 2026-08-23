"""Season-long NFL player over/unders, and the Kalshi client that started them.

The Odds API feed used for game lines and weekly props does not expose
season-long player over/unders, and the sportsbook feeds that do are priced
for trading desks. Three public, keyless sources quote the same six
categories, so the dashboard reads all of them:

* **Kalshi** (this module) and **Polymarket** (``fantasy_polymarket_props``)
  are exchanges. They list *threshold* contracts ("will X record 3000+
  passing yards?") rather than lines, so a player arrives as a ladder of
  strikes whose YES prices form a survival curve.
* **Underdog** (``fantasy_underdog_props``) posts a single balanced line per
  player and category, which is the market's median estimate directly.

This module holds the primitives all three share -- HTTP, price conversion,
de-vigging, the monotonicity check, and the ladder-to-rows builder -- plus the
Kalshi client itself. The provider registry lives in ``fantasy_collector``,
which is the only module that needs to know all three exist.

Every provider emits the same row shape so the read path can treat them
uniformly and, where they overlap, take a consensus:

    provider_player_id, player_name_raw, bookmaker, market,
    outcome ("Over"/"Under"), price (American), point, quoted_at

Both sides of a row pair are complements of one de-vigged probability. On an
exchange that is literally true -- YES and NO trade against one order book --
and for Underdog it is what de-vigging the two posted prices produces, so
"Over price" means the same thing everywhere.

The catch across all three is liquidity. Coverage in August 2026 was ~135
players on Kalshi, ~141 on Underdog and ~130 on Polymarket, and much of the
exchange side is quoted so wide that the midpoint is meaningless -- several
RB1s sat at bid 0.02 / ask 0.84, whose "43%" midpoint is an artifact of the
empty book rather than a market view. Everything below therefore treats this
as an *overlay* on the projection consensus: it prefers tight two-sided
quotes and uses an executed trade only when it remains bounded by the live
book.
"""
import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
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
    """Raised when a season-props provider cannot serve a request."""


# ── shared primitives ───────────────────────────────────────────────────


def request_json(
    url: str,
    params: Optional[Dict[str, str]] = None,
    timeout: float = 20.0,
    provider: str = "season props",
) -> Any:
    """GET one JSON document, with every failure mode as a SeasonPropsError.

    All three providers are public, keyless HTTP/JSON endpoints reached with
    the stdlib, matching the rest of the backend. Polymarket rejects requests
    without a User-Agent, so one is always sent.
    """
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "palmergill-fantasy/1.0"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except socket.timeout as exc:
        raise SeasonPropsError(f"Timed out waiting for {provider}") from exc
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SeasonPropsError(f"{provider} returned HTTP {exc.code}: {detail[:200]}") from exc
    except urllib.error.URLError as exc:
        raise SeasonPropsError(f"Could not reach {provider}: {exc}") from exc
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise SeasonPropsError(f"{provider} returned invalid JSON") from exc


def parse_timestamp(value: Any) -> Optional[datetime]:
    """ISO-8601 (with a trailing Z, as all three providers send) -> UTC datetime.

    This is the moment the *market* last moved, which is the number that
    matters for a season-long board: a collection run an hour ago says
    nothing when the underlying quote has not changed in eleven days.
    """
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed
    # Stored in a naive UTC column, like every other timestamp in this schema.
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)


def probability_to_american(probability: Any) -> Optional[int]:
    """Convert a 0-1 implied probability to the American format the UI uses."""
    value = coerce_float(probability)
    if value is None or value <= 0 or value >= 1:
        return None
    if value <= 0.5:
        return int(round((1 - value) / value * 100))
    return int(round(-value / (1 - value) * 100))


def american_to_probability(american: Any) -> Optional[float]:
    """American odds -> break-even win probability, vig included."""
    value = coerce_float(american)
    if value is None or value == 0:
        return None
    if value > 0:
        return 100 / (value + 100)
    return -value / (-value + 100)


def devig(over_probability: Optional[float], under_probability: Optional[float]) -> Optional[float]:
    """Fair P(over) from the two raw prices of a two-sided line.

    A sportsbook prices both sides above their true chance, so the pair sums
    past 1. Normalizing by that sum ("multiplicative" de-vigging) is the
    standard reduction and, for the balanced -112/-112 lines Underdog posts,
    returns exactly the 0.50 that makes the posted number the market's
    estimate. The exchanges need no such step, which is the point: after this
    every provider's Over price means the same thing.
    """
    if over_probability is None or under_probability is None:
        return None
    total = over_probability + under_probability
    if total <= 0:
        return None
    fair = over_probability / total
    return fair if 0 < fair < 1 else None


def book_quote(
    bid: Optional[float],
    ask: Optional[float],
    last: Optional[float],
    volume: Optional[float],
    max_spread: float,
) -> Optional[float]:
    """Best defensible YES price from one exchange order book.

    Prefer the midpoint of a tight two-sided book. When the book is one-sided
    or too wide, accept the last executed trade only if the contract has real
    volume and that trade still falls inside the current bid/ask bounds. This
    recovers categories such as passing touchdowns, whose live board can have
    no tight quotes at all, without inventing a midpoint from an empty side.
    """
    if (
        bid is not None
        and ask is not None
        and bid > 0
        and ask > bid
        and ask - bid <= max_spread
    ):
        return (bid + ask) / 2

    if last is None or volume is None or not 0 < last < 1 or volume <= 0:
        return None
    # A one-cent allowance covers the exchange tick while rejecting a stale
    # trade that now sits outside the observable book.
    if bid is not None and bid > 0 and last < bid - 0.01:
        return None
    if ask is not None and ask > 0 and last > ask + 0.01:
        return None
    return last


def monotonic_ladder(strikes: Iterable[Tuple[float, float]]) -> bool:
    """True if probability falls as the threshold rises (allowing 1c of noise).

    P(2000+ yards) can never be below P(3000+ yards). When the board says
    otherwise one of the two quotes is stale, and there is no way to tell
    which, so the caller drops the player's whole ladder for that market.
    """
    ordered = [probability for _, probability in sorted(strikes)]
    return all(ordered[i + 1] <= ordered[i] + 0.01 for i in range(len(ordered) - 1))


def ladder_rows(
    ladders: Dict[Tuple[str, str], List[Dict[str, Any]]],
    bookmaker: str,
) -> List[Dict[str, Any]]:
    """Turn per-player threshold ladders into Over/Under snapshot rows.

    ``ladders`` maps (player key, market) to quotes, each a dict of
    ``point``, ``probability``, ``name`` and ``quoted_at``. Ladders whose
    prices contradict each other are dropped whole; the survivors yield two
    rows per threshold so the read path can summarize them exactly like a
    sportsbook's two-sided line.
    """
    rows: List[Dict[str, Any]] = []
    for (player_key, market), quotes in ladders.items():
        if not monotonic_ladder((q["point"], q["probability"]) for q in quotes):
            continue
        for quote in quotes:
            probability = quote["probability"]
            shared = {
                "provider_player_id": player_key,
                "player_name_raw": quote["name"],
                "bookmaker": bookmaker,
                "market": market,
                "point": quote["point"],
                "quoted_at": quote.get("quoted_at"),
            }
            # YES and NO trade against one shared order book, so the Under is
            # the exact complement rather than an independently posted price.
            rows.append({
                **shared,
                "outcome": "Over",
                "price": probability_to_american(probability),
            })
            rows.append({
                **shared,
                "outcome": "Under",
                "price": probability_to_american(1 - probability),
            })
    return rows


# ── Kalshi ──────────────────────────────────────────────────────────────


def _player_key(raw: Dict[str, Any]) -> Optional[str]:
    """Kalshi's stable per-player identifier for a market.

    ``custom_strike.football_player`` is a UUID carried by every market on
    these series (960/960 in August 2026) and is the right key: it survives a
    ticker rename and cannot collide the way a name can. The ticker suffix
    (``KXNFLSEASONPASSYDS-27C3000-TSHOUGH6`` -> ``TSHOUGH6``) remains the
    fallback for any market that ever omits the custom strike.
    """
    custom_strike = raw.get("custom_strike")
    if isinstance(custom_strike, dict):
        player = custom_strike.get("football_player")
        if isinstance(player, str) and player:
            return player
    ticker = raw.get("ticker")
    if not isinstance(ticker, str):
        return None
    parts = ticker.split("-")
    return parts[-1] if len(parts) >= 3 and parts[-1] else None


def _quote(raw: Dict[str, Any], max_spread: float) -> Optional[float]:
    """Best defensible YES price from the current Kalshi market."""
    return book_quote(
        coerce_float(raw.get("yes_bid_dollars")),
        coerce_float(raw.get("yes_ask_dollars")),
        coerce_float(raw.get("last_price_dollars")),
        coerce_float(raw.get("volume_fp")),
        max_spread,
    )


def parse_season_props(
    payload: Any,
    max_spread: float = DEFAULT_MAX_SPREAD,
) -> List[Dict[str, Any]]:
    """Flatten Kalshi series payloads into Over/Under snapshot rows.

    ``payload`` maps a series ticker to that series' ``markets`` list.
    """
    if not isinstance(payload, dict):
        raise SeasonPropsError("season props payload was not an object")

    # (player, market) -> quotes, collected before any rows are emitted so
    # each ladder can be checked as a whole.
    ladders: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    for series_ticker, markets in payload.items():
        market = SEASON_PROP_SERIES.get(str(series_ticker))
        if not market or not isinstance(markets, list):
            continue
        for raw in markets:
            if not isinstance(raw, dict) or raw.get("status") != "active":
                continue
            player_key = _player_key(raw)
            name = raw.get("yes_sub_title")
            point = coerce_float(raw.get("floor_strike"))
            if not player_key or not name or point is None:
                continue
            probability = _quote(raw, max_spread)
            if probability is None:
                continue
            ladders.setdefault((player_key, market), []).append({
                "point": point,
                "probability": probability,
                "name": str(name),
                "quoted_at": parse_timestamp(raw.get("updated_time")),
            })
    return ladder_rows(ladders, BOOKMAKER)


class KalshiClient:
    name = BOOKMAKER

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
        """Fetch every series, surviving the loss of individual ones.

        Six categories behind one request each is six chances to fail. A
        flaky series used to abort the whole fetch and leave the run with
        nothing, so failures are collected instead and only raised when every
        series is gone -- which is the case that really means "the provider is
        down" rather than "passing touchdowns hiccupped".
        """
        payload: Dict[str, List[Dict[str, Any]]] = {}
        failures: List[str] = []
        for ticker in self.series:
            try:
                payload[ticker] = self._get_series(ticker)
            except SeasonPropsError as exc:
                failures.append(f"{ticker}: {exc}")
        if failures and not payload:
            raise SeasonPropsError("; ".join(failures))
        return payload

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
        data = request_json(
            f"{self.base_url}{path}", params, self.timeout, "the Kalshi season props API"
        )
        if not isinstance(data, dict):
            raise SeasonPropsError("Kalshi returned an unexpected response")
        return data

    def collect(self, season: int) -> List[Dict[str, Any]]:
        """Provider protocol: fetched and parsed rows, ready to store.

        Kalshi's series tickers already scope themselves to the current
        season, so the argument is accepted and unused.
        """
        return parse_season_props(self.get_season_props(), max_spread=self.max_spread)


season_props_client = KalshiClient()
