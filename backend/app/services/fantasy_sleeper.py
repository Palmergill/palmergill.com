"""Read-only Sleeper API client.

Sleeper exposes two hosts:
  * api.sleeper.app  — the documented, key-less API (players, state, trending)
  * api.sleeper.com  — undocumented endpoints the community relies on for
    weekly projections and stats. These can change shape without notice, so
    the projection parser validates the payload and skips malformed rows
    rather than trusting it.

No API key is required. Sleeper asks callers to stay under ~1000 requests
per minute and to fetch the (~5MB) players dump at most once per day.
"""
import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from app.services.fantasy_common import SKILL_POSITIONS, coerce_float, coerce_int


class SleeperError(Exception):
    """Raised when Sleeper cannot serve a read-only request."""


class SleeperClient:
    def __init__(
        self,
        api_base: Optional[str] = None,
        data_base: Optional[str] = None,
        timeout: Optional[float] = None,
    ):
        # Documented host (players/state/trending).
        self.api_base = (api_base or os.getenv("SLEEPER_API_URL") or "https://api.sleeper.app/v1").rstrip("/")
        # Undocumented host (projections/stats).
        self.data_base = (data_base or os.getenv("SLEEPER_DATA_URL") or "https://api.sleeper.com").rstrip("/")
        self.timeout = timeout or float(os.getenv("SLEEPER_TIMEOUT_SECONDS", "20"))

    # ── documented endpoints ────────────────────────────────────────────

    def get_players(self) -> Dict[str, Any]:
        """Full NFL player dump keyed by Sleeper player_id (~5MB)."""
        data = self._request(f"{self.api_base}/players/nfl")
        if not isinstance(data, dict):
            raise SleeperError("Sleeper players dump was not a JSON object")
        return data

    def get_state(self) -> Dict[str, Any]:
        data = self._request(f"{self.api_base}/state/nfl")
        if not isinstance(data, dict):
            raise SleeperError("Sleeper state was not a JSON object")
        return data

    def get_trending(self, kind: str, lookback_hours: int = 24, limit: int = 25) -> List[Dict[str, Any]]:
        if kind not in ("add", "drop"):
            raise ValueError("trending kind must be 'add' or 'drop'")
        query = urllib.parse.urlencode({"lookback_hours": lookback_hours, "limit": limit})
        data = self._request(f"{self.api_base}/players/nfl/trending/{kind}?{query}")
        if not isinstance(data, list):
            raise SleeperError("Sleeper trending response was not a JSON array")
        return data

    # ── undocumented endpoints ──────────────────────────────────────────

    def get_projections(self, season: int, week: int, season_type: str = "regular") -> List[Dict[str, Any]]:
        """Weekly projections. Returns normalized rows (see parse_projection_rows)."""
        query = urllib.parse.urlencode({"season_type": season_type})
        data = self._request(f"{self.data_base}/projections/nfl/{season}/{week}?{query}")
        return parse_projection_rows(data)

    def get_season_projections(self, season: int, season_type: str = "regular") -> List[Dict[str, Any]]:
        """Full-season projections (the no-week variant of the endpoint).

        Sleeper publishes these for the upcoming season during the offseason;
        stats hold season totals (e.g. pts_ppr ~350 for a top QB).
        """
        params = [("season_type", season_type), ("order_by", "pts_ppr")]
        params += [("position[]", pos) for pos in SKILL_POSITIONS]
        query = urllib.parse.urlencode(params)
        data = self._request(f"{self.data_base}/projections/nfl/{season}?{query}")
        return parse_projection_rows(data)

    # ── transport ───────────────────────────────────────────────────────

    def _request(self, url: str) -> Any:
        request = urllib.request.Request(
            url,
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
            raise SleeperError("Timed out waiting for Sleeper response") from exc
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise SleeperError(f"Sleeper returned HTTP {exc.code}: {detail[:200]}") from exc
        except urllib.error.URLError as exc:
            raise SleeperError(f"Could not reach Sleeper: {exc}") from exc

        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise SleeperError("Sleeper returned invalid JSON") from exc


def parse_projection_rows(payload: Any) -> List[Dict[str, Any]]:
    """Validate and normalize a Sleeper projections payload.

    Accepts either a list of row objects or a dict keyed by player_id (the
    endpoint has been observed in both shapes). Each yielded row is:
        {player_id, pts_ppr, pts_half_ppr, pts_std, stats}
    Rows without a player_id or a stats mapping are dropped — this is the
    shape-validation guard that keeps a changed payload from poisoning the DB.
    """
    if isinstance(payload, dict):
        items = list(payload.values())
    elif isinstance(payload, list):
        items = payload
    else:
        raise SleeperError("Sleeper projections payload was neither a list nor an object")

    rows: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        player_id = item.get("player_id")
        stats = item.get("stats")
        if player_id is None or not isinstance(stats, dict):
            continue
        rows.append(
            {
                "player_id": str(player_id),
                "pts_ppr": coerce_float(stats.get("pts_ppr")),
                "pts_half_ppr": coerce_float(stats.get("pts_half_ppr")),
                "pts_std": coerce_float(stats.get("pts_std")),
                "stats": stats,
            }
        )
    return rows


def parse_trending_rows(payload: Any) -> List[Dict[str, Any]]:
    """Normalize a Sleeper trending payload to [{player_id, count}]."""
    if not isinstance(payload, list):
        raise SleeperError("Sleeper trending payload was not a list")
    rows: List[Dict[str, Any]] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        player_id = item.get("player_id")
        if player_id is None:
            continue
        rows.append({"player_id": str(player_id), "count": coerce_int(item.get("count"))})
    return rows


sleeper_client = SleeperClient()
