"""Read queries for the fantasy dashboard/API.

These are plain synchronous SQLAlchemy reads over the collected data — the
same in demo and authenticated modes. "Latest" for a snapshot table resolves
through the newest successful FantasyCollectionRun (see fantasy_collector).
"""
import json
from datetime import timedelta
from statistics import median
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import and_, case, func, null, or_
from sqlalchemy.orm import Session

from app.database import (
    FantasyCollectionRun,
    FantasyFutureSnapshot,
    FantasyGame,
    FantasyOddsSnapshot,
    FantasyPlayer,
    FantasyPlayerStat,
    FantasyProjection,
    FantasyPropSnapshot,
    FantasyRanking,
    FantasySeasonPropSnapshot,
    FantasyTrendingSnapshot,
    iso_utc,
)
from app.services.fantasy_collector import (
    SEASON_LONG_WEEK,
    current_season_week,
    is_in_season,
    latest_successful_run,
)
from app.services.fantasy_season_props import probability_to_american
from app.services.fantasy_common import (
    FLEX_POSITIONS,
    SCORING_POINTS_FIELD,
    coerce_float,
    display_position,
    normalize_position,
    normalize_scoring,
)

# Virtual projection source that blends every collected provider for a
# week (see _consensus_projection_map). Real providers are ranked directly.
CONSENSUS_SOURCE = "consensus"
PROVIDER_SOURCES = ("sleeper", "fantasypros", "espn")

# Jobs surfaced in the /state freshness panel.
TRACKED_JOBS = (
    "state",
    "players",
    "schedule",
    "weekly_stats",
    "projections",
    "rankings",
    "trending",
    "odds_lines",
    "odds_props",
    "odds_futures",
    "season_props",
)

SEASON_PROP_MARKETS = (
    ("season_pass_yds", "Passing yards"),
    ("season_rush_yds", "Rushing yards"),
    ("season_rec_yds", "Receiving yards"),
    ("season_pass_tds", "Passing touchdowns"),
    ("season_rush_tds", "Rushing touchdowns"),
    ("season_rec_tds", "Receiving touchdowns"),
)

# Conventional standard-scoring weights for the market stats we collect.
# Receptions, interceptions, two-point conversions and fumbles are not quoted
# by this feed, so the resulting total is intentionally narrower than a full
# season projection.
SEASON_FANTASY_WEIGHTS = {
    "season_pass_yds": 1 / 25,
    "season_pass_tds": 4,
    "season_rush_yds": 1 / 10,
    "season_rush_tds": 6,
    "season_rec_yds": 1 / 10,
    "season_rec_tds": 6,
}
SEASON_YARD_MARKETS = frozenset({
    "season_pass_yds", "season_rush_yds", "season_rec_yds",
})
SEASON_TD_MARKETS = frozenset({
    "season_pass_tds", "season_rush_tds", "season_rec_tds",
})
SEASON_FANTASY_MARKET_PAIRS = {
    "passing": ("season_pass_yds", "season_pass_tds"),
    "rushing": ("season_rush_yds", "season_rush_tds"),
    "receiving": ("season_rec_yds", "season_rec_tds"),
}
SEASON_FANTASY_PRIMARY_PAIR = {
    "QB": "passing",
    "RB": "rushing",
    "WR": "receiving",
    "TE": "receiving",
}
# Categories a position is expected to score in, so a total built without one
# can say so. Deliberately asymmetric, because a false caveat costs as much as
# a missing one: a quarterback's rushing and a running back's receiving are
# routinely tens of points, while receivers and tight ends almost never rush,
# and flagging their absent rushing market would put a warning on nearly every
# WR/TE row to no purpose.
SEASON_FANTASY_EXPECTED_PAIRS = {
    "QB": ("passing", "rushing"),
    "RB": ("rushing", "receiving"),
    "WR": ("receiving",),
    "TE": ("receiving",),
}


def _player_index(db: Session, player_ids: Optional[List[str]] = None) -> Dict[str, FantasyPlayer]:
    query = db.query(FantasyPlayer)
    if player_ids is not None:
        if not player_ids:
            return {}
        query = query.filter(FantasyPlayer.player_id.in_(player_ids))
    return {p.player_id: p for p in query.all()}


def _player_public(player: Optional[FantasyPlayer]) -> Dict[str, Any]:
    if player is None:
        return {"player_id": None, "name": None, "team": None, "position": None}
    return {
        "player_id": player.player_id,
        "name": player.full_name,
        "team": player.team,
        "position": display_position(player.position),
        "injury_status": player.injury_status,
    }


def _resolve_projection_run(
    db: Session, season: Optional[int], week: Optional[int], requested_source: Optional[str]
):
    """Latest projections run to serve for a (season, week[, source]).

    A named source resolves to that provider only. Sourceless requests use
    Sleeper as the stable default (never whichever provider happened to be
    collected most recently), then any provider as a last resort.
    """
    if requested_source is not None:
        return latest_successful_run(db, "projections", season, week, source=requested_source)
    return (
        latest_successful_run(db, "projections", season, week, source="sleeper")
        or latest_successful_run(db, "projections", season, week)
    )


def _avg(values: List[float]) -> Optional[float]:
    values = [v for v in values if v is not None]
    return round(sum(values) / len(values), 2) if values else None


def _provider_runs(db: Session, season: Optional[int], week: Optional[int]) -> Dict[str, Any]:
    """Latest successful projections run per real provider for the week."""
    runs = {}
    for source in PROVIDER_SOURCES:
        run = latest_successful_run(db, "projections", season, week, source=source)
        if run is not None:
            runs[source] = run
    return runs


def _consensus_projection_map(db: Session, season: Optional[int], week: Optional[int]):
    """player_id -> blended points across providers, plus the freshest as_of.

    Averages each scoring field over the providers that projected the player;
    a player is included as long as at least one provider covers them. Returns
    ({}, None) when fewer than two providers are available (no blend to make).
    """
    runs = _provider_runs(db, season, week)
    if len(runs) < 2:
        return {}, None
    run_source = {run.id: source for source, run in runs.items()}
    acc: Dict[str, Dict[str, Any]] = {}
    rows = (
        db.query(FantasyProjection)
        .filter(FantasyProjection.run_id.in_(list(run_source.keys())))
        .all()
    )
    for row in rows:
        entry = acc.setdefault(
            row.player_id,
            {"pts_ppr": [], "pts_half_ppr": [], "pts_std": [], "providers": set()},
        )
        entry["providers"].add(run_source[row.run_id])
        for field in ("pts_ppr", "pts_half_ppr", "pts_std"):
            value = getattr(row, field)
            if value is not None:
                entry[field].append(value)
    result = {
        player_id: {
            "pts_ppr": _avg(entry["pts_ppr"]),
            "pts_half_ppr": _avg(entry["pts_half_ppr"]),
            "pts_std": _avg(entry["pts_std"]),
            "providers": sorted(entry["providers"]),
        }
        for player_id, entry in acc.items()
    }
    as_of = max(
        (run.finished_at for run in runs.values() if run.finished_at), default=None
    )
    return result, as_of


def _keep_position(player: Optional[FantasyPlayer], raw_position: str, query_position: Optional[str]) -> bool:
    """Position filter shared by the provider and consensus projection paths."""
    if raw_position == "FLEX":
        return player is not None and player.position in FLEX_POSITIONS
    if query_position and raw_position not in ("ALL", "FLEX"):
        return player is not None and player.position == query_position
    return True


def _week_matchups(db: Session, season: Optional[int], week: Optional[int]) -> Dict[str, Dict[str, Any]]:
    """team abbr -> {opponent, home} for a week. Teams absent are on bye.

    Empty for season-long (week 0) or when no schedule is loaded, so callers
    can tell "on bye" (schedule present, team missing) from "unknown".
    """
    if not season or not week or week == SEASON_LONG_WEEK:
        return {}
    games = (
        db.query(FantasyGame)
        .filter(FantasyGame.season == season, FantasyGame.week == week)
        .all()
    )
    matchups: Dict[str, Dict[str, Any]] = {}
    for game in games:
        if game.home_team and game.away_team:
            matchups[game.home_team] = {"opponent": game.away_team, "home": True}
            matchups[game.away_team] = {"opponent": game.home_team, "home": False}
    return matchups


def _attach_matchup(entry: Dict[str, Any], matchups: Dict[str, Dict[str, Any]]) -> None:
    """Add opponent/home/bye to a player entry from a week's matchup map."""
    if not matchups:
        return
    team = entry.get("team")
    matchup = matchups.get(team) if team else None
    if matchup is not None:
        entry["opponent"] = matchup["opponent"]
        entry["home"] = matchup["home"]
        entry["bye"] = False
    else:
        entry["opponent"] = None
        entry["home"] = None
        entry["bye"] = team is not None


def default_context(db: Session) -> Dict[str, Any]:
    """Resolve the season/week to show by default.

    In-season, prefers the current NFL week when it already has a rankings
    snapshot. In the offseason, prefers season-long rankings for the upcoming
    season (stored as week SEASON_LONG_WEEK). Either way, falls back to the
    most recent snapshot of any kind (e.g. the prior season's final week).
    """
    ctx = current_season_week(db)
    season, week, season_type = ctx["season"], ctx["week"], ctx["season_type"]

    if is_in_season(season_type):
        if season and week and latest_successful_run(db, "rankings", season, week):
            return {"season": season, "week": week, "season_type": season_type, "is_fallback": False}
    elif season and latest_successful_run(db, "rankings", season, SEASON_LONG_WEEK):
        # Offseason: Sleeper's state season is the upcoming season, so this is
        # the season-long view for it — the intended default, not a fallback.
        return {"season": season, "week": SEASON_LONG_WEEK, "season_type": season_type, "is_fallback": False}

    newest = latest_successful_run(db, "rankings")
    if newest is not None:
        is_fallback = not (newest.season == season and newest.week == week)
        return {
            "season": newest.season,
            "week": newest.week,
            "season_type": season_type,
            "is_fallback": is_fallback,
        }
    return {"season": season, "week": week, "season_type": season_type, "is_fallback": False}


