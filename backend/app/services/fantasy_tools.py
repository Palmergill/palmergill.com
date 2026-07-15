"""Chat tool handlers for the fantasy assistant.

Every handler is a pure read over the local collected data (a SQLAlchemy
Session is passed in) — the chat model can never trigger an external fetch,
so a conversation can't spend Odds API credits. Each handler is row-capped to
keep tool results compact (~≤2KB JSON) and attaches an ``as_of`` where
relevant so the model can attribute figures.
"""
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.database import FantasyPlayer, FantasyPlayerStat
from app.services import fantasy_data as fd
from app.services.fantasy_collector import latest_successful_run
from app.services.fantasy_common import display_position


def get_nfl_state(db: Session) -> Dict[str, Any]:
    state = fd.get_state(db)
    return {
        "season": state["season"],
        "week": state["week"],
        "season_type": state["season_type"],
        "in_season": state["in_season"],
        "showing_season": state["default_season"],
        "showing_week": state["default_week"],
    }


def search_players(db: Session, query: str, limit: int = 8) -> Dict[str, Any]:
    limit = max(1, min(int(limit or 8), 10))
    return {"players": fd.search_players(db, query, limit)}


def get_rankings(
    db: Session,
    position: str = "ALL",
    scoring: str = "ppr",
    week: Optional[int] = None,
    limit: int = 15,
) -> Dict[str, Any]:
    limit = max(1, min(int(limit or 15), 25))
    data = fd.get_rankings(db, week=week, position=position, scoring=scoring, limit=limit)
    return {
        "season": data.get("season"),
        "week": data.get("week"),
        "position": data.get("position"),
        "scoring": data.get("scoring"),
        "source": data.get("source"),
        "as_of": data.get("as_of"),
        "players": [
            {"rank": r["rank"], "name": r["name"], "team": r["team"], "position": r["position"], "proj": r["projected_points"]}
            for r in data.get("rankings", [])
        ],
    }


def _last_games(db: Session, player_id: str, limit: int = 3) -> List[Dict[str, Any]]:
    rows = (
        db.query(FantasyPlayerStat)
        .filter(FantasyPlayerStat.player_id == player_id)
        .order_by(FantasyPlayerStat.season.desc(), FantasyPlayerStat.week.desc())
        .limit(limit)
        .all()
    )
    return [
        {"week": r.week, "opponent": r.opponent, "pts_ppr": r.fantasy_points_ppr}
        for r in rows
    ]


def get_player_card(db: Session, player_id: str) -> Dict[str, Any]:
    detail = fd.get_player_detail(db, player_id)
    if detail is None:
        return {"error": f"No player found with id {player_id}"}
    return {
        "name": detail.get("name"),
        "team": detail.get("team"),
        "position": detail.get("position"),
        "injury_status": detail.get("injury_status"),
        "projection": detail.get("projection"),
        "recent_games": detail.get("recent_games", [])[:3],
        "props": detail.get("props", []),
    }


def compare_players(db: Session, player_ids: List[str]) -> Dict[str, Any]:
    if not player_ids or not isinstance(player_ids, list):
        return {"error": "Provide 2-4 player_ids to compare."}
    ids = [str(pid) for pid in player_ids[:4]]
    ctx = fd.default_context(db)
    proj_run = latest_successful_run(db, "projections", ctx["season"], ctx["week"])
    proj_by_player = {}
    if proj_run is not None:
        from app.database import FantasyProjection

        for row in db.query(FantasyProjection).filter(FantasyProjection.run_id == proj_run.id).all():
            proj_by_player[row.player_id] = row.pts_ppr

    out = []
    for pid in ids:
        player = db.get(FantasyPlayer, pid)
        if player is None:
            continue
        out.append(
            {
                "player_id": pid,
                "name": player.full_name,
                "team": player.team,
                "position": display_position(player.position),
                "proj_ppr": proj_by_player.get(pid),
                "last3_ppr": [g["pts_ppr"] for g in _last_games(db, pid, 3)],
            }
        )
    return {"season": ctx["season"], "week": ctx["week"], "players": out}


def get_player_props(db: Session, player_id: str) -> Dict[str, Any]:
    player = db.get(FantasyPlayer, player_id)
    if player is None:
        return {"error": f"No player found with id {player_id}"}
    return {"player": player.full_name, "props": fd._player_props(db, player_id)[:12]}


def get_game_lines(db: Session, week: Optional[int] = None) -> Dict[str, Any]:
    data = fd.get_games(db, week=week)
    games = []
    for game in data.get("games", []):
        lines = game.get("lines")
        if not lines:
            continue
        games.append(
            {
                "matchup": f"{game['away_team']} @ {game['home_team']}",
                "spread_home": lines.get("spread_home"),
                "total": lines.get("total"),
                "moneyline_home": lines.get("moneyline_home"),
                "moneyline_away": lines.get("moneyline_away"),
                "spread_move": game.get("spread_move"),
            }
        )
    return {"week": data.get("week"), "as_of": data.get("as_of"), "games": games[:16]}


def get_futures(db: Session, market: Optional[str] = None, limit: int = 12) -> Dict[str, Any]:
    limit = max(1, min(int(limit or 12), 20))
    data = fd.get_futures(db, market=market, limit=limit)
    return {
        "market": data.get("market"),
        "as_of": data.get("as_of"),
        "outcomes": data.get("outcomes", []),
    }


def get_trending(db: Session, kind: str = "add", limit: int = 8) -> Dict[str, Any]:
    kind = "drop" if kind == "drop" else "add"
    limit = max(1, min(int(limit or 8), 15))
    return {"kind": kind, "players": fd.get_trending(db, kind, limit)}
