"""Underdog client and parser for NFL regular-season player totals.

Underdog is the one season-long source here that is not an exchange. Instead
of a ladder of threshold contracts it posts a single *balanced* line per
player and category -- "Bucky Irving Season Rush Yards O/U 799.5" at
-112/-112 -- which is the market's median estimate stated directly. Nothing
has to be interpolated to use it, and it reaches the players the exchanges
skip: in August 2026 it quoted 27 passing-touchdown lines against Kalshi's
12, including Lamar Jackson, Jalen Hurts and Jayden Daniels, none of whom
Kalshi priced.

Three things about the feed need care:

* **It is every sport at once.** One 18MB document carries CFB, MLB, tennis
  and the rest, and 107 of the 425 season-long football lines in August 2026
  were college, not NFL. Players are filtered on ``sport_id`` before anything
  else, because "Season Rush Yards" reads identically for both.
* **Not every line is a market view.** Boosted and discounted lines exist to
  be attractive, not accurate, so only ``balanced`` lines with no boost and
  no discounted original are read.
* **Both sides carry vig.** Unlike an exchange, the two posted prices sum
  past 1, so they are de-vigged into one fair probability before the shared
  row builder turns them into complements.

The endpoint is public and keyless but undocumented, and its sibling at
PrizePicks already sits behind a bot check. Losing it should cost coverage
and nothing else, which is why the collector treats each provider's failure
as survivable.
"""
import os
from typing import Any, Dict, List, Optional, Tuple

from app.services.fantasy_common import coerce_float
from app.services.fantasy_season_props import (
    SeasonPropsError,
    american_to_probability,
    devig,
    ladder_rows,
    parse_timestamp,
    request_json,
)

BOOKMAKER = "Underdog"

# Underdog stat key -> the market key used by ff_season_prop_snapshots. Both
# spellings of each receiving/passing stat appear in the live feed, keyed by
# how the line was created, and they mean the same thing.
SEASON_STATS = {
    "season_pass_yards": "season_pass_yds",
    "season_passing_yards": "season_pass_yds",
    "season_pass_tds": "season_pass_tds",
    "season_passing_tds": "season_pass_tds",
    "season_rush_yards": "season_rush_yds",
    "season_rushing_yards": "season_rush_yds",
    "season_rush_tds": "season_rush_tds",
    "season_rushing_tds": "season_rush_tds",
    "season_rec_yards": "season_rec_yds",
    "season_receiving_yards": "season_rec_yds",
    "season_rec_tds": "season_rec_tds",
    "season_receiving_tds": "season_rec_tds",
}

SPORT = "NFL"


def _index(payload: Dict[str, Any], key: str) -> Dict[str, Dict[str, Any]]:
    rows = payload.get(key)
    if not isinstance(rows, list):
        return {}
    return {row["id"]: row for row in rows if isinstance(row, dict) and row.get("id")}


def _player_name(player: Dict[str, Any]) -> Optional[str]:
    name = " ".join(
        part for part in (player.get("first_name"), player.get("last_name")) if part
    ).strip()
    return name or None


def _fair_probability(options: Any) -> Optional[float]:
    """De-vigged P(higher) from the line's two posted prices.

    Both sides are required. A one-sided line is a line being taken down, and
    guessing the missing half is exactly the invented-midpoint problem the
    exchange parser exists to avoid.
    """
    if not isinstance(options, list):
        return None
    prices: Dict[str, float] = {}
    for option in options:
        if not isinstance(option, dict) or option.get("status") != "active":
            continue
        choice = option.get("choice")
        probability = american_to_probability(option.get("american_price"))
        if choice in ("higher", "lower") and probability is not None:
            prices[choice] = probability
    return devig(prices.get("higher"), prices.get("lower"))


def _is_plain_line(line: Dict[str, Any], over_under: Dict[str, Any]) -> bool:
    """True for an ordinary two-sided line, not a promotional one."""
    return (
        line.get("status") == "active"
        and line.get("line_type") == "balanced"
        and line.get("non_discounted_stat_value") is None
        and not over_under.get("boost")
    )


def parse_underdog_props(payload: Any) -> List[Dict[str, Any]]:
    """Flatten the Underdog lobby payload into Over/Under snapshot rows."""
    if not isinstance(payload, dict):
        raise SeasonPropsError("Underdog payload was not an object")

    appearances = _index(payload, "appearances")
    players = _index(payload, "players")
    lines = payload.get("over_under_lines")
    if not isinstance(lines, list):
        raise SeasonPropsError("Underdog payload carried no over/under lines")

    ladders: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    for line in lines:
        if not isinstance(line, dict):
            continue
        over_under = line.get("over_under")
        if not isinstance(over_under, dict) or not _is_plain_line(line, over_under):
            continue
        stat = over_under.get("appearance_stat")
        if not isinstance(stat, dict):
            continue
        market = SEASON_STATS.get(stat.get("stat"))
        if not market:
            continue

        appearance = appearances.get(stat.get("appearance_id"))
        player = players.get(appearance.get("player_id")) if appearance else None
        if not player or player.get("sport_id") != SPORT:
            continue
        name = _player_name(player)
        point = coerce_float(line.get("stat_value"))
        probability = _fair_probability(line.get("options"))
        if not name or point is None or probability is None:
            continue

        ladders.setdefault((player["id"], market), []).append({
            "point": point,
            "probability": probability,
            "name": name,
            "quoted_at": parse_timestamp(line.get("updated_at")),
        })
    return ladder_rows(ladders, BOOKMAKER)


class UnderdogClient:
    name = BOOKMAKER

    def __init__(self, base_url: Optional[str] = None, timeout: Optional[float] = None):
        self.base_url = (
            base_url
            or os.getenv("UNDERDOG_API_URL")
            or "https://api.underdogfantasy.com/beta/v6/over_under_lines"
        )
        self.timeout = timeout or float(os.getenv("UNDERDOG_TIMEOUT_SECONDS", "45"))

    @property
    def configured(self) -> bool:
        """Underdog's lobby feed is public, so there is nothing to configure."""
        return os.getenv("UNDERDOG_ENABLED", "true").strip().lower() not in ("0", "false", "no")

    def get_season_props(self) -> Dict[str, Any]:
        # One request returns every open line in every sport; the parser does
        # the narrowing. A longer default timeout than the other providers is
        # deliberate -- the document runs to tens of megabytes.
        payload = request_json(
            self.base_url, None, self.timeout, "the Underdog season props API"
        )
        if not isinstance(payload, dict):
            raise SeasonPropsError("Underdog returned an unexpected response")
        return payload

    def collect(self, season: int) -> List[Dict[str, Any]]:
        """Provider protocol: fetched and parsed rows, ready to store.

        The lobby only ever carries the season being played, so the
        argument is accepted and unused.
        """
        return parse_underdog_props(self.get_season_props())


underdog_props_client = UnderdogClient()
