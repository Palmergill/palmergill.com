"""Polymarket client and parser for NFL regular-season player totals.

Polymarket lists the same threshold contracts as Kalshi -- "1,099.5+ rushing
yards" priced as a Yes/No pair -- so a player again arrives as a ladder whose
YES prices form a survival curve, and the shared ladder machinery in
``fantasy_season_props`` applies unchanged.

It earns its place on two counts. Its passing-touchdown board (25 players in
August 2026) is twice Kalshi's, which is the category that decides whether
the implied fantasy points board has quarterbacks on it at all. And its
quotes actually move: every Kalshi market on that date carried an
``updated_time`` of August 10 or 12 and had not budged in eleven days, while
Polymarket's ``updatedAt`` was minutes old.

Discovery goes through the ``season-stats`` tag rather than a per-player
search. That tag also carries season *leader* markets ("2026-27 Passing Yards
Leader"), which are a different shape entirely, so events are matched on
their title -- ``Pro Football: <player> <season> Regular Season <category>``
-- and anything else is left alone. The player key comes from the event slug
with that same category-and-season suffix removed, which resolved uniquely
for all 241 player events on the live board.
"""
import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple

from app.services.fantasy_common import coerce_float
from app.services.fantasy_season_props import (
    DEFAULT_MAX_SPREAD,
    SeasonPropsError,
    book_quote,
    ladder_rows,
    parse_timestamp,
    request_json,
)

BOOKMAKER = "Polymarket"

# Polymarket's tag for season-long statistical markets.
SEASON_STATS_TAG = "105127"

# Title category -> the market key used by ff_season_prop_snapshots.
SEASON_CATEGORIES = {
    "Passing Yards": "season_pass_yds",
    "Passing Touchdowns": "season_pass_tds",
    "Rushing Yards": "season_rush_yds",
    "Rushing Touchdowns": "season_rush_tds",
    "Receiving Yards": "season_rec_yds",
    "Receiving Touchdowns": "season_rec_tds",
}

_TITLE = re.compile(
    r"^Pro Football: (?P<name>.+?) (?P<season>\d{4}-\d{2}) Regular Season "
    r"(?P<category>" + "|".join(SEASON_CATEGORIES) + r")$"
)

# "1,099.5+ rushing yards" -> 1099.5. Unlike Kalshi's floor_strike, the number
# in the title is already the half-point line, so it is used as posted.
_THRESHOLD = re.compile(r"^([\d,]+(?:\.\d+)?)\+")


def season_label(season: int) -> str:
    """2026 -> "2026-27", the span Polymarket titles a season with."""
    return f"{season}-{str(season + 1)[-2:]}"


def _slug_player_key(slug: Any, category: str, label: str) -> Optional[str]:
    """Event slug minus its category/season suffix, e.g. ``saquon-barkley``."""
    if not isinstance(slug, str):
        return None
    suffix = f"-{category.lower().replace(' ', '-')}-{label}"
    if not slug.endswith(suffix):
        return None
    return slug[: -len(suffix)] or None


def _threshold(market: Dict[str, Any]) -> Optional[float]:
    match = _THRESHOLD.match(str(market.get("groupItemTitle") or ""))
    if not match:
        return None
    return coerce_float(match.group(1).replace(",", ""))


def _is_open(market: Dict[str, Any]) -> bool:
    return bool(
        market.get("active")
        and not market.get("closed")
        and not market.get("archived")
        and market.get("acceptingOrders")
    )


def _yes_quote(market: Dict[str, Any], max_spread: float) -> Optional[float]:
    """Best defensible price for the Yes side of one threshold.

    ``bestBid``/``bestAsk`` describe the first outcome, so a market whose
    outcomes are not ordered Yes-then-No is skipped rather than read
    backwards -- an inverted probability would sail through the ladder check
    as a plausible-looking curve.
    """
    try:
        outcomes = json.loads(market.get("outcomes") or "[]")
    except (TypeError, ValueError):
        return None
    if not isinstance(outcomes, list) or not outcomes or outcomes[0] != "Yes":
        return None
    return book_quote(
        coerce_float(market.get("bestBid")),
        coerce_float(market.get("bestAsk")),
        coerce_float(market.get("lastTradePrice")),
        coerce_float(market.get("volumeNum")),
        max_spread,
    )


