"""Read-only nflverse client.

nflverse publishes free CSVs of schedules and weekly player stats. We use
two feeds:
  * schedules/games — one row per game, id like ``2025_01_BUF_NYJ``.
  * weekly player stats — one row per player per week, keyed by ``player_id``
    which is the GSIS id (our crosswalk to Sleeper's ``gsis_id``).

URLs are configurable so the exact release path can change without a code
edit, and both parsers key on column names defensively (nflverse has
renamed columns across seasons). Parsing uses the stdlib ``csv`` module —
no pandas — to stay consistent with the rest of the backend.
"""
import csv
import io
import os
import socket
import urllib.error
import urllib.request
from datetime import datetime
from typing import Any, Dict, List, Optional

from app.services.fantasy_common import coerce_float, coerce_int, normalize_position

# Lee Sharpe / nflverse schedule file — stable, one row per game, all seasons.
DEFAULT_GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
# Weekly player stats release. {season} is substituted per fetch.
DEFAULT_WEEKLY_STATS_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/"
    "player_stats/player_stats_{season}.csv"
)


class NflverseError(Exception):
    """Raised when an nflverse CSV cannot be fetched or parsed."""


def _first(row: Dict[str, str], *keys: str) -> Optional[str]:
    """Return the first non-empty value among candidate column names."""
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return value
    return None


def _parse_kickoff(gameday: Optional[str], gametime: Optional[str]) -> Optional[datetime]:
    if not gameday:
        return None
    stamp = gameday.strip()
    time_part = (gametime or "").strip()
    for fmt, text in (("%Y-%m-%d %H:%M", f"{stamp} {time_part}"), ("%Y-%m-%d", stamp)):
        try:
            return datetime.strptime(text.strip(), fmt)
        except ValueError:
            continue
    return None


def parse_games_csv(text: str, season: Optional[int] = None) -> List[Dict[str, Any]]:
    """Parse a schedule CSV into game dicts, optionally filtered to a season."""
    reader = csv.DictReader(io.StringIO(text))
    games: List[Dict[str, Any]] = []
    for row in reader:
        game_id = _first(row, "game_id", "gsis")
        if not game_id:
            continue
        row_season = coerce_int(_first(row, "season"))
        if season is not None and row_season != season:
            continue
        games.append(
            {
                "game_id": game_id,
                "season": row_season,
                "week": coerce_int(_first(row, "week")),
                "game_type": _first(row, "game_type", "season_type"),
                "kickoff": _parse_kickoff(_first(row, "gameday", "gamedate"), _first(row, "gametime")),
                "home_team": _first(row, "home_team"),
                "away_team": _first(row, "away_team"),
                "home_score": coerce_int(_first(row, "home_score")),
                "away_score": coerce_int(_first(row, "away_score")),
            }
        )
    return games


def parse_weekly_stats_csv(text: str) -> List[Dict[str, Any]]:
    """Parse a weekly player stats CSV into per-player-week stat dicts.

    Each row carries the GSIS ``player_id`` (our crosswalk to Sleeper),
    fantasy points, and a compact ``stats`` mapping of the common box-score
    fields. Half-PPR is derived from standard + receptions when not present.
    """
    reader = csv.DictReader(io.StringIO(text))
    rows: List[Dict[str, Any]] = []
    for row in reader:
        gsis_id = _first(row, "player_id", "gsis_id")
        if not gsis_id:
            continue
        receptions = coerce_float(_first(row, "receptions")) or 0.0
        pts_ppr = coerce_float(_first(row, "fantasy_points_ppr"))
        pts_std = coerce_float(_first(row, "fantasy_points"))
        pts_half = None
        if pts_std is not None:
            pts_half = pts_std + 0.5 * receptions
        elif pts_ppr is not None:
            pts_half = pts_ppr - 0.5 * receptions

        stats = {
            "passing_yards": coerce_float(_first(row, "passing_yards")),
            "passing_tds": coerce_float(_first(row, "passing_tds")),
            "interceptions": coerce_float(_first(row, "interceptions", "passing_interceptions")),
            "rushing_yards": coerce_float(_first(row, "rushing_yards")),
            "rushing_tds": coerce_float(_first(row, "rushing_tds")),
            "receptions": receptions,
            "receiving_yards": coerce_float(_first(row, "receiving_yards")),
            "receiving_tds": coerce_float(_first(row, "receiving_tds")),
        }
        rows.append(
            {
                "gsis_id": gsis_id,
                "season": coerce_int(_first(row, "season")),
                "week": coerce_int(_first(row, "week")),
                "team": _first(row, "recent_team", "team"),
                "position": normalize_position(_first(row, "position")),
                "opponent": _first(row, "opponent_team", "opponent"),
                "fantasy_points_ppr": pts_ppr,
                "fantasy_points_half": pts_half,
                "fantasy_points_std": pts_std,
                "stats": {k: v for k, v in stats.items() if v is not None},
            }
        )
    return rows


class NflverseClient:
    def __init__(
        self,
        games_url: Optional[str] = None,
        weekly_stats_url: Optional[str] = None,
        timeout: Optional[float] = None,
    ):
        self.games_url = games_url or os.getenv("NFLVERSE_GAMES_URL") or DEFAULT_GAMES_URL
        self.weekly_stats_url = (
            weekly_stats_url or os.getenv("NFLVERSE_WEEKLY_STATS_URL") or DEFAULT_WEEKLY_STATS_URL
        )
        self.timeout = timeout or float(os.getenv("NFLVERSE_TIMEOUT_SECONDS", "60"))

    def get_schedule(self, season: int) -> List[Dict[str, Any]]:
        return parse_games_csv(self._download(self.games_url), season=season)

    def get_weekly_stats(self, season: int) -> List[Dict[str, Any]]:
        url = self.weekly_stats_url.format(season=season)
        return parse_weekly_stats_csv(self._download(url))

    def _download(self, url: str) -> str:
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "palmergill-fantasy/1.0"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.read().decode("utf-8")
        except socket.timeout as exc:
            raise NflverseError("Timed out waiting for nflverse CSV") from exc
        except urllib.error.HTTPError as exc:
            raise NflverseError(f"nflverse returned HTTP {exc.code} for {url}") from exc
        except urllib.error.URLError as exc:
            raise NflverseError(f"Could not reach nflverse: {exc}") from exc


nflverse_client = NflverseClient()
