"""ESPN league hub API (spec 17) — members only.

Unlike the rest of /api/fantasy, which serves anonymous demo callers because
its data is free and public, these endpoints expose a private league: real
managers' names, their rosters, and their results. Every route requires a
signed-in account.

The membership check lives here rather than in the transport layer on
purpose. ``/api/fantasy`` is a demo prefix at the edge and in main.py, and a
transport-level rejection would be a 401 carrying ``WWW-Authenticate:
Basic`` — which some browsers surface as a native credential modal on a
``fetch()``. A JSON 403 lets the page render "sign in to view the league"
instead. This mirrors how ``POST /api/fantasy/admin/refresh`` already works.
"""
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.services import fantasy_ai, fantasy_league_data
from app.services.fantasy_league_data import UnknownSeasonError, UnknownTeamError
from app.services.fantasy_league_rankings import ALGORITHMS

router = APIRouter(prefix="/api/fantasy/league", tags=["fantasy-league"])


def require_member(request: Request) -> Dict[str, Any]:
    """Any signed-in account may read the league; anonymous callers may not."""
    if getattr(request.state, "demo_mode", False):
        raise HTTPException(status_code=403, detail="Sign in to view the league hub.")
    identity = getattr(request.state, "app_user", None)
    if not identity:
        raise HTTPException(status_code=403, detail="Sign in to view the league hub.")
    return identity


@router.get("/seasons")
def seasons(
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return fantasy_league_data.list_seasons(db)


@router.get("/overview")
def overview(
    season: Optional[int] = None,
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        return fantasy_league_data.get_league_overview(db, season=season)
    except UnknownSeasonError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/standings")
def standings(
    season: Optional[int] = None,
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        return fantasy_league_data.get_standings(db, season=season)
    except UnknownSeasonError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/power-rankings")
def power_rankings(
    season: Optional[int] = None,
    week: Optional[int] = None,
    algorithm: str = Query("composite", pattern="^[a-z_]+$"),
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    if algorithm not in ALGORITHMS:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown algorithm '{algorithm}'. Valid: {', '.join(ALGORITHMS)}",
        )
    try:
        return fantasy_league_data.get_power_rankings(
            db, season=season, week=week, algorithm=algorithm
        )
    except UnknownSeasonError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/scoreboard")
def scoreboard(
    season: Optional[int] = None,
    week: Optional[int] = None,
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        return fantasy_league_data.get_scoreboard(db, season=season, week=week)
    except UnknownSeasonError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/teams/{team_id}")
def team_detail(
    team_id: int,
    season: Optional[int] = None,
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        return fantasy_league_data.get_team_detail(db, season, team_id)
    except UnknownSeasonError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except UnknownTeamError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/teams/{team_id}/roster")
def team_roster(
    team_id: int,
    season: Optional[int] = None,
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        return fantasy_league_data.get_team_roster(db, season, team_id)
    except UnknownSeasonError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except UnknownTeamError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


def _team_overview(
    db: Session, season: Optional[int], team_id: int, week: Optional[int], force: bool
) -> Dict[str, Any]:
    try:
        detail = fantasy_league_data.get_team_detail(db, season, team_id)
        return fantasy_ai.generate_team_overview(
            db, detail["season"], team_id, week, force=force
        )
    except UnknownSeasonError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except UnknownTeamError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/teams/{team_id}/overview")
def team_overview(
    team_id: int,
    season: Optional[int] = None,
    week: Optional[int] = None,
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return _team_overview(db, season, team_id, week, force=False)


@router.post("/teams/{team_id}/overview")
def regenerate_team_overview(
    team_id: int,
    season: Optional[int] = None,
    week: Optional[int] = None,
    force: bool = False,
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return _team_overview(db, season, team_id, week, force=force)
