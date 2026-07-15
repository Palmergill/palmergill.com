"""Read queries for the fantasy dashboard/API.

These are plain synchronous SQLAlchemy reads over the collected data — the
same in demo and authenticated modes. "Latest" for a snapshot table resolves
through the newest successful FantasyCollectionRun (see fantasy_collector).
"""
import json
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
    FantasyTrendingSnapshot,
)
from app.services.fantasy_collector import (
    SEASON_LONG_WEEK,
    current_season_week,
    is_in_season,
    latest_successful_run,
)
from app.services.fantasy_common import (
    SCORING_POINTS_FIELD,
    display_position,
    normalize_position,
    normalize_scoring,
)

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
                "last_success": run.finished_at.isoformat() if run and run.finished_at else None,
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
    limit: int = 100,
) -> Dict[str, Any]:
    if season is None or week is None:
        default = default_context(db)
        season = season if season is not None else default["season"]
        week = week if week is not None else default["week"]

    scoring = normalize_scoring(scoring)
    position = (position or "ALL").upper()
    query_position = "DEF" if position in ("DST", "DEF") else position

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
        "as_of": run.finished_at.isoformat() if run.finished_at else None,
        "rankings": rankings,
    }


def get_projections(
    db: Session,
    season: Optional[int] = None,
    week: Optional[int] = None,
    position: Optional[str] = None,
    scoring: str = "ppr",
    limit: int = 200,
) -> Dict[str, Any]:
    if season is None or week is None:
        default = default_context(db)
        season = season if season is not None else default["season"]
        week = week if week is not None else default["week"]

    scoring = normalize_scoring(scoring)
    points_field = SCORING_POINTS_FIELD[scoring]

    run = latest_successful_run(db, "projections", season, week)
    if run is None:
        return {"season": season, "week": week, "scoring": scoring, "projections": []}

    rows = db.query(FantasyProjection).filter(FantasyProjection.run_id == run.id).all()
    query_position = normalize_position(position) if position else None
    players = _player_index(db, [r.player_id for r in rows])

    projections = []
    for r in rows:
        player = players.get(r.player_id)
        if query_position and (player is None or player.position != query_position):
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
        "as_of": run.finished_at.isoformat() if run.finished_at else None,
        "projections": projections[:limit],
    }


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


def get_player_detail(db: Session, player_id: str) -> Optional[Dict[str, Any]]:
    player = db.get(FantasyPlayer, player_id)
    if player is None:
        return None

    detail = _player_public(player)
    detail.update({"age": player.age, "years_exp": player.years_exp, "status": player.status})

    ctx = default_context(db)
    season, week = ctx["season"], ctx["week"]

    # Latest projection for the default week.
    proj_run = latest_successful_run(db, "projections", season, week)
    if proj_run is not None:
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
                "pts_ppr": proj.pts_ppr,
                "pts_half_ppr": proj.pts_half_ppr,
                "pts_std": proj.pts_std,
                "as_of": proj.fetched_at.isoformat() if proj.fetched_at else None,
            }

    # Intra/inter-week projection movement: every snapshot this season.
    history = (
        db.query(FantasyProjection)
        .filter(
            FantasyProjection.player_id == player_id,
            FantasyProjection.season == season,
        )
        .order_by(FantasyProjection.fetched_at.asc())
        .all()
    )
    detail["projection_history"] = [
        {
            "week": h.week,
            "pts_ppr": h.pts_ppr,
            "fetched_at": h.fetched_at.isoformat() if h.fetched_at else None,
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

    detail["props"] = _player_props(db, player_id)
    return detail


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
            "kickoff": game.kickoff.isoformat() if game.kickoff else None,
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
        "as_of": latest.finished_at.isoformat() if latest and latest.finished_at else None,
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


def get_game_lines_history(db, game_id: str, market: str = "spreads") -> Dict[str, Any]:
    rows = (
        db.query(FantasyOddsSnapshot)
        .filter(FantasyOddsSnapshot.game_id == game_id, FantasyOddsSnapshot.market == market)
        .order_by(FantasyOddsSnapshot.fetched_at.asc())
        .all()
    )
    game = db.get(FantasyGame, game_id)
    outcome = game.home_team if (game and market == "spreads") else "Over"
    by_run: Dict[int, list] = {}
    for row in rows:
        by_run.setdefault(row.run_id, []).append(row)
    series = []
    for run_id, run_rows in by_run.items():
        point = _consensus_point(run_rows, market, outcome)
        if point is None:
            continue
        series.append({"fetched_at": run_rows[0].fetched_at.isoformat() if run_rows[0].fetched_at else None, "point": point})
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
    return {"as_of": run.finished_at.isoformat() if run.finished_at else None, "featured": featured}


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
                "fetched_at": run_rows[0].fetched_at.isoformat() if run_rows[0].fetched_at else None,
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
        "as_of": run.finished_at.isoformat() if run.finished_at else None,
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
