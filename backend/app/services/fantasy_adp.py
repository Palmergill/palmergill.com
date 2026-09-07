"""Average draft position from Fantasy Football Calculator.

FFC publishes a keyless JSON summary of the drafts run on its own mock-draft
tool: one row per player with the mean pick, the spread, and how many drafts
that mean is built from. It is the only free ADP source that reports a
standard deviation, which is what makes a "reach" measurable rather than
merely visible -- comparing raw pick numbers across league formats is
apples-to-oranges, comparing (adp - pick) / stdev is not.

Format caveat, deliberately surfaced rather than hidden: FFC's superflex
proxy is its ``2qb`` board, and 2QB is not superflex -- a 2QB league forces a
second quarterback where superflex merely permits one, so quarterbacks go a
little earlier there. The sigma normalization above absorbs most of that, and
``half_ppr`` is collected alongside as a cross-check.
"""
import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

from app.services.fantasy_common import coerce_float, coerce_int

# The formats we collect, keyed by the storage value. FFC's own path segment
# differs from the key we store ("half-ppr" vs "half_ppr"), so keep both.
ADP_FORMATS = {
    "2qb": "2qb",
    "half_ppr": "half-ppr",
}

# The league this site follows is superflex, so the 2QB board is the one the
# draft recap grades against; half-PPR is the general-purpose reference.
PRIMARY_FORMAT = "2qb"

# FFC spells kickers "PK" and defenses "DEF". DEF already matches the site's
# internal spelling; PK does not.
_POSITION_ALIASES = {"PK": "K", "DST": "DEF", "D/ST": "DEF"}


class AdpError(Exception):
    """Raised when FFC cannot serve or parse an ADP board."""


class AdpClient:
    def __init__(self, api_base: Optional[str] = None, timeout: Optional[float] = None):
        self.api_base = (
            api_base
            or os.getenv("FFC_API_URL")
            or "https://fantasyfootballcalculator.com/api/v1"
        ).rstrip("/")
        self.timeout = timeout or float(os.getenv("FFC_TIMEOUT_SECONDS", "20"))

    def get_adp(self, season: int, fmt: str = PRIMARY_FORMAT, teams: int = 10) -> Dict[str, Any]:
        """Fetch one ADP board. Returns {"meta": {...}, "players": [...]}."""
        slug = ADP_FORMATS.get(fmt)
        if slug is None:
            raise ValueError(f"unknown ADP format: {fmt}")
        query = urllib.parse.urlencode(
            {"teams": teams, "year": season, "position": "all"}
        )
        payload = self._request(f"{self.api_base}/adp/{slug}?{query}")
        return parse_adp(payload, fmt=fmt, teams=teams, season=season)

    def _request(self, url: str) -> Dict[str, Any]:
        request = urllib.request.Request(
            url,
            headers={"Accept": "application/json", "User-Agent": "palmergill-fantasy/1.0"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
        except socket.timeout as exc:
            raise AdpError("Timed out waiting for Fantasy Football Calculator") from exc
        except urllib.error.HTTPError as exc:
            raise AdpError(f"FFC returned HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise AdpError(f"Could not reach FFC: {exc}") from exc
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            raise AdpError("FFC returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise AdpError("FFC ADP payload was not an object")
        return payload


def parse_adp(
    payload: Any, fmt: str, teams: int, season: Optional[int] = None
) -> Dict[str, Any]:
    """Validate and normalize an FFC ADP board. Pure and network-free.

    ``meta`` echoes the sample the board was built from -- how many drafts and
    over what window -- because a recap that grades a draft against ADP has to
    be able to say which ADP it means.
    """
    if not isinstance(payload, dict):
        raise AdpError("FFC ADP payload was not an object")
    if str(payload.get("status") or "").lower() not in ("success", ""):
        raise AdpError(f"FFC reported status {payload.get('status')!r}")

    raw_players = payload.get("players")
    if not isinstance(raw_players, list):
        raise AdpError("FFC ADP payload had no players list")

    raw_meta = payload.get("meta")
    meta_in = raw_meta if isinstance(raw_meta, dict) else {}
    meta = {
        "format": fmt,
        # FFC labels the 2QB board "2 QB"; the requested format is the key we
        # store, and its own label is kept only for display.
        "source_label": meta_in.get("type"),
        "teams": coerce_int(meta_in.get("teams")) or teams,
        "rounds": coerce_int(meta_in.get("rounds")),
        "total_drafts": coerce_int(meta_in.get("total_drafts")),
        "start_date": meta_in.get("start_date"),
        "end_date": meta_in.get("end_date"),
        "season": season,
    }

    players: List[Dict[str, Any]] = []
    for row in raw_players:
        if not isinstance(row, dict):
            continue
        name = row.get("name")
        adp = coerce_float(row.get("adp"))
        if not name or adp is None:
            # A row without a name or a mean pick cannot be joined or graded.
            continue
        position = (row.get("position") or "").strip().upper()
        players.append(
            {
                "provider_player_id": row.get("player_id"),
                "name": name,
                "position": _POSITION_ALIASES.get(position, position) or None,
                "team": (row.get("team") or "").strip().upper() or None,
                "adp": adp,
                "adp_formatted": row.get("adp_formatted"),
                "adp_stdev": coerce_float(row.get("stdev")),
                "adp_high": coerce_int(row.get("high")),
                "adp_low": coerce_int(row.get("low")),
                "times_drafted": coerce_int(row.get("times_drafted")),
                "bye": coerce_int(row.get("bye")),
            }
        )

    if not players:
        raise AdpError("FFC ADP board had no usable player rows")
    return {"meta": meta, "players": players}


adp_client = AdpClient()
