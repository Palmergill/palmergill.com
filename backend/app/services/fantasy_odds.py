"""Read-only client for The Odds API (v4).

Free tier is 500 credits/month. Cost accounting (used by the collector's
budget guard):
  * the events list is free (0 credits),
  * the /odds endpoint costs (markets x regions) credits per call,
  * per-event props cost (markets x regions) per event,
  * an outrights (futures) call costs (1 x regions) per sport key.

We read the ``x-requests-remaining`` response header after each call so the
admin view can show the provider's own count, but the collector's run-log
sum is the source of truth for enforcement.

Everything is gated on ODDS_API_KEY; without it ``configured`` is False and
the collector records a skipped run instead of calling out.
"""
import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.services.fantasy_common import coerce_float, coerce_int, team_abbr

SPORT_KEY = "americanfootball_nfl"
GAME_MARKETS = ("h2h", "spreads", "totals")
# Player prop markets we collect (each costs 1 credit x regions per event).
PROP_MARKETS = (
    "player_pass_yds",
    "player_rush_yds",
    "player_reception_yds",
    "player_receptions",
    "player_anytime_td",
)
# Season-long futures (outrights). One credit x regions each.
FUTURES_MARKETS = (
    "americanfootball_nfl_super_bowl_winner",
    "americanfootball_nfl_afc_championship_winner",
    "americanfootball_nfl_nfc_championship_winner",
)


class OddsApiError(Exception):
    """Raised when The Odds API cannot serve a request."""


def _parse_time(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        # ISO 8601, e.g. "2026-09-10T00:20:00Z"
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)
    except (ValueError, AttributeError):
        return None


class OddsApiClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        regions: Optional[str] = None,
        timeout: Optional[float] = None,
    ):
        self.api_key = api_key if api_key is not None else os.getenv("ODDS_API_KEY")
        self.base_url = (base_url or os.getenv("ODDS_API_URL") or "https://api.the-odds-api.com/v4").rstrip("/")
        self.regions = regions or os.getenv("ODDS_API_REGIONS", "us")
        self.timeout = timeout or float(os.getenv("ODDS_API_TIMEOUT_SECONDS", "20"))
        self.last_remaining: Optional[int] = None

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    @property
    def region_count(self) -> int:
        return len([r for r in self.regions.split(",") if r.strip()]) or 1

    def game_odds_cost(self, markets=GAME_MARKETS) -> int:
        return len(markets) * self.region_count

    def event_props_cost(self, markets=PROP_MARKETS) -> int:
        return len(markets) * self.region_count

    def futures_cost(self) -> int:
        return self.region_count

    # ── endpoints ───────────────────────────────────────────────────────

    def get_events(self) -> List[Dict[str, Any]]:
        """List upcoming events (free — no markets requested)."""
        data = self._request(f"/sports/{SPORT_KEY}/events", {})
        return data if isinstance(data, list) else []

    def get_game_odds(self, markets=GAME_MARKETS) -> List[Dict[str, Any]]:
        params = {"regions": self.regions, "markets": ",".join(markets), "oddsFormat": "american"}
        data = self._request(f"/sports/{SPORT_KEY}/odds", params)
        return data if isinstance(data, list) else []

    def get_event_props(self, event_id: str, markets=PROP_MARKETS) -> Dict[str, Any]:
        params = {"regions": self.regions, "markets": ",".join(markets), "oddsFormat": "american"}
        data = self._request(f"/sports/{SPORT_KEY}/events/{urllib.parse.quote(event_id)}/odds", params)
        return data if isinstance(data, dict) else {}

    def get_futures(self, market_key: str) -> List[Dict[str, Any]]:
        params = {"regions": self.regions, "markets": "outrights", "oddsFormat": "american"}
        data = self._request(f"/sports/{urllib.parse.quote(market_key)}/odds", params)
        return data if isinstance(data, list) else []

    # ── transport ───────────────────────────────────────────────────────

    def _request(self, path: str, params: Dict[str, str]) -> Any:
        if not self.configured:
            raise OddsApiError("ODDS_API_KEY is not set")
        query = urllib.parse.urlencode({**params, "apiKey": self.api_key})
        url = f"{self.base_url}{path}?{query}"
        request = urllib.request.Request(
            url, headers={"Accept": "application/json", "User-Agent": "palmergill-fantasy/1.0"}, method="GET"
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                remaining = response.headers.get("x-requests-remaining")
                self.last_remaining = coerce_int(remaining)
                body = response.read().decode("utf-8")
        except socket.timeout as exc:
            raise OddsApiError("Timed out waiting for The Odds API") from exc
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise OddsApiError(f"The Odds API returned HTTP {exc.code}: {detail[:200]}") from exc
        except urllib.error.URLError as exc:
            raise OddsApiError(f"Could not reach The Odds API: {exc}") from exc
        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise OddsApiError("The Odds API returned invalid JSON") from exc


# ── parsers (network-free, unit-tested against fixtures) ────────────────


def parse_game_odds(events: Any) -> List[Dict[str, Any]]:
    """Flatten a /odds payload into per-outcome snapshot dicts.

    Team names are mapped to abbreviations; Over/Under outcomes pass through.
    """
    if not isinstance(events, list):
        raise OddsApiError("game odds payload was not a list")
    rows: List[Dict[str, Any]] = []
    for event in events:
        if not isinstance(event, dict):
            continue
        event_id = event.get("id")
        if not event_id:
            continue
        home = team_abbr(event.get("home_team"))
        away = team_abbr(event.get("away_team"))
        commence = _parse_time(event.get("commence_time"))
        for bookmaker in event.get("bookmakers", []) or []:
            book_key = bookmaker.get("key")
            for market in bookmaker.get("markets", []) or []:
                market_key = market.get("key")
                for outcome in market.get("outcomes", []) or []:
                    rows.append(
                        {
                            "event_id": str(event_id),
                            "home_team": home,
                            "away_team": away,
                            "commence_time": commence,
                            "bookmaker": book_key,
                            "market": market_key,
                            "outcome": team_abbr(outcome.get("name")),
                            "price": coerce_int(outcome.get("price")),
                            "point": coerce_float(outcome.get("point")),
                        }
                    )
    return rows


def parse_event_props(event: Any) -> List[Dict[str, Any]]:
    """Flatten a per-event props payload into snapshot dicts.

    The player name lives in each outcome's ``description``; ``name`` is
    Over/Under/Yes.
    """
    if not isinstance(event, dict):
        raise OddsApiError("event props payload was not an object")
    event_id = event.get("id")
    rows: List[Dict[str, Any]] = []
    for bookmaker in event.get("bookmakers", []) or []:
        book_key = bookmaker.get("key")
        for market in bookmaker.get("markets", []) or []:
            market_key = market.get("key")
            for outcome in market.get("outcomes", []) or []:
                name = outcome.get("description")
                if not name:
                    continue
                rows.append(
                    {
                        "event_id": str(event_id) if event_id else None,
                        "player_name_raw": name,
                        "bookmaker": book_key,
                        "market": market_key,
                        "outcome": outcome.get("name"),
                        "price": coerce_int(outcome.get("price")),
                        "point": coerce_float(outcome.get("point")),
                    }
                )
    return rows


def parse_futures(events: Any) -> List[Dict[str, Any]]:
    """Flatten an outrights payload into {bookmaker, outcome, price} rows."""
    if not isinstance(events, list):
        raise OddsApiError("futures payload was not a list")
    rows: List[Dict[str, Any]] = []
    for event in events:
        if not isinstance(event, dict):
            continue
        for bookmaker in event.get("bookmakers", []) or []:
            book_key = bookmaker.get("key")
            for market in bookmaker.get("markets", []) or []:
                for outcome in market.get("outcomes", []) or []:
                    name = outcome.get("name")
                    if not name:
                        continue
                    rows.append(
                        {
                            "bookmaker": book_key,
                            "outcome": name,
                            "price": coerce_int(outcome.get("price")),
                        }
                    )
    return rows


odds_client = OddsApiClient()
