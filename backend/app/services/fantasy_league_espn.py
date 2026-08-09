"""ESPN fantasy *league* adapter (spec 17).

Reads one configured ESPN league keyless. ESPN's league endpoints are not
formally documented, so — like ``fantasy_espn`` — this module validates the
response defensively and keeps parsing isolated from collection and API code.
Every ``parse_*`` function is pure and network-free so the tests can exercise
the real payload shapes from fixtures.

Access model: the league must be publicly viewable in ESPN's league settings.
We deliberately do not support ``espn_s2``/``SWID`` cookie auth — storing a
personal session cookie that silently expires is worse than requiring the
commissioner to flip one visibility toggle. A season that is still private
raises ``EspnLeagueUnauthorized``, which the collector records as a visible
"unauthorized" state rather than an error.
"""
import json
import logging
import os
import socket
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from app.services.fantasy_common import coerce_float, coerce_int

logger = logging.getLogger(__name__)

DEFAULT_LEAGUE_ID = "225965"
DEFAULT_SEASONS = (2023, 2024, 2025, 2026)

# ESPN uses two different id spaces for "what position is this". A player's
# `defaultPositionId` and the roster slot they occupy disagree (K is 5 as a
# position but 17 as a slot), so they need separate maps.
ESPN_POSITION_IDS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF"}

ESPN_LINEUP_SLOTS = {
    0: "QB",
    1: "TQB",
    2: "RB",
    3: "RB/WR",
    4: "WR",
    5: "WR/TE",
    6: "TE",
    7: "OP",
    16: "DST",
    17: "K",
    18: "P",
    19: "HC",
    20: "BENCH",
    21: "IR",
    23: "FLEX",
}

# Slots whose occupants are actually in the starting lineup.
BENCH_SLOTS = frozenset({"BENCH", "IR"})

# ESPN proTeamId -> abbreviation, verified against ESPN's own proTeams list.
# NOTE: ESPN spells Washington "WSH"; the site's NFL_TEAM_ABBR uses "WAS", and
# ff_players.team follows the site spelling. This map emits the *site* value so
# the D/ST crosswalk and any team joins line up. A test asserts every value
# here appears in NFL_TEAM_ABBR.
ESPN_PRO_TEAM_ABBR = {
    1: "ATL",
    2: "BUF",
    3: "CHI",
    4: "CIN",
    5: "CLE",
    6: "DAL",
    7: "DEN",
    8: "DET",
    9: "GB",
    10: "TEN",
    11: "IND",
    12: "KC",
    13: "LV",
    14: "LAR",
    15: "MIA",
    16: "MIN",
    17: "NE",
    18: "NO",
    19: "NYG",
    20: "NYJ",
    21: "PHI",
    22: "ARI",
    23: "PIT",
    24: "LAC",
    25: "SF",
    26: "SEA",
    27: "TB",
    28: "WAS",  # ESPN says WSH
    29: "CAR",
    30: "JAX",
    33: "BAL",
    34: "HOU",
}

# ESPN gives team defenses a synthetic negative player id: -16000 - proTeamId
# (verified: -16007 = Broncos, proTeamId 7). Sleeper keys its DEF rows by team
# abbreviation instead, so this is the bridge between the two id spaces.
DST_PLAYER_ID_OFFSET = -16000


class EspnLeagueError(Exception):
    """Raised when ESPN cannot serve or parse league data."""


class EspnLeagueUnauthorized(EspnLeagueError):
    """Raised when a season is private (HTTP 401).

    Distinct from EspnLeagueError because it is an expected, stable state for
    seasons the commissioner never made public — not a failure to react to.
    """


def configured_league_id() -> str:
    """The league id used as a storage key. Always returns a value."""
    return (os.getenv("ESPN_LEAGUE_ID") or DEFAULT_LEAGUE_ID).strip()


def league_collection_enabled() -> bool:
    """Whether the scheduler should collect the league at all.

    An explicit ``ESPN_LEAGUE_ID`` opts any environment in. Railway deployments
    also opt in because this service owns the built-in default league and
    Railway supplies ``RAILWAY_PROJECT_ID`` to every deployment. Fresh clones,
    local runs, and tests still stay network-off unless they explicitly opt in.

    Keying the production default to the platform marker avoids a silent empty
    hub when a newly introduced variable has not been added to Railway yet.
    """
    return bool(
        (os.getenv("ESPN_LEAGUE_ID") or "").strip()
        or (os.getenv("RAILWAY_PROJECT_ID") or "").strip()
    )


