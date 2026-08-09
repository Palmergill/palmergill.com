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
from app.services import fantasy_league_data as league_data


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


def _chat_season(db: Session, season: Optional[int]) -> Optional[int]:
    """Season a league chat answer should use when the caller named none.

    Prefers the newest season that has been played. The hub's own default is
    the current season even in the preseason (drafted rosters are interesting);
    for chat that would mean answering "no rankings collected yet" while last
    season's are sitting right there.
    """
    if season is not None:
        return season
    return league_data.resolve_played_season(db)


def get_league_standings(
    db: Session, season: Optional[int] = None, limit: int = 12
) -> Dict[str, Any]:
    """Compact private-league standings for an authenticated chat turn."""
    limit = max(1, min(int(limit or 12), 12))
    data = league_data.get_standings(db, season=_chat_season(db, season))
    return {
        "season": data["season"],
        "teams": [
            {
                "team_id": team["espn_team_id"],
                "name": team["name"],
                "owner": team["owner_name"],
                "record": f'{team["wins"]}-{team["losses"]}-{team["ties"]}',
                "points_for": round(team["points_for"], 1),
                "playoff_seed": team["playoff_seed"],
            }
            for team in data["teams"][:limit]
        ],
    }


def get_league_scoreboard(
    db: Session,
    season: Optional[int] = None,
    week: Optional[int] = None,
    limit: int = 8,
) -> Dict[str, Any]:
    """One private-league week, capped before it enters model context."""
    limit = max(1, min(int(limit or 8), 8))
    data = league_data.get_scoreboard(db, season=_chat_season(db, season), week=week)
    return {
        "season": data["season"],
        "week": data["week"],
        "matchups": [
            {
                "home": matchup["home"]["name"],
                "home_points": matchup["home"]["points"],
                "away": matchup["away"]["name"] if matchup["away"] else None,
                "away_points": matchup["away"]["points"] if matchup["away"] else None,
                "winner": matchup["winner"],
                "complete": matchup["is_complete"],
                "bye": matchup["is_bye"],
            }
            for matchup in data["matchups"][:limit]
        ],
    }


def get_league_power_rankings(
    db: Session,
    season: Optional[int] = None,
    week: Optional[int] = None,
    algorithm: str = "composite",
    limit: int = 12,
) -> Dict[str, Any]:
    limit = max(1, min(int(limit or 12), 12))
    data = league_data.get_power_rankings(
        db, season=_chat_season(db, season), week=week, algorithm=algorithm
    )
    return {
        "season": data["season"],
        "week": data["week"],
        "algorithm": data["algorithm"],
        "teams": [
            {
                "rank": team["rank"],
                "name": team["name"],
                "record": f'{team["wins"]}-{team["losses"]}-{team["ties"]}',
                "score": round(team["score"], 4) if team["score"] is not None else None,
                "movement": team["rank_delta"],
            }
            for team in data["rankings"][:limit]
        ],
    }


def get_league_team(
    db: Session,
    team_id: int,
    season: Optional[int] = None,
) -> Dict[str, Any]:
    """Team record, recent results and a compact roster preview."""
    detail = league_data.get_team_detail(db, _chat_season(db, season), int(team_id))
    roster = league_data.get_team_roster(db, detail["season"], int(team_id))
    return {
        "season": detail["season"],
        "team_id": detail["espn_team_id"],
        "name": detail["name"],
        "owner": detail["owner_name"],
        "record": f'{detail["wins"]}-{detail["losses"]}-{detail["ties"]}',
        "points_for": round(detail["points_for"], 1),
        "power_history": detail["power_history"][-4:],
        "recent_results": detail["results"][-3:],
        "roster": [
            {
                "name": entry["name"],
                "slot": entry["lineup_slot"],
                "projection_ppr": (entry.get("projection") or {}).get("pts_ppr"),
                "rank": (entry.get("ranking") or {}).get("rank"),
            }
            for entry in roster["entries"][:12]
        ],
    }