def get_state(db: Session) -> Dict[str, Any]:
    ctx = current_season_week(db)
    default = default_context(db)
    jobs = []
    for job in TRACKED_JOBS:
        run = latest_successful_run(db, job)
        jobs.append(
            {
                "job": job,
                "last_success": iso_utc(run.finished_at) if run else None,
                "rows_written": run.rows_written if run else None,
            }
        )
    return {
        "season": ctx["season"],
        "week": ctx["week"],
        "season_type": ctx["season_type"],
        "in_season": (ctx["season_type"] or "").lower() in ("regular", "post"),
        "default_season": default["season"],
        "default_week": default["week"],
        "is_fallback": default["is_fallback"],
        "jobs": jobs,
    }


def get_rankings(
    db: Session,
    season: Optional[int] = None,
    week: Optional[int] = None,
    position: str = "ALL",
    scoring: str = "ppr",
    source: Optional[str] = None,
    limit: int = 100,
) -> Dict[str, Any]:
    if season is None or week is None:
        default = default_context(db)
        season = season if season is not None else default["season"]
        week = week if week is not None else default["week"]

    result = _build_rankings(db, season, week, position, scoring, source, limit)

    # Week-over-week movement: rank the prior week the same way and diff. A
    # smaller rank number is better, so prev_rank - rank > 0 is an upward move.
    # Skipped for season-long (week 0), where there is no "prior week".
    if week and week != SEASON_LONG_WEEK:
        previous = _build_rankings(db, season, week - 1, position, scoring, source, limit=400)
        prev_rank = {
            row["player_id"]: row["rank"]
            for row in previous["rankings"]
            if row.get("player_id") is not None
        }
        for row in result["rankings"]:
            row["prev_rank"] = prev_rank.get(row.get("player_id"))

    matchups = _week_matchups(db, season, week)
    for row in result["rankings"]:
        _attach_matchup(row, matchups)
    return result


def _build_rankings(
    db: Session,
    season: Optional[int],
    week: Optional[int],
    position: str,
    scoring: str,
    source: Optional[str],
    limit: int,
) -> Dict[str, Any]:
    scoring = normalize_scoring(scoring)
    position = (position or "ALL").upper()
    query_position = "DEF" if position in ("DST", "DEF") else position

    # A selected projection provider (or the consensus blend) is ranked
    # directly from projections. The legacy no-source path continues to serve
    # the materialized derived rankings table for existing API consumers.
    if source:
        projection_data = get_projections(
            db,
            season=season,
            week=week,
            position=position,
            scoring=scoring,
            source=source,
            limit=limit,
        )
        rankings = []
        for rank, projection in enumerate(projection_data["projections"], start=1):
            entry = dict(projection)
            entry.update({"rank": rank, "tier": None})
            rankings.append(entry)
        return {
            "season": season,
            "week": week,
            "position": position,
            "scoring": scoring,
            "source": projection_data.get("source") or source,
            "as_of": projection_data.get("as_of"),
            "rankings": rankings,
        }

    run = latest_successful_run(db, "rankings", season, week)
    if run is None:
        return {"season": season, "week": week, "position": position, "scoring": scoring, "rankings": []}

    rows = (
        db.query(FantasyRanking)
        .filter(
            FantasyRanking.run_id == run.id,
            FantasyRanking.scoring == scoring,
            FantasyRanking.position == query_position,
        )
        .order_by(FantasyRanking.rank.asc())
        .limit(limit)
        .all()
    )
    players = _player_index(db, [r.player_id for r in rows])
    rankings = []
    for r in rows:
        entry = _player_public(players.get(r.player_id))
        entry.update({"rank": r.rank, "tier": r.tier, "projected_points": r.ecr})
        rankings.append(entry)

    return {
        "season": season,
        "week": week,
        "position": position,
        "scoring": scoring,
        "source": run.source,
        "as_of": iso_utc(run.finished_at),
        "rankings": rankings,
    }


# ff_player_stats keeps actual points under its own column names;
# SCORING_POINTS_FIELD names the projection columns, which are different.
STAT_POINTS_FIELD = {
    "ppr": "fantasy_points_ppr",
    "half": "fantasy_points_half",
    "std": "fantasy_points_std",
}

# The results board grades the positions the site ranks. nflverse publishes
# stat lines for punters and returners too, and they belong to nobody's board.
RESULT_POSITIONS = ("QB", "RB", "WR", "TE")


def latest_played_week(db: Session, season: Optional[int]) -> Optional[int]:
    """Newest week of a season with any recorded stat line."""
    if not season:
        return None
    return (
        db.query(func.max(FantasyPlayerStat.week))
        .filter(FantasyPlayerStat.season == season)
        .scalar()
    )


def get_week_results(
    db: Session,
    season: Optional[int] = None,
    week: Optional[int] = None,
    scoring: str = "ppr",
    limit: int = 200,
) -> Dict[str, Any]:
    """What a played week actually produced, against what was projected.

    The comparison is against the number that was on screen — the derived
    rankings run for that week — not a projection rebuilt today from data the
    week has since produced. Grading a forecast against a hindsight forecast
    says nothing.

    Rows are ordered by what the player actually scored, so the board answers
    "who won the week" first and "who was supposed to" second. A player with
    no projection still ranks: he scored the points either way, and a missing
    forecast is its own kind of miss.
    """
    scoring = normalize_scoring(scoring)
    if season is None:
        season = default_context(db)["season"]
    if week is None:
        week = latest_played_week(db, season)
    empty = {
        "season": season,
        "week": week,
        "scoring": scoring,
        "as_of": None,
        "entries": [],
        "played": 0,
        "projected": 0,
        "mean_absolute_error": None,
    }
    if not season or not week:
        return empty

    points_column = getattr(FantasyPlayerStat, STAT_POINTS_FIELD[scoring])
    stats = (
        db.query(FantasyPlayerStat)
        .filter(
            FantasyPlayerStat.season == season,
            FantasyPlayerStat.week == week,
            points_column.isnot(None),
        )
        .order_by(points_column.desc())
        .all()
    )
    if not stats:
        return empty

    players = _player_index(db, [stat.player_id for stat in stats])
    matchups = _week_matchups(db, season, week)

    # The projection the week board showed, from the same derived rankings run
    # /rankings serves. The overall ("ALL") list covers every ranked player, so
    # one query answers for all four positions.
    projected: Dict[str, Optional[float]] = {}
    projected_rank: Dict[str, int] = {}
    ranking_run = latest_successful_run(db, "rankings", season, week)
    if ranking_run is not None:
        for row in (
            db.query(FantasyRanking)
            .filter(
                FantasyRanking.run_id == ranking_run.id,
                FantasyRanking.scoring == scoring,
                FantasyRanking.position == "ALL",
            )
            .all()
        ):
            projected[row.player_id] = row.ecr
            projected_rank[row.player_id] = row.rank

    entries: List[Dict[str, Any]] = []
    errors: List[float] = []
    for stat in stats:
        player = players.get(stat.player_id)
        if player is None or display_position(player.position) not in RESULT_POSITIONS:
            continue
        actual = coerce_float(getattr(stat, STAT_POINTS_FIELD[scoring]))
        if actual is None:
            continue
        projection = projected.get(stat.player_id)
        delta = round(actual - projection, 1) if projection is not None else None
        if delta is not None:
            errors.append(abs(delta))
        entry = _player_public(player)
        entry.update(
            {
                "actual_points": round(actual, 1),
                "projected_points": round(projection, 1) if projection is not None else None,
                "projection_delta": delta,
                "projected_rank": projected_rank.get(stat.player_id),
            }
        )
        _attach_matchup(entry, matchups)
        # Who he actually played, which beats the schedule map on a week the
        # schedule has since been rewritten (flex scheduling, a moved game).
        if stat.opponent:
            entry["opponent"] = stat.opponent
        entries.append(entry)

    ranked = entries[:limit]
    for rank, entry in enumerate(ranked, start=1):
        entry["rank"] = rank

    as_of = max(
        (stat.updated_at for stat in stats if stat.updated_at), default=None
    )
    return {
        "season": season,
        "week": week,
        "scoring": scoring,
        "as_of": iso_utc(as_of),
        "entries": ranked,
        # Counted over the whole week, not the page of it being returned: the
        # average miss describes the board, not the top 200 rows of it.
        "played": len(entries),
        "projected": len(errors),
        "mean_absolute_error": round(sum(errors) / len(errors), 1) if errors else None,
    }


def get_projections(
    db: Session,
    season: Optional[int] = None,
    week: Optional[int] = None,
    position: Optional[str] = None,
    scoring: str = "ppr",
    source: Optional[str] = None,
    limit: int = 200,
) -> Dict[str, Any]:
    if season is None or week is None:
        default = default_context(db)
        season = season if season is not None else default["season"]
        week = week if week is not None else default["week"]

    scoring = normalize_scoring(scoring)
    points_field = SCORING_POINTS_FIELD[scoring]

    requested_source = (source or "").strip().lower() or None
    raw_position = (position or "").upper()
    query_position = normalize_position(position) if position else None

    if requested_source == CONSENSUS_SOURCE:
        return _consensus_projections(
            db, season, week, scoring, points_field, raw_position, query_position, limit
        )

    run = _resolve_projection_run(db, season, week, requested_source)
    if run is None:
        return {
            "season": season,
            "week": week,
            "scoring": scoring,
            "source": requested_source,
            "projections": [],
        }

    rows = db.query(FantasyProjection).filter(FantasyProjection.run_id == run.id).all()
    players = _player_index(db, [r.player_id for r in rows])

    projections = []
    for r in rows:
        player = players.get(r.player_id)
        if not _keep_position(player, raw_position, query_position):
            continue
        points = getattr(r, points_field)
        if points is None:
            continue
        entry = _player_public(player)
        entry["projected_points"] = points
        projections.append(entry)

    projections.sort(key=lambda e: e["projected_points"], reverse=True)
    return {
        "season": season,
        "week": week,
        "scoring": scoring,
        "source": run.source,
        "as_of": iso_utc(run.finished_at),
        "projections": projections[:limit],
    }


def _consensus_projections(
    db: Session,
    season: Optional[int],
    week: Optional[int],
    scoring: str,
    points_field: str,
    raw_position: str,
    query_position: Optional[str],
    limit: int,
) -> Dict[str, Any]:
    """Projections blended across every provider collected for the week."""
    cmap, as_of = _consensus_projection_map(db, season, week)
    players = _player_index(db, list(cmap.keys()))
    projections = []
    for player_id, values in cmap.items():
        player = players.get(player_id)
        if not _keep_position(player, raw_position, query_position):
            continue
        points = values[points_field]
        if points is None:
            continue
        entry = _player_public(player)
        entry["projected_points"] = points
        entry["providers"] = values["providers"]
        projections.append(entry)

    projections.sort(key=lambda e: e["projected_points"], reverse=True)
    return {
        "season": season,
        "week": week,
        "scoring": scoring,
        "source": CONSENSUS_SOURCE,
        "as_of": iso_utc(as_of),
        "projections": projections[:limit],
    }