def configured_seasons() -> List[int]:
    """Seasons to collect, oldest first.

    An explicit list beats probing: it makes a private season a *recorded*
    state we can show in the UI rather than an absence nobody notices.
    """
    raw = (os.getenv("ESPN_LEAGUE_SEASONS") or "").strip()
    if not raw:
        return list(DEFAULT_SEASONS)
    seasons = []
    for chunk in raw.split(","):
        season = coerce_int(chunk.strip())
        if season:
            seasons.append(season)
    return sorted(set(seasons)) or list(DEFAULT_SEASONS)


class EspnLeagueClient:
    def __init__(
        self,
        api_base: Optional[str] = None,
        league_id: Optional[str] = None,
        timeout: Optional[float] = None,
    ):
        self.api_base = (
            api_base
            or os.getenv("ESPN_FANTASY_API_URL")
            or "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"
        ).rstrip("/")
        self._league_id = league_id
        self.timeout = timeout or float(os.getenv("ESPN_LEAGUE_TIMEOUT_SECONDS", "25"))

    @property
    def league_id(self) -> str:
        return self._league_id or configured_league_id()

    def get_views(self, season: int, views: List[str]) -> Dict[str, Any]:
        query = "&".join(f"view={view}" for view in views)
        url = (
            f"{self.api_base}/seasons/{season}/segments/0/leagues/{self.league_id}?{query}"
        )
        return self._request(url)

    def get_league(self, season: int) -> Dict[str, Any]:
        """Settings, members, teams, and current rosters in one call."""
        return self.get_views(season, ["mSettings", "mTeam", "mRoster"])

    def get_schedule(self, season: int) -> Dict[str, Any]:
        """Full season schedule with scores.

        Requested on its own: in an active season mMatchupScore embeds
        `rosterForCurrentScoringPeriod` with per-player stat blobs for every
        team, and bundling it with mRoster makes the response very large.
        """
        return self.get_views(season, ["mMatchupScore"])

    def _request(self, url: str) -> Dict[str, Any]:
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
            raise EspnLeagueError("Timed out waiting for ESPN league data") from exc
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            if exc.code == 401:
                raise EspnLeagueUnauthorized(
                    "ESPN returned 401 — this season is not publicly viewable"
                ) from exc
            raise EspnLeagueError(f"ESPN returned HTTP {exc.code}: {detail[:200]}") from exc
        except urllib.error.URLError as exc:
            raise EspnLeagueError(f"Could not reach ESPN: {exc}") from exc
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            raise EspnLeagueError("ESPN returned invalid JSON") from exc
        # Some ESPN league endpoints return a single-element list wrapper.
        if isinstance(payload, list):
            payload = payload[0] if payload else {}
        if not isinstance(payload, dict):
            raise EspnLeagueError("ESPN league payload was not an object")
        return payload


# ── pure parsers ────────────────────────────────────────────────────────


def _require_dict(payload: Any, what: str) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise EspnLeagueError(f"ESPN {what} payload was not an object")
    return payload


def parse_settings(payload: Any, season: int) -> Dict[str, Any]:
    payload = _require_dict(payload, "league")
    settings = payload.get("settings")
    if not isinstance(settings, dict):
        raise EspnLeagueError("ESPN league payload had no settings block")
    schedule_settings = settings.get("scheduleSettings") or {}
    roster_settings = settings.get("rosterSettings") or {}
    status = payload.get("status") or {}
    divisions = schedule_settings.get("divisions")
    return {
        "season": season,
        "name": settings.get("name"),
        "size": coerce_int(settings.get("size")),
        "current_matchup_period": coerce_int(status.get("currentMatchupPeriod")),
        "current_scoring_period": coerce_int(payload.get("scoringPeriodId")),
        "first_scoring_period": coerce_int(status.get("firstScoringPeriod")),
        "matchup_period_count": coerce_int(schedule_settings.get("matchupPeriodCount")),
        "regular_season_periods": coerce_int(
            schedule_settings.get("regularSeasonMatchupPeriodCount")
        ),
        "playoff_team_count": coerce_int(schedule_settings.get("playoffTeamCount")),
        "divisions_json": json.dumps(divisions) if divisions is not None else None,
        "lineup_slot_counts_json": (
            json.dumps(roster_settings.get("lineupSlotCounts"))
            if roster_settings.get("lineupSlotCounts") is not None
            else None
        ),
    }


