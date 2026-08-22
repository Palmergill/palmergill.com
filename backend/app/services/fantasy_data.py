"""Read queries for the fantasy dashboard/API.

These are plain synchronous SQLAlchemy reads over the collected data — the
same in demo and authenticated modes. "Latest" for a snapshot table resolves
through the newest successful FantasyCollectionRun (see fantasy_collector).
"""
import json
from statistics import median
from typing import Any, Dict, List, Optional

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
from app.services.fantasy_common import (
    FLEX_POSITIONS,
    SCORING_POINTS_FIELD,
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
    term = (query or "").strip().lower()
    if len(term) < 2:
        return []
    like = f"%{term}%"
    rows = (
        db.query(FantasyPlayer)
        .filter(FantasyPlayer.search_name.like(like))
        .order_by(FantasyPlayer.full_name.asc())
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
            .limit(3)
            .all()
        )
        entry["recent_ppr"] = [
            {"week": s.week, "opponent": s.opponent, "fantasy_points_ppr": s.fantasy_points_ppr}
            for s in recent
        ]
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


def _consensus_price(rows, market: str, outcome: str) -> Optional[int]:
    prices = [
        r.price
        for r in rows
        if r.market == market and r.outcome == outcome and r.price is not None
    ]
    return round(sum(prices) / len(prices)) if prices else None


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
            value = _consensus_price(run_rows, market, outcome) if outcome else None
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


def _season_implied_value(rows, market: str, market_drop_rate: Optional[float]) -> Optional[float]:
    """Estimate the raw stat at which the market's over chance reaches 50%.

    Kalshi quotes a survival curve -- P(player exceeds threshold) -- rather
    than a conventional projection. Interpolating its 50% crossing turns the
    available contracts into one value in yards or touchdowns. When the
    crossing sits outside a player's sparse ladder, the category's typical
    curve slope supplies the small extrapolation.
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


def _season_market_summary(rows, market: str, label: str) -> Dict[str, Any]:
    market_rows = [row for row in rows if row.market == market and row.point is not None]
    if not market_rows:
        return {
            "market": market,
            "label": label,
            "line": None,
            "over_price": None,
            "under_price": None,
            "books": [],
        }

    # Sportsbooks can hang nearby numbers. Use the line posted by the most
    # books as the headline consensus, then line-shop prices only among books
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

    books: Dict[str, Dict[str, Any]] = {}
    for row in consensus_rows:
        entry = books.setdefault(row.bookmaker, {"bookmaker": row.bookmaker, "over_price": None, "under_price": None})
        if row.outcome == "Over":
            entry["over_price"] = row.price
        elif row.outcome == "Under":
            entry["under_price"] = row.price
    book_list = sorted(books.values(), key=lambda entry: entry["bookmaker"])
    over_prices = [entry["over_price"] for entry in book_list if entry["over_price"] is not None]
    under_prices = [entry["under_price"] for entry in book_list if entry["under_price"] is not None]
    return {
        "market": market,
        "label": label,
        "line": point,
        "over_price": max(over_prices) if over_prices else None,
        "under_price": max(under_prices) if under_prices else None,
        "books": book_list,
    }


def get_player_season_props(
    db: Session, player_id: str, season: Optional[int] = None
) -> Optional[Dict[str, Any]]:
    player = db.get(FantasyPlayer, player_id)
    if player is None:
        return None
    if season is None:
        season = default_context(db)["season"]
    run = latest_successful_run(db, "season_props", season=season)
    rows = []
    if run is not None:
        rows = (
            db.query(FantasySeasonPropSnapshot)
            .filter(
                FantasySeasonPropSnapshot.run_id == run.id,
                FantasySeasonPropSnapshot.player_id == player_id,
            )
            .all()
        )
    return {
        "season": season,
        "player": _player_public(player),
        "as_of": iso_utc(run.finished_at) if run else None,
        "source": "Kalshi" if run is not None else None,
        "markets": [
            _season_market_summary(rows, market, label)
            for market, label in SEASON_PROP_MARKETS
        ],
    }


def get_season_prop_leaders(
    db: Session,
    market: Optional[str] = None,
    season: Optional[int] = None,
    limit: int = 60,
) -> Dict[str, Any]:
    """Every quoted player, ranked by the market-implied raw stat value.

    The per-player lookup answers "what is this player's number", which is
    only useful once you already know he has one — and barely a hundred of
    the several thousand players in the catalog do. This answers the question
    that has to come first: who is quoted at all.

    Each value is the 50% crossing of the player's quoted probability curve,
    expressed in the category's native yards or touchdowns.
    """
    if season is None:
        season = default_context(db)["season"]
    run = latest_successful_run(db, "season_props", season=season)
    labels = dict(SEASON_PROP_MARKETS)

    rows_by_market: Dict[str, Dict[str, list]] = {key: {} for key, _ in SEASON_PROP_MARKETS}
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

    market_drop_rate = _season_market_drop_rate(rows_by_market[market], market)
    leaders = []
    players = _player_index(db, list(rows_by_market[market]))
    for player_id, rows in rows_by_market[market].items():
        summary = _season_market_summary(rows, market, labels[market])
        if summary["line"] is None:
            continue
        chance = _implied_probability(summary["over_price"])
        leaders.append({
            "player": _player_public(players.get(player_id)),
            "implied_value": _season_implied_value(rows, market, market_drop_rate),
            "line": summary["line"],
            "over_price": summary["over_price"],
            "under_price": summary["under_price"],
            "over_chance": round(chance, 3) if chance is not None else None,
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

    return {
        "season": season,
        "as_of": iso_utc(run.finished_at) if run else None,
        "source": "Kalshi" if run is not None else None,
        "market": market,
        "label": labels[market],
        "markets": markets,
        "leaders": leaders[:limit],
    }


def get_season_offense_leaders(
    db: Session,
    season: Optional[int] = None,
    limit: int = 10,
) -> Dict[str, Any]:
    """Rank team offenses from non-overlapping Kalshi player markets.

    Passing and receiving describe much of the same yardage/touchdowns, so
    they must never be added together. A team's primary air component is its
    highest quoted passing line; summed receiving lines are only a fallback
    when no passer is quoted. Rushing lines are additive across players and
    form the ground component.

    These are market-derived offense indicators, not official team totals:
    Kalshi only lists selected players and the values are contract thresholds.
    The response exposes the components so the UI can say exactly what each
    number contains instead of presenting it as a projection model.
    """
    if season is None:
        season = default_context(db)["season"]
    run = latest_successful_run(db, "season_props", season=season)
    if run is None:
        return {
            "season": season,
            "as_of": None,
            "source": None,
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
        summary = _season_market_summary(rows, market, labels[market])
        if summary["line"] is None:
            continue
        by_team.setdefault(team, {}).setdefault(market, []).append({
            "player_id": player_id,
            "name": player.full_name,
            "line": summary["line"],
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
            primary_passer = max(passers, key=lambda row: row["line"]) if passers else None
            if primary_passer:
                air_total = primary_passer["line"]
                air_source = "passing"
                air_players = 1
            elif receivers:
                air_total = sum(row["line"] for row in receivers)
                air_source = "receiving"
                air_players = len(receivers)
            else:
                air_total = None
                air_source = None
                air_players = 0
            ground_total = sum(row["line"] for row in rushers) if rushers else None

            # A partial offense would unfairly outrank or underrank teams on
            # coverage alone. Only compare teams with both air and ground
            # components; the response can legitimately contain fewer than
            # ten until Kalshi quotes enough players.
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

    return {
        "season": season,
        "as_of": iso_utc(run.finished_at),
        "source": "Kalshi",
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