def get_projection_sources(
    db: Session,
    season: Optional[int] = None,
    week: Optional[int] = None,
) -> Dict[str, Any]:
    if season is None or week is None:
        default = default_context(db)
        season = season if season is not None else default["season"]
        week = week if week is not None else default["week"]

    runs = (
        db.query(FantasyCollectionRun)
        .filter(
            FantasyCollectionRun.job == "projections",
            FantasyCollectionRun.status == "success",
            FantasyCollectionRun.season == season,
            FantasyCollectionRun.week == week,
        )
        .order_by(FantasyCollectionRun.id.desc())
        .all()
    )
    provider_meta = {
        "sleeper": {"label": "Sleeper", "url": "https://sleeper.com/"},
        "fantasypros": {"label": "FantasyPros", "url": "https://www.fantasypros.com/"},
        "espn": {"label": "ESPN", "url": "https://www.espn.com/fantasy/football/"},
    }
    sources = []
    seen = set()
    for run in runs:
        if not run.source or run.source in seen:
            continue
        seen.add(run.source)
        meta = provider_meta.get(run.source, {"label": run.source.title(), "url": None})
        sources.append(
            {
                "id": run.source,
                "label": meta["label"],
                "url": meta["url"],
                "as_of": iso_utc(run.finished_at),
            }
        )
    sources.sort(key=lambda item: (item["id"] != "sleeper", item["label"]))

    # A consensus blend is offered whenever two or more providers are present.
    if len(seen) >= 2:
        latest_provider = max(
            (item["as_of"] for item in sources if item["as_of"]), default=None
        )
        sources.insert(
            1 if sources and sources[0]["id"] == "sleeper" else 0,
            {
                "id": CONSENSUS_SOURCE,
                "label": "Consensus",
                "url": None,
                "as_of": latest_provider,
                "blended": sorted(seen),
            },
        )
    return {"season": season, "week": week, "sources": sources}


def search_players(db: Session, query: str, limit: int = 10) -> List[Dict[str, Any]]:
    """Name search ranked by fantasy relevance, not by the alphabet.

    The catalog is Sleeper's whole dump — several thousand players, most of
    them long retired — so a substring match ordered by name answers the
    wrong question: "Allen" returned five first-name Allens before Josh
    Allen, and the UI only asks for eight. Two signals fix it:

    1. Whether the term starts a word in the name. This is deliberately not
       graded any finer than that: ranking "starts the whole name" above
       "starts a later word" sounds right and is wrong, because it puts
       every first-name Allen above Josh Allen. It exists only to stop a
       buried match — "Hill" inside "Phillips" — from competing at all.
    2. Season-long projected points. Status and team are not usable here —
       retired players are still carried as "Active", and a genuine free
       agent has no team — but a projection is exactly the statement "this
       player matters", and its size ranks the namesakes. Season-long and
       not the current week's on purpose: "which Hill do you mean" is a
       season-scale question, and a weekly run nulls out anyone who is out,
       which dropped Tyreek Hill below every Hilliard in the catalog.
    """
    term = (query or "").strip().lower()
    if len(term) < 2:
        return []
    # LIKE wildcards in the user's own term would otherwise match everything.
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

    name = FantasyPlayer.search_name
    starts_a_word = or_(
        name.like(f"{escaped}%", escape="\\"),
        name.like(f"% {escaped}%", escape="\\"),
    )
    match_rank = case((starts_a_word, 0), else_=1)

    ctx = default_context(db)
    run = (
        _resolve_projection_run(db, ctx["season"], SEASON_LONG_WEEK, None)
        or _resolve_projection_run(db, ctx["season"], ctx["week"], None)
    )
    points = FantasyProjection.pts_ppr if run is not None else null()

    rows = (
        db.query(FantasyPlayer)
        .outerjoin(
            FantasyProjection,
            and_(
                FantasyProjection.player_id == FantasyPlayer.player_id,
                FantasyProjection.run_id == (run.id if run is not None else None),
            ),
        )
        .filter(name.like(f"%{escaped}%", escape="\\"))
        # `IS NULL` sorts False before True on both SQLite and Postgres, which
        # is how unprojected players land last without a NULLS LAST clause.
        .order_by(match_rank.asc(), points.is_(None).asc(), points.desc(), FantasyPlayer.full_name.asc())
        .limit(limit)
        .all()
    )
    return [_player_public(p) for p in rows]