def parse_members(payload: Any) -> List[Dict[str, Any]]:
    payload = _require_dict(payload, "league")
    members = payload.get("members")
    if not isinstance(members, list):
        return []
    rows = []
    for member in members:
        if not isinstance(member, dict):
            continue
        guid = member.get("id")
        if not guid:
            continue
        rows.append(
            {
                "member_guid": str(guid),
                "display_name": member.get("displayName"),
                "first_name": member.get("firstName"),
                "last_name": member.get("lastName"),
            }
        )
    return rows


def _division_names(payload: Dict[str, Any]) -> Dict[int, str]:
    settings = payload.get("settings") or {}
    divisions = (settings.get("scheduleSettings") or {}).get("divisions")
    names: Dict[int, str] = {}
    if isinstance(divisions, list):
        for division in divisions:
            if not isinstance(division, dict):
                continue
            division_id = coerce_int(division.get("id"))
            if division_id is not None:
                names[division_id] = division.get("name")
    return names


def parse_teams(payload: Any, members_by_guid: Optional[Dict[str, str]] = None) -> List[Dict[str, Any]]:
    """Teams with standings, joined to human owner names.

    ESPN exposes ownership as a GUID on the team and the display names in a
    separate top-level `members` list, so the caller passes the crosswalk in.
    An unmatched GUID leaves owner_name None rather than failing the parse.
    """
    payload = _require_dict(payload, "league")
    teams = payload.get("teams")
    if not isinstance(teams, list):
        raise EspnLeagueError("ESPN league payload had no teams list")

    members_by_guid = members_by_guid or {}
    division_names = _division_names(payload)
    rows = []
    for team in teams:
        if not isinstance(team, dict):
            continue
        espn_team_id = coerce_int(team.get("id"))
        if espn_team_id is None:
            continue
        owners = team.get("owners")
        owner_guid = None
        if isinstance(owners, list) and owners:
            owner_guid = str(owners[0])
        record = (team.get("record") or {}).get("overall") or {}
        division_id = coerce_int(team.get("divisionId"))
        rows.append(
            {
                "espn_team_id": espn_team_id,
                "name": team.get("name"),
                "abbrev": team.get("abbrev"),
                "logo_url": team.get("logo"),
                "division_id": division_id,
                "division_name": division_names.get(division_id),
                "owner_guid": owner_guid,
                "owner_name": members_by_guid.get(owner_guid) if owner_guid else None,
                "playoff_seed": coerce_int(team.get("playoffSeed")),
                "wins": coerce_int(record.get("wins")) or 0,
                "losses": coerce_int(record.get("losses")) or 0,
                "ties": coerce_int(record.get("ties")) or 0,
                "points_for": coerce_float(record.get("pointsFor")) or 0.0,
                "points_against": coerce_float(record.get("pointsAgainst")) or 0.0,
                "win_pct": coerce_float(record.get("percentage")) or 0.0,
                "streak_length": coerce_int(record.get("streakLength")),
                "streak_type": record.get("streakType"),
                "games_back": coerce_float(record.get("gamesBack")),
                "current_projected_rank": coerce_int(team.get("currentProjectedRank")),
            }
        )
    return rows


def _side_points_by_period(side: Dict[str, Any]) -> Tuple[Optional[int], Optional[str]]:
    """Return (scoring_period, json blob) for one side of a matchup."""
    by_period = side.get("pointsByScoringPeriod")
    if not isinstance(by_period, dict) or not by_period:
        return None, None
    periods = [coerce_int(key) for key in by_period.keys()]
    periods = [period for period in periods if period is not None]
    scoring_period = min(periods) if periods else None
    return scoring_period, json.dumps(by_period)