def parse_polymarket_props(
    payload: Any,
    season: int,
    max_spread: float = DEFAULT_MAX_SPREAD,
) -> List[Dict[str, Any]]:
    """Flatten a list of Polymarket events into Over/Under snapshot rows."""
    if not isinstance(payload, list):
        raise SeasonPropsError("Polymarket payload was not a list of events")
    label = season_label(season)

    ladders: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    for event in payload:
        if not isinstance(event, dict):
            continue
        title = _TITLE.match(str(event.get("title") or ""))
        if not title or title.group("season") != label:
            continue
        category = title.group("category")
        player_key = _slug_player_key(event.get("slug"), category, label)
        if not player_key:
            continue
        market_key = SEASON_CATEGORIES[category]
        name = title.group("name")

        markets = event.get("markets")
        if not isinstance(markets, list):
            continue
        for market in markets:
            if not isinstance(market, dict) or not _is_open(market):
                continue
            point = _threshold(market)
            if point is None:
                continue
            probability = _yes_quote(market, max_spread)
            if probability is None:
                continue
            ladders.setdefault((player_key, market_key), []).append({
                "point": point,
                "probability": probability,
                "name": name,
                "quoted_at": parse_timestamp(market.get("updatedAt")),
            })
    return ladder_rows(ladders, BOOKMAKER)


class PolymarketClient:
    name = BOOKMAKER

    # The API caps a page at 100 regardless of the limit asked for, and the
    # season-stats tag held 258 events in August 2026. The page bound stops an
    # offset that stops advancing from looping forever.
    PAGE_SIZE = 100
    MAX_PAGES = 20

    def __init__(
        self,
        base_url: Optional[str] = None,
        timeout: Optional[float] = None,
        max_spread: Optional[float] = None,
    ):
        self.base_url = (
            base_url
            or os.getenv("POLYMARKET_API_URL")
            or "https://gamma-api.polymarket.com"
        ).rstrip("/")
        self.timeout = timeout or float(os.getenv("POLYMARKET_TIMEOUT_SECONDS", "45"))
        self.max_spread = (
            max_spread
            if max_spread is not None
            else float(os.getenv("POLYMARKET_MAX_SPREAD", str(DEFAULT_MAX_SPREAD)))
        )

    @property
    def configured(self) -> bool:
        """Polymarket's Gamma API is public, so there is nothing to configure."""
        return os.getenv("POLYMARKET_ENABLED", "true").strip().lower() not in ("0", "false", "no")

    def get_season_props(self) -> List[Dict[str, Any]]:
        events: List[Dict[str, Any]] = []
        for page in range(self.MAX_PAGES):
            batch = self._request({
                "tag_id": SEASON_STATS_TAG,
                "related_tags": "false",
                "closed": "false",
                "limit": str(self.PAGE_SIZE),
                "offset": str(page * self.PAGE_SIZE),
            })
            events.extend(row for row in batch if isinstance(row, dict))
            if len(batch) < self.PAGE_SIZE:
                break
        return events

    def _request(self, params: Dict[str, str]) -> List[Any]:
        data = request_json(
            f"{self.base_url}/events", params, self.timeout, "the Polymarket Gamma API"
        )
        if not isinstance(data, list):
            raise SeasonPropsError("Polymarket returned an unexpected response")
        return data

    def collect(self, season: int) -> List[Dict[str, Any]]:
        """Provider protocol: fetched and parsed rows, ready to store."""
        return parse_polymarket_props(
            self.get_season_props(), season, max_spread=self.max_spread
        )


polymarket_props_client = PolymarketClient()
