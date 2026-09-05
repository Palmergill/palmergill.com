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
from pydantic import BaseModel

from app.database import SessionLocal, get_db
from app.services import fantasy_ai, fantasy_league_data
from app.services.fantasy_league_data import UnknownSeasonError, UnknownTeamError
from app.services.fantasy_league_rankings import ALGORITHMS
from app.routers.fantasy import run_blocking

router = APIRouter(prefix="/api/fantasy/league", tags=["fantasy-league"])


class LeagueTeamSelectionRequest(BaseModel):
    season: int
    espn_team_id: int


def require_member(request: Request) -> Dict[str, Any]:
    """Any signed-in account may read the league; anonymous callers may not."""
    if getattr(request.state, "demo_mode", False):
        raise HTTPException(status_code=403, detail="Sign in to view the league hub.")
    identity = getattr(request.state, "app_user", None)
    if not identity:
        raise HTTPException(status_code=403, detail="Sign in to view the league hub.")
    return identity


def _member_username(identity: Dict[str, Any]) -> str:
    username = identity.get("username") or identity.get("name")
    if not username:
        raise HTTPException(status_code=403, detail="Signed-in account has no username.")
    return str(username)


@router.get("/me")
def member_snapshot(
    season: Optional[int] = None,
    week: Optional[int] = None,
    scoring: str = Query("std", pattern="^(ppr|half|half_ppr|half-ppr|std|standard)$"),
    identity: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        return fantasy_league_data.get_member_snapshot(
            db,
            _member_username(identity),
            season=season,
            week=week,
            scoring=scoring,
        )
    except UnknownSeasonError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.put("/me")
def select_member_team(
    payload: LeagueTeamSelectionRequest,
    identity: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    try:
        return fantasy_league_data.select_member_team(
            db,
            _member_username(identity),
            payload.season,
            payload.espn_team_id,
        )
    except UnknownSeasonError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except UnknownTeamError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


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


@router.get("/teams/{team_id}/lineup")
def team_lineup(
    team_id: int,
    season: Optional[int] = None,
    scoring: str = Query("std", pattern="^(ppr|half|half_ppr|half-ppr|std|standard)$"),
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """The started lineup against the best one this roster could field."""
    try:
        return fantasy_league_data.get_team_lineup(db, season, team_id, scoring=scoring)
    except UnknownSeasonError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except UnknownTeamError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


def _resolved_season(db: Session, season: Optional[int], team_id: int) -> int:
    try:
        return fantasy_league_data.get_team_detail(db, season, team_id)["season"]
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
    """Read a stored overview. Never generates.

    Writing here would put a paid model call and a database write behind an
    ordinary page load — every first visit to a team page would bill. A miss
    returns status "missing" and the client offers to generate.
    """
    resolved = _resolved_season(db, season, team_id)
    return fantasy_ai.read_team_overview(db, resolved, team_id, week)


@router.post("/teams/{team_id}/overview", status_code=201)
async def regenerate_team_overview(
    team_id: int,
    season: Optional[int] = None,
    week: Optional[int] = None,
    force: bool = False,
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Generate an overview (or reuse an unchanged one).

    The model call is blocking, so it runs off the event loop like the other
    model-backed endpoints.
    """
    resolved = _resolved_season(db, season, team_id)

    def _generate() -> Dict[str, Any]:
        # Own session: the request-scoped one belongs to the event loop, and
        # SQLAlchemy sessions are not safe to hand to another thread. Mirrors
        # how admin_refresh runs its collector work.
        worker = SessionLocal()
        try:
            return fantasy_ai.generate_team_overview(
                worker, resolved, team_id, week, force=force
            )
        finally:
            worker.close()

    return await run_blocking(_generate)