def get_player_detail(
    db: Session, player_id: str, source: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    player = db.get(FantasyPlayer, player_id)
    if player is None:
        return None

    detail = _player_public(player)
    detail.update({"age": player.age, "years_exp": player.years_exp, "status": player.status})

    ctx = default_context(db)
    season, week = ctx["season"], ctx["week"]
    requested_source = (source or "").strip().lower() or None

    # Current projection for the default week. Consensus blends providers;
    # a named/absent source resolves through the same rules as the board.
    # history_source is the concrete provider used for the movement/accuracy
    # series (consensus has no single snapshot stream, so it uses Sleeper).
    history_source: Optional[str] = None
    if requested_source == CONSENSUS_SOURCE:
        cmap, as_of = _consensus_projection_map(db, season, week)
        values = cmap.get(player_id)
        if values is not None:
            detail["projection"] = {
                "season": season,
                "week": week,
                "source": CONSENSUS_SOURCE,
                "pts_ppr": values["pts_ppr"],
                "pts_half_ppr": values["pts_half_ppr"],
                "pts_std": values["pts_std"],
                "providers": values["providers"],
                "as_of": iso_utc(as_of),
            }
        history_source = "sleeper"
    else:
        proj_run = _resolve_projection_run(db, season, week, requested_source)
        if proj_run is not None:
            history_source = proj_run.source
            proj = (
                db.query(FantasyProjection)
                .filter(
                    FantasyProjection.run_id == proj_run.id,
                    FantasyProjection.player_id == player_id,
                )
                .first()
            )
            if proj is not None:
                detail["projection"] = {
                    "season": season,
                    "week": week,
                    "source": proj.source or proj_run.source,
                    "pts_ppr": proj.pts_ppr,
                    "pts_half_ppr": proj.pts_half_ppr,
                    "pts_std": proj.pts_std,
                    "as_of": iso_utc(proj.fetched_at),
                }

    # This week's opponent (or bye) from the schedule.
    matchups = _week_matchups(db, season, week)
    if matchups:
        _attach_matchup(detail, matchups)

    # Intra/inter-week projection movement: every snapshot this season.
    history_query = db.query(FantasyProjection).filter(
        FantasyProjection.player_id == player_id,
        FantasyProjection.season == season,
    )
    if history_source:
        history_query = history_query.filter(FantasyProjection.source == history_source)
    history = (
        history_query
        .order_by(FantasyProjection.fetched_at.asc())
        .all()
    )
    detail["projection_history"] = [
        {
            "week": h.week,
            "pts_ppr": h.pts_ppr,
            "fetched_at": iso_utc(h.fetched_at),
        }
        for h in history
    ]

    # Last 5 actual game lines.
    recent = (
        db.query(FantasyPlayerStat)
        .filter(FantasyPlayerStat.player_id == player_id)
        .order_by(FantasyPlayerStat.season.desc(), FantasyPlayerStat.week.desc())
        .limit(5)
        .all()
    )
    detail["recent_games"] = [
        {
            "season": s.season,
            "week": s.week,
            "opponent": s.opponent,
            "fantasy_points_ppr": s.fantasy_points_ppr,
            "stats": json.loads(s.stats_json) if s.stats_json else {},
        }
        for s in recent
    ]

    detail["projection_vs_actual"] = _projection_vs_actual(db, player_id, season, history_source)
    detail["props"] = _player_props(db, player_id)
    return detail


def _projection_vs_actual(
    db: Session, player_id: str, season: Optional[int], history_source: Optional[str]
) -> List[Dict[str, Any]]:
    """Per-week projected (latest snapshot) vs actual PPR points for a season.

    Only real weekly rows are paired (the season-long week 0 snapshot has no
    single-week actual to compare against). Weeks are returned in order, each
    with whichever of projected/actual is available.
    """
    proj_query = db.query(FantasyProjection).filter(
        FantasyProjection.player_id == player_id,
        FantasyProjection.season == season,
        FantasyProjection.week != SEASON_LONG_WEEK,
    )
    if history_source:
        proj_query = proj_query.filter(FantasyProjection.source == history_source)
    projected_by_week: Dict[int, Any] = {}
    latest_at: Dict[int, Any] = {}
    for row in proj_query.all():
        if row.pts_ppr is None:
            continue
        seen = latest_at.get(row.week)
        if seen is None or (row.fetched_at and row.fetched_at >= seen):
            projected_by_week[row.week] = row.pts_ppr
            latest_at[row.week] = row.fetched_at

    actual_by_week = {
        s.week: s.fantasy_points_ppr
        for s in db.query(FantasyPlayerStat).filter(
            FantasyPlayerStat.player_id == player_id,
            FantasyPlayerStat.season == season,
        )
        if s.week is not None
    }
    weeks = sorted(set(projected_by_week) | set(actual_by_week))
    return [
        {"week": week, "projected": projected_by_week.get(week), "actual": actual_by_week.get(week)}
        for week in weeks
    ]


def compare_players(
    db: Session,
    player_ids: List[str],
    source: Optional[str] = None,
    scoring: str = "ppr",
) -> Dict[str, Any]:
    """Side-by-side projection + recent-form comparison for 2-4 players."""
    scoring = normalize_scoring(scoring)
    ctx = default_context(db)
    season, week = ctx["season"], ctx["week"]
    ids = [str(pid) for pid in (player_ids or [])][:4]

    projection_data = get_projections(
        db, season=season, week=week, position="ALL", scoring=scoring, source=source, limit=400
    )
    points_by_player = {
        entry["player_id"]: entry["projected_points"]
        for entry in projection_data["projections"]
    }
    matchups = _week_matchups(db, season, week)
    season_market = get_season_fantasy_point_leaders(
        db, season=season, scoring=scoring, limit=10000
    )
    market_by_player = {
        entry["player"]["player_id"]: entry
        for entry in season_market.get("leaders", [])
    }

    players = []
    for pid in ids:
        player = db.get(FantasyPlayer, pid)
        if player is None:
            continue
        entry = _player_public(player)
        entry["projected_points"] = points_by_player.get(pid)
        recent = (
            db.query(FantasyPlayerStat)
            .filter(FantasyPlayerStat.player_id == pid)
            .order_by(FantasyPlayerStat.season.desc(), FantasyPlayerStat.week.desc())
            .limit(5)
            .all()
        )
        entry["recent_ppr"] = [
            {"week": s.week, "opponent": s.opponent, "fantasy_points_ppr": s.fantasy_points_ppr}
            for s in recent
        ]
        market = market_by_player.get(pid)
        entry["market"] = (
            {
                "total": market["fantasy_points"],
                "projection": market["projected_points"],
                "edge": market["projection_delta"],
                "yard_points": market["yard_points"],
                "touchdown_points": market["touchdown_points"],
                "reception_points": market["reception_points"],
                "quoted_categories": sorted(market.get("implied", {})),
                # Carried so the drawer can qualify its edge the same way the
                # board does; the same number deserves the same caveat.
                "partial_pairs": market["partial_pairs"],
                "missing_pairs": market["missing_pairs"],
                "edge_is_qualified": market["edge_is_qualified"],
            }
            if market is not None
            else {
                "total": None,
                "projection": None,
                "edge": None,
                "yard_points": None,
                "touchdown_points": None,
                "reception_points": None,
                "quoted_categories": [],
                "partial_pairs": [],
                "missing_pairs": [],
                "edge_is_qualified": False,
            }
        )
        _attach_matchup(entry, matchups)
        players.append(entry)

    return {
        "season": season,
        "week": week,
        "scoring": scoring,
        "source": projection_data.get("source") or source,
        "as_of": projection_data.get("as_of"),
        "players": players,
    }


def get_trending(db: Session, kind: str = "add", limit: int = 10) -> List[Dict[str, Any]]:
    kind = "drop" if kind == "drop" else "add"
    run = latest_successful_run(db, "trending")
    if run is None:
        return []
    rows = (
        db.query(FantasyTrendingSnapshot)
        .filter(
            FantasyTrendingSnapshot.run_id == run.id,
            FantasyTrendingSnapshot.kind == kind,
        )
        .order_by(FantasyTrendingSnapshot.count.desc())
        .limit(limit)
        .all()
    )
    players = _player_index(db, [r.player_id for r in rows])
    result = []
    for r in rows:
        entry = _player_public(players.get(r.player_id))
        entry["count"] = r.count
        result.append(entry)
    return result


# ── betting: lines, props, futures ──────────────────────────────────────

# Yardage/receptions props are read off the Over side; anytime TD off Yes.
_PROP_PRIMARY_OUTCOME = {
    "player_pass_yds": "Over",
    "player_rush_yds": "Over",
    "player_reception_yds": "Over",
    "player_receptions": "Over",
    "player_anytime_td": "Yes",
}
_PROP_LABELS = {
    "player_pass_yds": "Pass yds",
    "player_rush_yds": "Rush yds",
    "player_reception_yds": "Rec yds",
    "player_receptions": "Receptions",
    "player_anytime_td": "Anytime TD",
}


def _consensus_point(rows, market: str, outcome: Optional[str] = None) -> Optional[float]:
    values = [
        r.point
        for r in rows
        if r.market == market and (outcome is None or r.outcome == outcome) and r.point is not None
    ]
    if not values:
        return None
    return round(sum(values) / len(values), 1)


def _best_price(rows, market: str, outcome: str) -> Optional[int]:
    prices = [r.price for r in rows if r.market == market and r.outcome == outcome and r.price is not None]
    return max(prices) if prices else None


def get_games(db: Session, season: Optional[int] = None, week: Optional[int] = None) -> Dict[str, Any]:
    if season is None or week is None:
        ctx = default_context(db)
        season = season if season is not None else ctx["season"]
        week = week if week is not None else ctx["week"]

    games = (
        db.query(FantasyGame)
        .filter(FantasyGame.season == season, FantasyGame.week == week)
        .order_by(FantasyGame.kickoff.asc())
        .all()
    )
    latest = latest_successful_run(db, "odds_lines")
    latest_by_game: Dict[str, list] = {}
    if latest is not None:
        for row in db.query(FantasyOddsSnapshot).filter(FantasyOddsSnapshot.run_id == latest.id).all():
            if row.game_id:
                latest_by_game.setdefault(row.game_id, []).append(row)

    result = []
    for game in games:
        entry = {
            "game_id": game.game_id,
            "week": game.week,
            "home_team": game.home_team,
            "away_team": game.away_team,
            "kickoff": iso_utc(game.kickoff),
        }
        rows = latest_by_game.get(game.game_id, [])
        if rows:
            spread_home = _consensus_point(rows, "spreads", game.home_team)
            entry["lines"] = {
                "spread_home": spread_home,
                "total": _consensus_point(rows, "totals", "Over"),
                "moneyline_home": _best_price(rows, "h2h", game.home_team),
                "moneyline_away": _best_price(rows, "h2h", game.away_team),
            }
            entry["spread_open"], entry["spread_move"] = _spread_movement(db, game.game_id, game.home_team, spread_home)
        result.append(entry)

    return {
        "season": season,
        "week": week,
        "as_of": iso_utc(latest.finished_at) if latest else None,
        "games": result,
    }


def _spread_movement(db, game_id, home_team, current):
    """Return (open_point, delta) for a game's home spread across snapshots."""
    rows = (
        db.query(FantasyOddsSnapshot)
        .filter(
            FantasyOddsSnapshot.game_id == game_id,
            FantasyOddsSnapshot.market == "spreads",
            FantasyOddsSnapshot.outcome == home_team,
            FantasyOddsSnapshot.point.isnot(None),
        )
        .order_by(FantasyOddsSnapshot.fetched_at.asc())
        .all()
    )
    if not rows or current is None:
        return None, None
    open_point = rows[0].point
    return open_point, round(current - open_point, 1)


# Named for its (rows, market, outcome) shape like _consensus_point and
# _best_price beside it. It must NOT be called _consensus_price: that name
# belongs to the probability-space helper further down, and having both meant
# the later definition silently shadowed this one and turned every
# /games/{id}/lines/history?market=h2h call into a TypeError.
def _consensus_price_for_outcome(rows, market: str, outcome: str) -> Optional[int]:
    prices = [
        r.price
        for r in rows
        if r.market == market and r.outcome == outcome and r.price is not None
    ]
    # Delegated rather than averaged here: American odds jump from +100 to
    # -100 across even money, so a mean of the integers is not the consensus
    # of the chances they describe.
    return _consensus_price(prices)


def get_game_lines_history(db, game_id: str, market: str = "spreads") -> Dict[str, Any]:
    rows = (
        db.query(FantasyOddsSnapshot)
        .filter(FantasyOddsSnapshot.game_id == game_id, FantasyOddsSnapshot.market == market)
        .order_by(FantasyOddsSnapshot.fetched_at.asc())
        .all()
    )
    game = db.get(FantasyGame, game_id)
    # spreads track the home line; totals track Over. h2h has no point line, so
    # its series is the home team's moneyline *price* over time instead.
    if market == "h2h":
        outcome = game.home_team if game else None
    elif market == "spreads":
        outcome = game.home_team if game else None
    else:
        outcome = "Over"
    by_run: Dict[int, list] = {}
    for row in rows:
        by_run.setdefault(row.run_id, []).append(row)
    series = []
    for run_id, run_rows in by_run.items():
        if market == "h2h":
            value = _consensus_price_for_outcome(run_rows, market, outcome) if outcome else None
        else:
            value = _consensus_point(run_rows, market, outcome)
        if value is None:
            continue
        series.append({"fetched_at": iso_utc(run_rows[0].fetched_at), "point": value})
    series.sort(key=lambda item: item["fetched_at"] or "")
    return {"game_id": game_id, "market": market, "outcome": outcome, "history": series}


def _reduce_props(rows) -> Dict[str, Dict[str, Any]]:
    """Best line per (market, player) from a set of prop snapshot rows."""
    best: Dict[tuple, Dict[str, Any]] = {}
    for row in rows:
        if row.outcome != _PROP_PRIMARY_OUTCOME.get(row.market):
            continue
        key = (row.market, row.player_id or row.player_name_raw)
        current = best.get(key)
        if current is None or (row.price is not None and (current["price"] is None or row.price > current["price"])):
            best[key] = {
                "market": row.market,
                "player_id": row.player_id,
                "player_name": row.player_name_raw,
                "point": row.point,
                "price": row.price,
            }
    return best


def get_props(db: Session, week: Optional[int] = None) -> Dict[str, Any]:
    run = latest_successful_run(db, "odds_props")
    if run is None:
        return {"as_of": None, "featured": []}
    rows = db.query(FantasyPropSnapshot).filter(FantasyPropSnapshot.run_id == run.id).all()
    players = _player_index(db, [r.player_id for r in rows if r.player_id])

    by_event: Dict[str, list] = {}
    for row in rows:
        by_event.setdefault(row.event_id, []).append(row)

    featured = []
    for event_id, event_rows in by_event.items():
        game_id = next((r.game_id for r in event_rows if r.game_id), None)
        game = db.get(FantasyGame, game_id) if game_id else None
        reduced = _reduce_props(event_rows)
        markets: Dict[str, list] = {}
        for entry in reduced.values():
            player = players.get(entry["player_id"]) if entry["player_id"] else None
            markets.setdefault(entry["market"], []).append(
                {
                    "player_id": entry["player_id"],
                    "player_name": (player.full_name if player else entry["player_name"]),
                    "team": player.team if player else None,
                    "point": entry["point"],
                    "price": entry["price"],
                }
            )
        market_list = []
        for market_key, lines in markets.items():
            # Yardage/reception markets have a point line to rank by (highest
            # first). Anytime-TD carries no point, so order by odds instead —
            # shortest (most negative American price) = likeliest scorer first.
            if market_key == "player_anytime_td":
                lines.sort(key=lambda line: (line["price"] is None, line["price"] if line["price"] is not None else 0))
            else:
                lines.sort(key=lambda line: (line["point"] is None, -(line["point"] or 0)))
            market_list.append({"market": market_key, "label": _PROP_LABELS.get(market_key, market_key), "lines": lines})
        featured.append(
            {
                "event_id": event_id,
                "game_id": game_id,
                "home_team": game.home_team if game else None,
                "away_team": game.away_team if game else None,
                "markets": market_list,
            }
        )
    return {"as_of": iso_utc(run.finished_at), "featured": featured}


def get_prop_history(db, player_id: str, market: str) -> Dict[str, Any]:
    outcome = _PROP_PRIMARY_OUTCOME.get(market, "Over")
    rows = (
        db.query(FantasyPropSnapshot)
        .filter(
            FantasyPropSnapshot.player_id == player_id,
            FantasyPropSnapshot.market == market,
            FantasyPropSnapshot.outcome == outcome,
        )
        .order_by(FantasyPropSnapshot.fetched_at.asc())
        .all()
    )
    by_run: Dict[int, list] = {}
    for row in rows:
        by_run.setdefault(row.run_id, []).append(row)
    series = []
    for run_rows in by_run.values():
        points = [r.point for r in run_rows if r.point is not None]
        if not points:
            continue
        series.append(
            {
                "fetched_at": iso_utc(run_rows[0].fetched_at),
                "point": round(sum(points) / len(points), 1),
            }
        )
    series.sort(key=lambda item: item["fetched_at"] or "")
    return {"player_id": player_id, "market": market, "history": series}


def _player_props(db, player_id: str) -> list:
    run = latest_successful_run(db, "odds_props")
    if run is None:
        return []
    rows = (
        db.query(FantasyPropSnapshot)
        .filter(FantasyPropSnapshot.run_id == run.id, FantasyPropSnapshot.player_id == player_id)
        .all()
    )
    reduced = _reduce_props(rows)
    return [
        {
            "market": entry["market"],
            "label": _PROP_LABELS.get(entry["market"], entry["market"]),
            "point": entry["point"],
            "price": entry["price"],
        }
        for entry in reduced.values()
    ]


def _implied_probability(american: Optional[int]) -> Optional[float]:
    """American odds -> break-even win probability (vig included)."""
    if american is None or american == 0:
        return None
    if american > 0:
        return 100 / (american + 100)
    return -american / (-american + 100)


def _season_probability_curve(rows, market: str) -> List[tuple]:
    """One consensus P(over) quote per threshold, ordered low to high."""
    by_point: Dict[float, List[float]] = {}
    for row in rows:
        if row.market != market or row.outcome != "Over" or row.point is None:
            continue
        probability = _implied_probability(row.price)
        if probability is not None:
            by_point.setdefault(row.point, []).append(probability)
    return [
        (point, sum(probabilities) / len(probabilities))
        for point, probabilities in sorted(by_point.items())
    ]


def _season_market_drop_rate(rows_by_player: Dict[str, list], market: str) -> Optional[float]:
    """Typical probability drop per raw unit across the market's ladders.

    A shared rate lets a one-contract player receive the same kind of implied
    value as a player whose ladder happens to contain the 50% crossing. The
    median is deliberately used here: a thin quote can distort one interval,
    but should not move every sparse player in the category.
    """
    rates = []
    for rows in rows_by_player.values():
        curve = _season_probability_curve(rows, market)
        for (low, low_probability), (high, high_probability) in zip(curve, curve[1:]):
            if high > low and low_probability > high_probability:
                rates.append((low_probability - high_probability) / (high - low))
    return median(rates) if rates else None


def _latest_season_prop_run(db: Session, season: int):
    """The newest run that actually produced a board.

    A run is ``partial`` when one provider failed, which is degraded but is
    still a board: the others wrote their rows. Serving only ``success``
    would freeze the dashboard on the last complete snapshot for as long as a
    provider stayed down — and these are public endpoints nobody promised us,
    so "down" can mean forever.

    The other kind of partial — nothing cleared the quote filter, or nothing
    matched the player catalog — is skipped, and the test for it is direct:
    a run qualifies only if it left behind rows attached to a real player,
    which is exactly what every board below queries for. A run that stored
    quotes under names the catalog does not know has a row count but no
    board, and must not replace one.
    """
    with_players = (
        db.query(FantasySeasonPropSnapshot.run_id)
        .filter(FantasySeasonPropSnapshot.player_id.isnot(None))
        .distinct()
    )
    return (
        db.query(FantasyCollectionRun)
        .filter(
            FantasyCollectionRun.job == "season_props",
            FantasyCollectionRun.season == season,
            FantasyCollectionRun.status.in_(("success", "partial")),
            FantasyCollectionRun.id.in_(with_players),
        )
        .order_by(FantasyCollectionRun.id.desc())
        .first()
    )


def _season_prop_run_at_or_before(db: Session, season: int, cutoff):
    """Newest complete market board at or before an exact UTC cutoff."""
    with_players = (
        db.query(FantasySeasonPropSnapshot.run_id)
        .filter(FantasySeasonPropSnapshot.player_id.isnot(None))
        .distinct()
    )
    return (
        db.query(FantasyCollectionRun)
        .filter(
            FantasyCollectionRun.job == "season_props",
            FantasyCollectionRun.season == season,
            FantasyCollectionRun.status == "success",
            FantasyCollectionRun.finished_at.isnot(None),
            FantasyCollectionRun.finished_at <= cutoff,
            FantasyCollectionRun.id.in_(with_players),
        )
        .order_by(FantasyCollectionRun.finished_at.desc(), FantasyCollectionRun.id.desc())
        .first()
    )


def _season_drop_rates(snapshots) -> Dict[Tuple[str, str], float]:
    """Typical curve slope for each (provider, market) pair on the board.

    The slope belongs to a provider's ladder, not to the category. Underdog
    posts one balanced line per player and so has no slope at all, while the
    two exchanges quote strikes at their own spacings; pooling them would
    hand a provider an extrapolation rate its own board never showed.

    Only rows matched to a player contribute. Unmatched rows all share a null
    player id, and averaging every unidentified quote at a shared threshold
    into one "player" produces a curve that describes nobody.
    """
    grouped: Dict[Tuple[str, str], Dict[str, list]] = {}
    for row in snapshots:
        if row.player_id is None:
            continue
        grouped.setdefault((row.bookmaker, row.market), {}).setdefault(
            row.player_id, []
        ).append(row)

    rates: Dict[Tuple[str, str], float] = {}
    for key, rows_by_player in grouped.items():
        rate = _season_market_drop_rate(rows_by_player, key[1])
        if rate is not None:
            rates[key] = rate
    return rates


# Returned instead of a row when a half/PPR total would need a reception
# projection the feed does not have. The board counts these so it can say how
# many players a scoring format hides.
_EXCLUDED_NO_PROJECTION = object()


def _score_season_player(
    market_rows,
    drop_rates: Dict[Tuple[str, str], float],
    player: Optional[FantasyPlayer],
    projection: Dict[str, Any],
    reception_multiplier: float,
    scoring_field: str,
):
    """One player's row on the implied-points board.

    Split out of ``get_season_fantasy_point_leaders`` so a single player can be
    priced against a historical run without building — and then discarding —
    every other player on that board. Drop rates stay a caller argument because
    they are a board-wide statistic: the slope comes from every player quoted by
    a provider, so one player's history still has to be read against the whole
    run to reproduce the number the board showed.
    """
    implied = {
        market: _season_consensus_value(rows, market, drop_rates)
        for market, rows in market_rows.items()
    }
    implied = {market: value for market, value in implied.items() if value is not None}
    position = player.position if player else None
    primary_pair = SEASON_FANTASY_PRIMARY_PAIR.get(position)
    complete_pairs = {
        name: pair
        for name, pair in SEASON_FANTASY_MARKET_PAIRS.items()
        if all(market in implied for market in pair)
    }
    # A category with only one half quoted is dropped from the total.
    # Reported separately because "scored on passing alone" means two
    # very different things depending on whether a rushing market exists.
    partial_pairs = sorted(
        name
        for name, pair in SEASON_FANTASY_MARKET_PAIRS.items()
        if name not in complete_pairs and any(market in implied for market in pair)
    )
    # A category with *no* quote at all is the bigger omission and used to be
    # invisible: partial_pairs only fires when one half is quoted, so a running
    # back whose receiving market was never posted scored on rushing alone and
    # said nothing about it, while his projection still counted every catch.
    # That is the common case, not the rare one, and it made the edge column
    # read as market disagreement when it was really missing data.
    missing_pairs = sorted(
        name
        for name in SEASON_FANTASY_EXPECTED_PAIRS.get(position, ())
        if name not in complete_pairs and name not in partial_pairs
    )
    if primary_pair not in complete_pairs:
        return None
    # Keyed on every projection row, not only rows a reception count could be
    # derived from, so presence of the key does not imply a usable figure.
    projected_receptions = projection.get("receptions")
    if reception_multiplier and projected_receptions is None:
        # A PPR total without a reception projection would understate the
        # player rather than merely omit a detail, so the row is dropped.
        return _EXCLUDED_NO_PROJECTION

    used_markets = {
        market
        for pair in complete_pairs.values()
        for market in pair
    }
    implied = {market: implied[market] for market in used_markets}
    yard_markets = SEASON_YARD_MARKETS.intersection(used_markets)
    touchdown_markets = SEASON_TD_MARKETS.intersection(used_markets)

    yard_points = round(
        sum(implied[market] * SEASON_FANTASY_WEIGHTS[market] for market in yard_markets), 1
    )
    touchdown_points = round(
        sum(implied[market] * SEASON_FANTASY_WEIGHTS[market] for market in touchdown_markets), 1
    )
    reception_points = round((projected_receptions or 0) * reception_multiplier, 1)
    fantasy_points_total = round(yard_points + touchdown_points + reception_points, 1)
    # Rounded before the subtraction: 157.0 - 160.0 in float is
    # -3.0000000000000114, and the delta is read as a headline number.
    projected_points = projection.get(scoring_field)
    projected_points = round(projected_points, 1) if projected_points is not None else None
    books = sorted({
        row.bookmaker
        for market in used_markets
        for row in market_rows.get(market, [])
    })
    return {
        "player": _player_public(player),
        "yard_points": yard_points,
        "touchdown_points": touchdown_points,
        "projected_receptions": (
            round(projected_receptions, 1) if projected_receptions is not None else None
        ),
        "reception_points": reception_points,
        "fantasy_points": fantasy_points_total,
        "markets_used": len(implied),
        "pairs_used": sorted(complete_pairs),
        "partial_pairs": partial_pairs,
        "missing_pairs": missing_pairs,
        # The edge is market-minus-projection, and the projection counts
        # categories the market total may not have. Flagged rather than
        # withheld: the number is still the best comparison available, but it
        # is not a like-for-like one, and the column should not pretend it is.
        "edge_is_qualified": bool(missing_pairs or partial_pairs),
        "projected_points": projected_points,
        "projection_delta": (
            round(fantasy_points_total - projected_points, 1)
            if projected_points is not None
            else None
        ),
        "books": books,
        "implied": implied,
    }


def _season_book_values(
    rows, market: str, drop_rates: Dict[Tuple[str, str], float]
) -> Dict[str, float]:
    """The 50% crossing each provider's own quotes imply for this market.

    Providers are kept apart on purpose. Their ladders sit at different
    thresholds, so interpolating through the pooled points would trace a
    curve neither of them posted.
    """
    by_book: Dict[str, list] = {}
    for row in rows:
        if row.market == market:
            by_book.setdefault(row.bookmaker, []).append(row)

    values: Dict[str, float] = {}
    for book, book_rows in by_book.items():
        value = _season_implied_value(book_rows, market, drop_rates.get((book, market)))
        if value is not None:
            values[book] = value
    return values


def _season_consensus_value(
    rows, market: str, drop_rates: Dict[Tuple[str, str], float]
) -> Optional[float]:
    """One implied value per player: the median across providers quoting him.

    The median rather than the mean, because these boards go stale at
    different rates. Two providers give their midpoint, and a third stops a
    ladder that has not traded in a week from dragging the number on its own.
    """
    values = _season_book_values(rows, market, drop_rates)
    if not values:
        return None
    return round(median(sorted(values.values())), 1)


def _season_sources(rows) -> List[Dict[str, Any]]:
    """Per-provider coverage and freshness for the board these rows describe.

    ``quoted_at`` is the provider's own last movement, which is the honest
    number to show: the collection run can be an hour old while the quotes
    behind it have not changed in eleven days.
    """
    books: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        entry = books.setdefault(
            row.bookmaker, {"quoted_at": None, "players": set()}
        )
        if row.player_id is not None:
            entry["players"].add(row.player_id)
        quoted_at = getattr(row, "quoted_at", None)
        if quoted_at is not None and (
            entry["quoted_at"] is None or quoted_at > entry["quoted_at"]
        ):
            entry["quoted_at"] = quoted_at
    return [
        {
            "bookmaker": bookmaker,
            "quoted_at": iso_utc(entry["quoted_at"]),
            "players": len(entry["players"]),
        }
        for bookmaker, entry in sorted(books.items())
    ]


def _season_source_label(sources: List[Dict[str, Any]]) -> Optional[str]:
    return ", ".join(entry["bookmaker"] for entry in sources) or None


def _season_implied_value(rows, market: str, market_drop_rate: Optional[float]) -> Optional[float]:
    """Estimate the raw stat at which the market's over chance reaches 50%.

    An exchange quotes a survival curve -- P(player exceeds threshold) --
    rather than a conventional projection. Interpolating its 50% crossing
    turns the available contracts into one value in yards or touchdowns. When
    the crossing sits outside a player's sparse ladder, the provider's typical
    curve slope supplies the small extrapolation; a source that posts a single
    balanced line has no slope, and its posted number stands as it is.

    ``rows`` must come from one provider. Their ladders sit at different
    thresholds, so a curve traced through the pooled points is one nobody
    posted.
    """
    curve = _season_probability_curve(rows, market)
    if not curve:
        return None

    for point, probability in curve:
        if abs(probability - 0.5) < 1e-9:
            return round(point, 1)
    for (low, low_probability), (high, high_probability) in zip(curve, curve[1:]):
        if low_probability >= 0.5 >= high_probability and low_probability > high_probability:
            share = (low_probability - 0.5) / (low_probability - high_probability)
            return round(low + share * (high - low), 1)

    # No quoted threshold straddles 50%. Use the quote nearest to even and
    # the typical slope from all usable ladders in this category. Falling back
    # to that threshold keeps a very sparse category useful without pretending
    # an unsupported probability adjustment is precise.
    point, probability = min(curve, key=lambda quote: abs(quote[1] - 0.5))
    if not market_drop_rate or market_drop_rate <= 0:
        return round(point, 1)
    return round(max(0.0, point + (probability - 0.5) / market_drop_rate), 1)


def _season_market_summary(
    rows,
    market: str,
    label: str,
    drop_rates: Optional[Dict[Tuple[str, str], float]] = None,
) -> Dict[str, Any]:
    drop_rates = drop_rates or {}
    market_rows = [row for row in rows if row.market == market and row.point is not None]
    if not market_rows:
        return {
            "market": market,
            "label": label,
            "line": None,
            "implied_value": None,
            "over_price": None,
            "under_price": None,
            "books": [],
        }

    # Providers hang nearby numbers. Use the line posted by the most of them
    # as the headline consensus, then report prices only among the providers
    # offering that exact total.
    #
    # Ties break toward the most balanced price. That matters most for an
    # exchange ladder, where a single source posts many thresholds for one
    # player: every threshold has one "book", so without this the headline
    # falls on whichever strike sits mid-ladder rather than the one the market
    # actually straddles — quoting Justin Jefferson at 1499.5 receiving yards
    # (+426) instead of the near-even number just below it. A median tie-break
    # still settles anything the price cannot.
    by_point: Dict[float, set] = {}
    imbalance: Dict[float, float] = {}
    for row in market_rows:
        by_point.setdefault(row.point, set()).add(row.bookmaker)
        if row.outcome == "Over":
            implied = _implied_probability(row.price)
            if implied is not None:
                distance = abs(implied - 0.5)
                if distance < imbalance.get(row.point, 1.0):
                    imbalance[row.point] = distance
    ordered_points = sorted(by_point)
    midpoint = ordered_points[len(ordered_points) // 2]
    point = max(
        ordered_points,
        key=lambda value: (
            len(by_point[value]),
            -imbalance.get(value, 1.0),
            -abs(value - midpoint),
        ),
    )
    consensus_rows = [row for row in market_rows if row.point == point]

    # Every provider with a read on this market appears, not only the ones
    # posting the headline number. The implied value below is a median across
    # all of them, so listing a subset beside it would credit the wrong
    # sources — a value three providers agree on must not read as one's.
    # Prices stay empty for a provider quoting some other threshold, which is
    # the honest answer to "what do they have at this line".
    book_values = _season_book_values(rows, market, drop_rates)
    books: Dict[str, Dict[str, Any]] = {
        bookmaker: {
            "bookmaker": bookmaker,
            "over_price": None,
            "under_price": None,
            "implied_value": value,
        }
        for bookmaker, value in book_values.items()
    }
    for row in consensus_rows:
        entry = books.setdefault(row.bookmaker, {
            "bookmaker": row.bookmaker,
            "over_price": None,
            "under_price": None,
            "implied_value": book_values.get(row.bookmaker),
        })
        if row.outcome == "Over":
            entry["over_price"] = row.price
        elif row.outcome == "Under":
            entry["under_price"] = row.price
    book_list = sorted(books.values(), key=lambda entry: entry["bookmaker"])

    # Every provider's prices reach here already de-vigged into complements,
    # so they are estimates of the same probability rather than competing
    # offers. Taking the best of them would not be line shopping, it would be
    # picking whichever source is most optimistic; the median is the estimate.
    # Per-provider prices stay in ``books`` for anyone who wants to compare.
    return {
        "market": market,
        "label": label,
        "line": point,
        "implied_value": _season_consensus_value(rows, market, drop_rates),
        "over_price": _consensus_price(entry["over_price"] for entry in book_list),
        "under_price": _consensus_price(entry["under_price"] for entry in book_list),
        "books": book_list,
    }


def _consensus_price(prices) -> Optional[int]:
    """Median of several American prices, taken in probability space.

    American odds jump from +100 to -100 across even money, so the median of
    the integers is not the median of the chances they describe.
    """
    probabilities = [
        probability
        for probability in (_implied_probability(price) for price in prices)
        if probability is not None
    ]
    if not probabilities:
        return None
    return probability_to_american(median(sorted(probabilities)))


def get_player_season_props(
    db: Session, player_id: str, season: Optional[int] = None
) -> Optional[Dict[str, Any]]:
    player = db.get(FantasyPlayer, player_id)
    if player is None:
        return None
    if season is None:
        season = default_context(db)["season"]
    run = _latest_season_prop_run(db, season)
    rows = []
    drop_rates: Dict[Tuple[str, str], float] = {}
    if run is not None:
        # Slopes are read from the whole board, not from this player's own
        # ladder: a player quoted at a single threshold has no slope of his
        # own, which is exactly when the extrapolation is needed.
        drop_rates = _season_drop_rates(
            db.query(FantasySeasonPropSnapshot)
            .filter(FantasySeasonPropSnapshot.run_id == run.id)
            .all()
        )
        rows = (
            db.query(FantasySeasonPropSnapshot)
            .filter(
                FantasySeasonPropSnapshot.run_id == run.id,
                FantasySeasonPropSnapshot.player_id == player_id,
            )
            .all()
        )
    sources = _season_sources(rows)
    return {
        "season": season,
        "player": _player_public(player),
        "as_of": iso_utc(run.finished_at) if run else None,
        "source": _season_source_label(sources),
        "sources": sources,
        "markets": [
            _season_market_summary(rows, market, label, drop_rates)
            for market, label in SEASON_PROP_MARKETS
        ],
    }


def get_season_prop_leaders(
    db: Session,
    market: Optional[str] = None,
    season: Optional[int] = None,
    limit: int = 60,
    _run=None,
    _include_movement: bool = True,
) -> Dict[str, Any]:
    """Every quoted player, ranked by the market-implied raw stat value.

    The per-player lookup answers "what is this player's number", which is
    only useful once you already know he has one — and barely a few hundred
    of the several thousand players in the catalog do. This answers the
    question that has to come first: who is quoted at all.

    Each value is the 50% crossing of the player's quoted probability curve,
    expressed in the category's native yards or touchdowns, and taken as the
    median across every provider quoting him.
    """
    if season is None:
        season = default_context(db)["season"]
    run = _run or _latest_season_prop_run(db, season)
    labels = dict(SEASON_PROP_MARKETS)

    rows_by_market: Dict[str, Dict[str, list]] = {key: {} for key, _ in SEASON_PROP_MARKETS}
    snapshots = []
    if run is not None:
        snapshots = (
            db.query(FantasySeasonPropSnapshot)
            .filter(
                FantasySeasonPropSnapshot.run_id == run.id,
                FantasySeasonPropSnapshot.player_id.isnot(None),
            )
            .all()
        )
        for row in snapshots:
            if row.market in rows_by_market:
                rows_by_market[row.market].setdefault(row.player_id, []).append(row)

    # A market nobody is quoted in is still reported, with a count of zero, so
    # the client can show the whole board and grey out what is not trading
    # rather than silently offering a tab that turns up empty.
    markets = [
        {"market": key, "label": label, "players": len(rows_by_market[key])}
        for key, label in SEASON_PROP_MARKETS
    ]
    if market not in rows_by_market:
        market = max(markets, key=lambda entry: entry["players"])["market"]

    drop_rates = _season_drop_rates(snapshots)
    leaders = []
    players = _player_index(db, list(rows_by_market[market]))
    for player_id, rows in rows_by_market[market].items():
        summary = _season_market_summary(rows, market, labels[market], drop_rates)
        if summary["line"] is None:
            continue
        chance = _implied_probability(summary["over_price"])
        book_values = _season_book_values(rows, market, drop_rates)
        leaders.append({
            "player": _player_public(players.get(player_id)),
            "implied_value": summary["implied_value"],
            "line": summary["line"],
            "over_price": summary["over_price"],
            "under_price": summary["under_price"],
            "over_chance": round(chance, 3) if chance is not None else None,
            # Which providers stand behind the number, and where they differ.
            # Two sources agreeing is a far stronger read than one, and the
            # board has no other way to say so.
            "books": sorted(book_values),
            "book_values": {book: book_values[book] for book in sorted(book_values)},
        })
    # The derived raw value combines the threshold and price, so it can rank
    # players across the exchange's coarse strike clusters instead of treating
    # the threshold as primary and the probability as only a tiebreak.
    leaders.sort(
        key=lambda entry: (
            -(entry["implied_value"] if entry["implied_value"] is not None else -1),
            entry["player"]["name"] or "",
        )
    )

    baseline_as_of = None
    if _include_movement and run is not None and run.finished_at is not None:
        baseline_run = _season_prop_run_at_or_before(
            db, season, run.finished_at - timedelta(days=7)
        )
        if baseline_run is not None:
            baseline = get_season_prop_leaders(
                db,
                market=market,
                season=season,
                limit=10000,
                _run=baseline_run,
                _include_movement=False,
            )
            baseline_as_of = baseline.get("as_of")
            baseline_values = {
                entry["player"]["player_id"]: entry.get("implied_value")
                for entry in baseline["leaders"]
            }
            for entry in leaders:
                value = baseline_values.get(entry["player"]["player_id"])
                entry["baseline_value"] = value
                entry["movement"] = (
                    round(entry["implied_value"] - value, 1)
                    if value is not None and entry["implied_value"] is not None
                    else None
                )

    sources = _season_sources(snapshots)
    return {
        "season": season,
        "as_of": iso_utc(run.finished_at) if run else None,
        "baseline_as_of": baseline_as_of,
        "source": _season_source_label(sources),
        "sources": sources,
        "market": market,
        "label": labels[market],
        "markets": markets,
        "leaders": leaders[:limit],
    }


# The scoring format the board is asked for picks the projection field to
# compare against. Resolved here rather than client-side so the column can
# never disagree with the toggle that produced it.
_SEASON_SCORING_FIELD = {
    "std": "pts_std",
    "half": "pts_half_ppr",
    "ppr": "pts_ppr",
}


def _season_projection_map(
    db: Session, season: int
) -> tuple[Dict[str, Dict[str, Any]], Optional[str], Optional[List[str]]]:
    """Season-long projections per player: receptions, and points per scoring.

    Receptions come from one run because they are read out of ``stats_json``,
    which the consensus blend does not carry. Points prefer the blend across
    providers and fall back to that same run, so a single-provider install
    still gets a column rather than an empty one. The returned source names
    what the *points* came from, since that is what the board displays.
    """
    run = (
        _resolve_projection_run(db, season, SEASON_LONG_WEEK, "sleeper")
        or _resolve_projection_run(db, season, SEASON_LONG_WEEK, None)
    )
    consensus, _ = _consensus_projection_map(db, season, SEASON_LONG_WEEK)
    if run is None and not consensus:
        return {}, None, None

    projections: Dict[str, Dict[str, Any]] = {}
    rows = (
        db.query(FantasyProjection).filter(FantasyProjection.run_id == run.id).all()
        if run is not None
        else []
    )
    for row in rows:
        try:
            stats = json.loads(row.stats_json) if row.stats_json else {}
        except (TypeError, json.JSONDecodeError):
            stats = {}
        value = None
        for key in ("rec", "receptions", "receiving_receptions"):
            value = coerce_float(stats.get(key))
            if value is not None:
                break
        # A provider may omit the component while still publishing all three
        # scoring totals. Their PPR-standard difference is the reception count.
        if value is None and row.pts_ppr is not None and row.pts_std is not None:
            value = max(0.0, row.pts_ppr - row.pts_std)
        projections[row.player_id] = {
            "receptions": value,
            "pts_std": row.pts_std,
            "pts_half_ppr": row.pts_half_ppr,
            "pts_ppr": row.pts_ppr,
        }

    for player_id, blended in consensus.items():
        entry = projections.setdefault(player_id, {"receptions": None})
        for field in _SEASON_SCORING_FIELD.values():
            if blended.get(field) is not None:
                entry[field] = blended[field]

    providers = None
    source = run.source if run is not None else None
    if consensus:
        source = "consensus"
        providers = sorted({
            provider
            for blended in consensus.values()
            for provider in blended.get("providers", [])
        })
    return projections, source, providers


def get_season_fantasy_point_leaders(
    db: Session,
    season: Optional[int] = None,
    scoring: str = "std",
    limit: int = 100,
    _run=None,
) -> Dict[str, Any]:
    """Rank players by fantasy points implied by quoted markets.

    Every available yardage and touchdown ladder is first converted to its
    native 50% value, taken as the median across the providers quoting it.
    Those raw values are then scored with conventional standard rules;
    half-PPR and PPR add the latest season reception projection because no
    market quotes receptions. Passing, rushing and receiving contribute only
    when both halves of that category are quoted, and a row requires the
    primary pair for the player's position. This prevents passing yards plus
    rushing touchdowns from masquerading as a complete QB projection when
    passing-TD data is absent.

    Each row reports both the categories it scored (``pairs_used``) and the
    ones it had to discard for want of a second half (``partial_pairs``): a
    running quarterback scored on passing alone is short by his rushing, and
    that is only visible if the dropped category is named.

    Rows also carry the season-long consensus projection for the requested
    scoring (``projected_points``) and the gap to it (``projection_delta``),
    so the market number can be read against consensus rather than in place
    of it. Half-PPR and PPR still drop players with no reception projection,
    but the count is reported as ``excluded_without_projection`` rather than
    quietly shrinking the board when the scoring toggle moves.
    """
    if season is None:
        season = default_context(db)["season"]
    scoring = normalize_scoring(scoring)
    run = _run or _latest_season_prop_run(db, season)
    if run is None:
        return {
            "season": season,
            "as_of": None,
            "source": None,
            "sources": [],
            "scoring": scoring,
            "projection_source": None,
            "projection_providers": None,
            "excluded_without_projection": 0,
            "leaders": [],
        }

    snapshots = (
        db.query(FantasySeasonPropSnapshot)
        .filter(
            FantasySeasonPropSnapshot.run_id == run.id,
            FantasySeasonPropSnapshot.player_id.isnot(None),
        )
        .all()
    )
    rows_by_player: Dict[str, Dict[str, list]] = {}
    for row in snapshots:
        if row.market not in SEASON_FANTASY_WEIGHTS:
            continue
        rows_by_player.setdefault(row.player_id, {}).setdefault(row.market, []).append(row)

    drop_rates = _season_drop_rates(snapshots)
    players = _player_index(db, list(rows_by_player))
    projections, projection_source, projection_providers = _season_projection_map(db, season)
    reception_multiplier = {"std": 0.0, "half": 0.5, "ppr": 1.0}[scoring]
    scoring_field = _SEASON_SCORING_FIELD[scoring]
    excluded_without_projection = 0
    leaders = []
    for player_id, market_rows in rows_by_player.items():
        row = _score_season_player(
            market_rows,
            drop_rates,
            players.get(player_id),
            projections.get(player_id) or {},
            reception_multiplier,
            scoring_field,
        )
        if row is _EXCLUDED_NO_PROJECTION:
            excluded_without_projection += 1
            continue
        if row is not None:
            leaders.append(row)

    leaders.sort(key=lambda entry: (
        -entry["fantasy_points"],
        entry["player"]["name"] or "",
    ))
    sources = _season_sources(snapshots)
    return {
        "season": season,
        "as_of": iso_utc(run.finished_at),
        "source": _season_source_label(sources),
        "sources": sources,
        "scoring": scoring,
        "projection_source": projection_source,
        "projection_providers": projection_providers,
        "excluded_without_projection": excluded_without_projection,
        "leaders": leaders[:limit],
    }


def get_season_fantasy_movers(
    db: Session,
    season: Optional[int] = None,
    scoring: str = "std",
    days: int = 7,
    limit: int = 5,
) -> Dict[str, Any]:
    """Largest value-board changes against the exact historical cutoff."""
    if season is None:
        season = default_context(db)["season"]
    scoring = normalize_scoring(scoring)
    current_run = _latest_season_prop_run(db, season)
    empty = {
        "season": season,
        "scoring": scoring,
        "days": days,
        "as_of": iso_utc(current_run.finished_at) if current_run else None,
        "baseline_as_of": None,
        "gainers": [],
        "fallers": [],
    }
    if current_run is None or current_run.finished_at is None:
        return empty
    baseline_run = _season_prop_run_at_or_before(
        db, season, current_run.finished_at - timedelta(days=days)
    )
    if baseline_run is None:
        return empty

    current = get_season_fantasy_point_leaders(
        db, season=season, scoring=scoring, limit=10000, _run=current_run
    )
    baseline = get_season_fantasy_point_leaders(
        db, season=season, scoring=scoring, limit=10000, _run=baseline_run
    )
    baseline_values = {
        entry["player"]["player_id"]: entry["fantasy_points"]
        for entry in baseline["leaders"]
    }
    changes = []
    for entry in current["leaders"]:
        player_id = entry["player"]["player_id"]
        if player_id not in baseline_values:
            continue
        baseline_value = baseline_values[player_id]
        delta = round(entry["fantasy_points"] - baseline_value, 1)
        changes.append({
            "player": entry["player"],
            "current_value": entry["fantasy_points"],
            "baseline_value": baseline_value,
            "delta": delta,
            "as_of": current["as_of"],
            "baseline_as_of": baseline["as_of"],
        })

    empty.update({
        "baseline_as_of": baseline["as_of"],
        "gainers": sorted(
            (entry for entry in changes if entry["delta"] > 0),
            key=lambda entry: (-entry["delta"], entry["player"]["name"] or ""),
        )[:limit],
        "fallers": sorted(
            (entry for entry in changes if entry["delta"] < 0),
            key=lambda entry: (entry["delta"], entry["player"]["name"] or ""),
        )[:limit],
    })
    return empty


def get_player_season_fantasy_history(
    db: Session,
    player_id: str,
    season: Optional[int] = None,
    scoring: str = "std",
    days: int = 30,
) -> Optional[Dict[str, Any]]:
    """Chronological market/projection history, calculated once per run."""
    player = db.get(FantasyPlayer, player_id)
    if player is None:
        return None
    if season is None:
        season = default_context(db)["season"]
    scoring = normalize_scoring(scoring)
    latest = _latest_season_prop_run(db, season)
    if latest is None or latest.finished_at is None:
        return {
            "season": season, "scoring": scoring, "player": _player_public(player),
            "days": days, "points": [],
        }
    run_ids = (
        db.query(FantasySeasonPropSnapshot.run_id)
        .filter(FantasySeasonPropSnapshot.player_id == player_id)
        .distinct()
    )
    runs = (
        db.query(FantasyCollectionRun)
        .filter(
            FantasyCollectionRun.id.in_(run_ids),
            FantasyCollectionRun.job == "season_props",
            FantasyCollectionRun.season == season,
            FantasyCollectionRun.status.in_(("success", "partial")),
            FantasyCollectionRun.finished_at >= latest.finished_at - timedelta(days=days),
            FantasyCollectionRun.finished_at <= latest.finished_at,
        )
        .order_by(FantasyCollectionRun.finished_at.desc(), FantasyCollectionRun.id.desc())
        .limit(32)
        .all()
    )
    # Everything that does not vary per run is resolved once. The projection
    # map is keyed on season alone, so recomputing it inside the loop meant
    # scanning the whole projection table up to 32 times per drawer open.
    projections, _, _ = _season_projection_map(db, season)
    projection = projections.get(player_id) or {}
    reception_multiplier = {"std": 0.0, "half": 0.5, "ppr": 1.0}[scoring]
    scoring_field = _SEASON_SCORING_FIELD[scoring]

    points = []
    for run in reversed(runs):
        # The whole run is loaded because drop rates are a board-wide slope,
        # but only the requested player is priced from it.
        snapshots = (
            db.query(FantasySeasonPropSnapshot)
            .filter(
                FantasySeasonPropSnapshot.run_id == run.id,
                FantasySeasonPropSnapshot.player_id.isnot(None),
            )
            .all()
        )
        market_rows: Dict[str, list] = {}
        for snapshot in snapshots:
            if snapshot.player_id == player_id and snapshot.market in SEASON_FANTASY_WEIGHTS:
                market_rows.setdefault(snapshot.market, []).append(snapshot)
        if not market_rows:
            continue
        row = _score_season_player(
            market_rows,
            _season_drop_rates(snapshots),
            player,
            projection,
            reception_multiplier,
            scoring_field,
        )
        if row is None or row is _EXCLUDED_NO_PROJECTION:
            continue
        points.append({
            "as_of": iso_utc(run.finished_at),
            "market": row["fantasy_points"],
            "projection": row["projected_points"],
            "edge": row["projection_delta"],
        })
    return {
        "season": season,
        "scoring": scoring,
        "player": _player_public(player),
        "days": days,
        "points": points,
    }


def get_season_offense_leaders(
    db: Session,
    season: Optional[int] = None,
    limit: int = 10,
) -> Dict[str, Any]:
    """Rank team offenses from non-overlapping market-implied player values.

    Passing and receiving describe much of the same yardage/touchdowns, so
    they must never be added together. A team's primary air component is its
    highest implied passing value; summed receiving values are only a
    fallback when no passer is quoted. Rushing is additive across players and
    forms the ground component.

    Each player contributes his implied 50% value rather than whichever
    threshold happened to be the headline line. With one exchange that
    distinction was cosmetic; with three providers it is required, because a
    Kalshi rung at 1,099.5 and an Underdog line at 1,247.5 are not the same
    kind of number and summing them would rank teams on which source quoted
    them.

    These are market-derived offense indicators, not official team totals:
    the providers list only selected players. The response exposes the
    components so the UI can say exactly what each number contains instead of
    presenting it as a projection model.
    """
    if season is None:
        season = default_context(db)["season"]
    run = _latest_season_prop_run(db, season)
    if run is None:
        return {
            "season": season,
            "as_of": None,
            "source": None,
            "sources": [],
            "yards": [],
            "touchdowns": [],
        }

    snapshots = (
        db.query(FantasySeasonPropSnapshot)
        .filter(
            FantasySeasonPropSnapshot.run_id == run.id,
            FantasySeasonPropSnapshot.player_id.isnot(None),
        )
        .all()
    )
    drop_rates = _season_drop_rates(snapshots)
    by_player_market: Dict[tuple, list] = {}
    for row in snapshots:
        by_player_market.setdefault((row.player_id, row.market), []).append(row)

    players = _player_index(db, list({player_id for player_id, _ in by_player_market}))
    by_team: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
    labels = dict(SEASON_PROP_MARKETS)
    for (player_id, market), rows in by_player_market.items():
        player = players.get(player_id)
        team = (player.team or "").upper() if player else ""
        if not team or team in {"FA", "UNK"} or market not in labels:
            continue
        value = _season_consensus_value(rows, market, drop_rates)
        if value is None:
            continue
        by_team.setdefault(team, {}).setdefault(market, []).append({
            "player_id": player_id,
            "name": player.full_name,
            "value": value,
        })

    def build(metric: str) -> List[Dict[str, Any]]:
        if metric == "yards":
            pass_market, receive_market, rush_market = (
                "season_pass_yds", "season_rec_yds", "season_rush_yds"
            )
        else:
            pass_market, receive_market, rush_market = (
                "season_pass_tds", "season_rec_tds", "season_rush_tds"
            )

        rankings = []
        for team, markets in by_team.items():
            passers = markets.get(pass_market, [])
            receivers = markets.get(receive_market, [])
            rushers = markets.get(rush_market, [])
            primary_passer = max(passers, key=lambda row: row["value"]) if passers else None
            if primary_passer:
                air_total = primary_passer["value"]
                air_source = "passing"
                air_players = 1
            elif receivers:
                air_total = sum(row["value"] for row in receivers)
                air_source = "receiving"
                air_players = len(receivers)
            else:
                air_total = None
                air_source = None
                air_players = 0
            ground_total = sum(row["value"] for row in rushers) if rushers else None

            # A partial offense would unfairly outrank or underrank teams on
            # coverage alone. Only compare teams with both air and ground
            # components; the response can legitimately contain fewer than
            # ten until enough players are quoted.
            if air_total is None or ground_total is None:
                continue
            rankings.append({
                "team": team,
                "total": round(air_total + ground_total, 1),
                "air": round(air_total, 1),
                "ground": round(ground_total, 1),
                "air_source": air_source,
                "players": air_players + len(rushers),
            })

        rankings.sort(key=lambda row: (-row["total"], row["team"]))
        return rankings[:limit]

    sources = _season_sources(snapshots)
    return {
        "season": season,
        "as_of": iso_utc(run.finished_at),
        "source": _season_source_label(sources),
        "sources": sources,
        "yards": build("yards"),
        "touchdowns": build("touchdowns"),
    }


def get_futures(db: Session, market: Optional[str] = None, limit: int = 20) -> Dict[str, Any]:
    run = latest_successful_run(db, "odds_futures")
    if run is None:
        return {"as_of": None, "market": market, "markets": [], "outcomes": []}
    query = db.query(FantasyFutureSnapshot).filter(FantasyFutureSnapshot.run_id == run.id)
    markets = sorted({r.market_key for r in query.all()})
    if market is None and markets:
        market = markets[0]

    rows = query.filter(FantasyFutureSnapshot.market_key == market).all() if market else []
    # Best (longest, i.e. most positive) price per outcome across books.
    best: Dict[str, int] = {}
    for row in rows:
        if row.price is None:
            continue
        if row.outcome not in best or row.price > best[row.outcome]:
            best[row.outcome] = row.price
    outcomes = sorted(best.items(), key=lambda item: item[1])[:limit]
    return {
        "as_of": iso_utc(run.finished_at),
        "market": market,
        "markets": markets,
        "outcomes": [{"outcome": name, "price": price} for name, price in outcomes],
    }


def get_dashboard(db: Session, per_position: int = 8) -> Dict[str, Any]:
    ctx = default_context(db)
    season, week = ctx["season"], ctx["week"]
    top = {}
    for position in ("QB", "RB", "WR", "TE"):
        top[position] = get_rankings(
            db, season, week, position=position, scoring="ppr", limit=per_position
        )["rankings"]
    return {
        "season": season,
        "week": week,
        "is_fallback": ctx["is_fallback"],
        "top_by_position": top,
        "trending_add": get_trending(db, "add", limit=5),
        "trending_drop": get_trending(db, "drop", limit=5),
    }
