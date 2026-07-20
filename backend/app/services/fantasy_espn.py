"""Keyless ESPN fantasy projection adapter.

ESPN's league-defaults endpoint is not formally documented, so this adapter
validates the response defensively and keeps it isolated from collection and
API code. Two default league profiles provide standard and PPR totals; half
PPR is the midpoint because the only scoring difference is 0.5 per reception.
"""
import json
import os
import socket
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from app.services.fantasy_common import coerce_float


ESPN_POSITION_IDS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF"}


class EspnProjectionError(Exception):
    """Raised when ESPN cannot serve or parse fantasy projections."""


class EspnProjectionClient:
    available = True

    def __init__(self, api_base: Optional[str] = None, timeout: Optional[float] = None):
        self.api_base = (
            api_base
            or os.getenv("ESPN_FANTASY_API_URL")
            or "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"
        ).rstrip("/")
        self.timeout = timeout or float(os.getenv("ESPN_FANTASY_TIMEOUT_SECONDS", "25"))

    def get_projections(self, season: int, week: int) -> List[Dict[str, Any]]:
        standard = self._get_profile(season, week, league_id=1)
        ppr = self._get_profile(season, week, league_id=3)
        ids = set(standard) | set(ppr)
        rows = []
        for espn_id in ids:
            std = standard.get(espn_id)
            ppr_row = ppr.get(espn_id)
            base = ppr_row or std
            if base is None:
                continue
            pts_std = std.get("points") if std else None
            pts_ppr = ppr_row.get("points") if ppr_row else None
            pts_half = None
            if pts_std is not None and pts_ppr is not None:
                pts_half = (pts_std + pts_ppr) / 2
            rows.append(
                {
                    "espn_id": espn_id,
                    "name": base["name"],
                    "position": base["position"],
                    "pts_ppr": pts_ppr,
                    "pts_half_ppr": pts_half,
                    "pts_std": pts_std,
                    "stats": {"espn_ppr": pts_ppr, "espn_standard": pts_std},
                }
            )
        return rows

    def _get_profile(self, season: int, week: int, league_id: int) -> Dict[str, Dict[str, Any]]:
        url = f"{self.api_base}/seasons/{season}/segments/0/leaguedefaults/{league_id}?view=kona_player_info"
        payload = self._request(url)
        return parse_projection_payload(payload, season, week)

    def _request(self, url: str) -> Any:
        fantasy_filter = {
            "players": {
                "filterSlotIds": {"value": [0, 2, 4, 6, 16, 17, 23]},
                "limit": 2000,
                "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
            }
        }
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "palmergill-fantasy/1.0",
                "X-Fantasy-Filter": json.dumps(fantasy_filter, separators=(",", ":")),
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
        except socket.timeout as exc:
            raise EspnProjectionError("Timed out waiting for ESPN projections") from exc
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise EspnProjectionError(f"ESPN returned HTTP {exc.code}: {detail[:200]}") from exc
        except urllib.error.URLError as exc:
            raise EspnProjectionError(f"Could not reach ESPN: {exc}") from exc
        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise EspnProjectionError("ESPN returned invalid JSON") from exc


def parse_projection_payload(payload: Any, season: int, week: int) -> Dict[str, Dict[str, Any]]:
    """Return ESPN-id keyed point totals for one scoring profile."""
    if not isinstance(payload, dict) or not isinstance(payload.get("players"), list):
        raise EspnProjectionError("ESPN projections payload had no players list")
    split_type = 0 if week == 0 else 1
    rows = {}
    for wrapper in payload["players"]:
        player = wrapper.get("player") if isinstance(wrapper, dict) else None
        if not isinstance(player, dict):
            continue
        espn_id = player.get("id")
        name = player.get("fullName")
        position = ESPN_POSITION_IDS.get(player.get("defaultPositionId"))
        if espn_id is None or not name or not position:
            continue
        points = None
        for stat in player.get("stats") or []:
            if not isinstance(stat, dict):
                continue
            if (
                stat.get("seasonId") == season
                and stat.get("scoringPeriodId") == week
                and stat.get("statSourceId") == 1
                and stat.get("statSplitTypeId") == split_type
            ):
                points = coerce_float(stat.get("appliedTotal"))
                break
        if points is None:
            continue
        rows[str(espn_id)] = {"name": str(name), "position": position, "points": points}
    return rows


espn_projection_client = EspnProjectionClient()
