"""Shared helpers and constants for the fantasy football app.

Kept dependency-free (stdlib only, like the rest of the backend) so the
collectors and read helpers can both import it without pulling in the HTTP
clients.
"""
import re
import unicodedata
from typing import Optional

# Fantasy-relevant positions. DST is stored as the Sleeper "DEF" position but
# surfaced as "DST" in the UI/rankings.
SKILL_POSITIONS = ("QB", "RB", "WR", "TE", "K", "DEF")
FLEX_POSITIONS = ("RB", "WR", "TE")
SCORING_FORMATS = ("ppr", "half", "std")

# Map a scoring key to the projection/stat column holding its points.
SCORING_POINTS_FIELD = {
    "ppr": "pts_ppr",
    "half": "pts_half_ppr",
    "std": "pts_std",
}

# Common name suffixes stripped during normalization so "Odell Beckham Jr."
# and "Odell Beckham" match across sources.
_NAME_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}
# Separators (hyphen/slash) become spaces so "Amon-Ra" -> "amon ra"; the
# remaining punctuation (dots) is dropped so "D.J." -> "dj".
_SEPARATORS = re.compile(r"[-/]+")
_NON_ALNUM = re.compile(r"[^a-z0-9 ]+")
_WHITESPACE = re.compile(r"\s+")


def normalize_name(name: Optional[str]) -> str:
    """Normalize a player name for cross-source matching.

    Lowercases, strips accents and punctuation, and drops generational
    suffixes. "D.J. Moore" -> "dj moore", "Amon-Ra St. Brown" ->
    "amon ra st brown". Empty/None -> "".
    """
    if not name:
        return ""
    # Strip accents (e.g. "Kañon" -> "Kanon").
    decomposed = unicodedata.normalize("NFKD", name)
    ascii_name = "".join(c for c in decomposed if not unicodedata.combining(c))
    lowered = ascii_name.lower()
    # Hyphens/slashes -> spaces (word separators), then drop the rest of the
    # punctuation without inserting a space so "d.j." collapses to "dj".
    spaced = _SEPARATORS.sub(" ", lowered)
    cleaned = _NON_ALNUM.sub("", spaced)
    tokens = [t for t in _WHITESPACE.split(cleaned) if t and t not in _NAME_SUFFIXES]
    return " ".join(tokens)


def normalize_position(position: Optional[str]) -> Optional[str]:
    """Map raw source positions onto the set we rank/display."""
    if not position:
        return None
    pos = position.strip().upper()
    if pos in ("DST", "D/ST", "DEFENSE"):
        return "DEF"
    return pos


def display_position(position: Optional[str]) -> Optional[str]:
    """Inverse of the DEF/DST mapping for user-facing output."""
    if position == "DEF":
        return "DST"
    return position


def normalize_scoring(scoring: Optional[str]) -> str:
    """Coerce a scoring query value to one of SCORING_FORMATS (default ppr)."""
    if not scoring:
        return "ppr"
    value = scoring.strip().lower()
    if value in ("half", "half_ppr", "half-ppr"):
        return "half"
    if value in ("std", "standard", "non_ppr", "nonppr"):
        return "std"
    if value == "ppr":
        return "ppr"
    return "ppr"


# Full team name -> abbreviation. The Odds API returns full names
# ("Buffalo Bills"); ff_players / ff_games use Sleeper/nflverse abbreviations.
NFL_TEAM_ABBR = {
    "arizona cardinals": "ARI",
    "atlanta falcons": "ATL",
    "baltimore ravens": "BAL",
    "buffalo bills": "BUF",
    "carolina panthers": "CAR",
    "chicago bears": "CHI",
    "cincinnati bengals": "CIN",
    "cleveland browns": "CLE",
    "dallas cowboys": "DAL",
    "denver broncos": "DEN",
    "detroit lions": "DET",
    "green bay packers": "GB",
    "houston texans": "HOU",
    "indianapolis colts": "IND",
    "jacksonville jaguars": "JAX",
    "kansas city chiefs": "KC",
    "las vegas raiders": "LV",
    "los angeles chargers": "LAC",
    "los angeles rams": "LAR",
    "miami dolphins": "MIA",
    "minnesota vikings": "MIN",
    "new england patriots": "NE",
    "new orleans saints": "NO",
    "new york giants": "NYG",
    "new york jets": "NYJ",
    "philadelphia eagles": "PHI",
    "pittsburgh steelers": "PIT",
    "san francisco 49ers": "SF",
    "seattle seahawks": "SEA",
    "tampa bay buccaneers": "TB",
    "tennessee titans": "TEN",
    "washington commanders": "WAS",
}


def team_abbr(full_name: Optional[str]) -> Optional[str]:
    """Map a full team name to its abbreviation; pass through unknown values."""
    if not full_name:
        return None
    return NFL_TEAM_ABBR.get(full_name.strip().lower(), full_name)


def coerce_int(value) -> Optional[int]:
    try:
        if value is None or value == "":
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def coerce_float(value) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None