def parse_schedule(payload: Any) -> List[Dict[str, Any]]:
    """Every matchup in the season, including byes and playoff rounds.

    A bye has no `away` side. Those rows are kept (the scoreboard shows them)
    but flagged, because counting one as a game would invent a phantom
    opponent in every strength-of-schedule calculation.
    """
    payload = _require_dict(payload, "schedule")
    schedule = payload.get("schedule")
    if not isinstance(schedule, list):
        raise EspnLeagueError("ESPN schedule payload had no schedule list")

    rows = []
    for game in schedule:
        if not isinstance(game, dict):
            continue
        espn_matchup_id = coerce_int(game.get("id"))
        home = game.get("home")
        if espn_matchup_id is None or not isinstance(home, dict):
            continue
        away = game.get("away") if isinstance(game.get("away"), dict) else None
        winner = (game.get("winner") or "UNDECIDED").upper()

        home_period, home_by_period = _side_points_by_period(home)
        away_period, away_by_period = (
            _side_points_by_period(away) if away else (None, None)
        )
        rows.append(
            {
                "espn_matchup_id": espn_matchup_id,
                "matchup_period": coerce_int(game.get("matchupPeriodId")),
                "scoring_period": home_period if home_period is not None else away_period,
                "playoff_tier": game.get("playoffTierType") or "NONE",
                "winner": winner,
                "home_team_id": coerce_int(home.get("teamId")),
                "home_points": coerce_float(home.get("totalPoints")),
                "home_points_by_period_json": home_by_period,
                "away_team_id": coerce_int(away.get("teamId")) if away else None,
                "away_points": coerce_float(away.get("totalPoints")) if away else None,
                "away_points_by_period_json": away_by_period,
                "is_bye": away is None,
                "is_complete": winner in ("HOME", "AWAY", "TIE"),
            }
        )
    return rows


def espn_player_key(player: Dict[str, Any], espn_player_id: Optional[int] = None) -> Tuple[Optional[str], Optional[str]]:
    """Return (espn_id, dst_team_abbrev) for crosswalking to ff_players.

    Skill players match on ff_players.espn_id. Team defenses have no ESPN
    player id in Sleeper's dump — Sleeper keys DEF rows by team abbreviation —
    so they resolve through proTeamId instead. Exactly one element is non-None
    for a well-formed entry.
    """
    if not isinstance(player, dict):
        return None, None
    position = ESPN_POSITION_IDS.get(coerce_int(player.get("defaultPositionId")))
    pro_team_id = coerce_int(player.get("proTeamId"))
    if position == "DEF":
        return None, ESPN_PRO_TEAM_ABBR.get(pro_team_id)
    player_id = coerce_int(player.get("id"))
    if player_id is None:
        player_id = espn_player_id
    return (str(player_id) if player_id is not None else None), None


def parse_roster_entries(payload: Any) -> List[Dict[str, Any]]:
    """Flatten every team's current roster into rows.

    Returns the raw ESPN shape plus the resolved position/slot/team labels;
    the collector layer is what maps these onto ff_players.
    """
    payload = _require_dict(payload, "league")
    teams = payload.get("teams")
    if not isinstance(teams, list):
        raise EspnLeagueError("ESPN league payload had no teams list")

    rows = []
    for team in teams:
        if not isinstance(team, dict):
            continue
        espn_team_id = coerce_int(team.get("id"))
        roster = team.get("roster")
        if espn_team_id is None or not isinstance(roster, dict):
            continue
        for entry in roster.get("entries") or []:
            if not isinstance(entry, dict):
                continue
            player = (entry.get("playerPoolEntry") or {}).get("player")
            if not isinstance(player, dict):
                continue
            espn_player_id = coerce_int(entry.get("playerId"))
            lineup_slot_id = coerce_int(entry.get("lineupSlotId"))
            pro_team_id = coerce_int(player.get("proTeamId"))
            espn_id, dst_team = espn_player_key(player, espn_player_id)
            rows.append(
                {
                    "espn_team_id": espn_team_id,
                    "espn_player_id": espn_player_id,
                    "espn_id": espn_id,
                    "dst_team": dst_team,
                    "player_name_raw": player.get("fullName"),
                    "lineup_slot_id": lineup_slot_id,
                    "lineup_slot": ESPN_LINEUP_SLOTS.get(lineup_slot_id),
                    "position": ESPN_POSITION_IDS.get(
                        coerce_int(player.get("defaultPositionId"))
                    ),
                    "pro_team_id": pro_team_id,
                    "pro_team": ESPN_PRO_TEAM_ABBR.get(pro_team_id),
                    "acquisition_type": entry.get("acquisitionType"),
                    "injury_status": entry.get("injuryStatus") or player.get("injuryStatus"),
                }
            )
    return rows


espn_league_client = EspnLeagueClient()
