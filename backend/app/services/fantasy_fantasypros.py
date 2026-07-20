"""Read-only FantasyPros NFL projections client.

FantasyPros is an optional second projection source. Its public partner API
requires an ``x-api-key`` header, so the collector only calls it when
``FANTASYPROS_API_KEY`` is configured.
"""
import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from app.services.fantasy_common import coerce_float, normalize_position


class FantasyProsError(Exception):
    """Raised when FantasyPros cannot serve or parse a projections request."""


class FantasyProsClient:
    def __init__(
        self,
        api_key: Optional[str] = None,
        api_base: Optional[str] = None,
        timeout: Optional[float] = None,
    ):
        self.api_key = api_key or os.getenv("FANTASYPROS_API_KEY")
        self.api_base = (api_base or "https://api.fantasypros.com/v2/json").rstrip("/")
        self.timeout = timeout or float(os.getenv("FANTASYPROS_TIMEOUT_SECONDS", "20"))

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def get_projections(self, season: int, week: int) -> List[Dict[str, Any]]:
        if not self.api_key:
            raise FantasyProsError("FANTASYPROS_API_KEY is not configured")
        query = urllib.parse.urlencode(
            {
                "week": week,
                "positions": "QB:RB:WR:TE:DST:K",
                "scoring": "PPR",
            }
        )
        payload = self._request(f"{self.api_base}/nfl/{season}/projections?{query}")
        return parse_projection_rows(payload)

    def _request(self, url: str) -> Any:
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "palmergill-fantasy/1.0",
                "x-api-key": self.api_key or "",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
        except socket.timeout as exc:
            raise FantasyProsError("Timed out waiting for FantasyPros") from exc
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise FantasyProsError(f"FantasyPros returned HTTP {exc.code}: {detail[:200]}") from exc
        except urllib.error.URLError as exc:
            raise FantasyProsError(f"Could not reach FantasyPros: {exc}") from exc

        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise FantasyProsError("FantasyPros returned invalid JSON") from exc


def parse_projection_rows(payload: Any) -> List[Dict[str, Any]]:
    """Validate and normalize FantasyPros' ``players`` projection payload."""
    if not isinstance(payload, dict):
        raise FantasyProsError("FantasyPros projections payload was not an object")
    players = payload.get("players")
    if not isinstance(players, list):
        raise FantasyProsError("FantasyPros projections payload had no players list")

    rows = []
    for raw in players:
        if not isinstance(raw, dict) or not isinstance(raw.get("stats"), dict):
            continue
        name = raw.get("name") or raw.get("player_name")
        position = normalize_position(raw.get("position_id") or raw.get("position"))
        if not name or not position:
            continue
        stats = raw["stats"]
        pts_std = coerce_float(stats.get("points"))
        pts_ppr = coerce_float(stats.get("points_ppr"))
        pts_half_ppr = coerce_float(stats.get("points_half"))
        # FantasyPros omits the specialized fields when reception scoring does
        # not change the total (commonly QB, K, and DST rows).
        if pts_ppr is None:
            pts_ppr = pts_std
        if pts_half_ppr is None:
            pts_half_ppr = pts_std
        rows.append(
            {
                "name": str(name),
                "team": raw.get("team_id") or raw.get("team"),
                "position": position,
                "pts_ppr": pts_ppr,
                "pts_half_ppr": pts_half_ppr,
                "pts_std": pts_std,
                "stats": stats,
            }
        )
    return rows


fantasypros_client = FantasyProsClient()
