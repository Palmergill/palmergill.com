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

from app.database import get_db
from app.services import (
    fantasy_ai,
    fantasy_league_data,
    fantasy_league_draft,
    fantasy_league_week,
)
from app.services.fantasy_league_data import UnknownSeasonError, UnknownTeamError
from app.services.fantasy_league_draft import DraftUnavailable
from app.services.fantasy_league_rankings import ALGORITHMS

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
    scoring: str = Query(
        fantasy_league_data.LEAGUE_SCORING,
        pattern="^(ppr|half|half_ppr|half-ppr|std|standard)$",
    ),
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


@router.get("/power-history")
def power_history(
    season: Optional[int] = None,
    metric: str = Query(
        fantasy_league_data.RESUME_METRIC, pattern="^(resume|roster)$"
    ),
    algorithm: str = Query("composite", pattern="^[a-z_]+$"),
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """One line per team, week by week, for the season-long power chart.

    Two series behind one route because they answer the same question about
    different things: ``resume`` ranks what a team has earned, ``roster``
    ranks what it holds. Only the first can be read back for a season that
    finished before the second started being recorded.
    """
    if algorithm not in ALGORITHMS:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown algorithm '{algorithm}'. Valid: {', '.join(ALGORITHMS)}",
        )
    try:
        return fantasy_league_data.get_power_history(
            db, season=season, metric=metric, algorithm=algorithm
        )
    except UnknownSeasonError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/ledger")
def ledger(
    season: Optional[int] = None,
    algorithm: str = Query("composite", pattern="^[a-z_]+$"),
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Every team once, with every derived column joined on."""
    if algorithm not in ALGORITHMS:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown algorithm '{algorithm}'. Valid: {', '.join(ALGORITHMS)}",
        )
    try:
        return fantasy_league_data.get_league_ledger(
            db, season=season, algorithm=algorithm
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


@router.get("/roster-power")
def roster_power(
    season: Optional[int] = None,
    scoring: str = Query(
        fantasy_league_data.LEAGUE_SCORING,
        pattern="^(ppr|half|half_ppr|half-ppr|std|standard)$",
    ),
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Teams ranked by the expected points of the rosters they hold."""
    try:
        return fantasy_league_data.get_roster_power(db, season=season, scoring=scoring)
    except UnknownSeasonError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/free-agents")
def free_agents(
    season: Optional[int] = None,
    scoring: str = Query(
        fantasy_league_data.LEAGUE_SCORING,
        pattern="^(ppr|half|half_ppr|half-ppr|std|standard)$",
    ),
    limit: int = Query(40, ge=1, le=150),
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Ranked players no team in this league has rostered."""
    try:
        return fantasy_league_data.get_free_agents(
            db, season=season, scoring=scoring, limit=limit
        )
    except UnknownSeasonError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/teams/{team_id}/lineup")
def team_lineup(
    team_id: int,
    season: Optional[int] = None,
    scoring: str = Query(
        fantasy_league_data.LEAGUE_SCORING,
        pattern="^(ppr|half|half_ppr|half-ppr|std|standard)$",
    ),
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


@router.get("/teams/{team_id}/rooms")
def team_rooms(
    team_id: int,
    season: Optional[int] = None,
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """This roster by position, each room against the league at that spot."""
    try:
        return fantasy_league_data.get_team_rooms(db, season, team_id)
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
    """Read the newest stored overview. Never generates.

    Overviews are written by the scheduler every Tuesday morning — a recap of
    the week just played and a look ahead — and nowhere else. A miss returns
    status "missing".
    """
    resolved = _resolved_season(db, season, team_id)
    return fantasy_ai.read_team_overview(db, resolved, team_id, week)


# ── weekly recap ────────────────────────────────────────────────────────


@router.get("/week")
def week_recap(
    season: Optional[int] = None,
    week: Optional[int] = None,
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Results, grades, accolades and callouts for one week.

    One read rather than four, for the same reason the draft recap is one: the
    grades, the awards and the callouts are all derived from the same enriched
    result set, and splitting them would recompute the week per section.
    """
    try:
        return fantasy_league_week.get_week_recap(db, season=season, week=week)
    except UnknownSeasonError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/week/notes/{team_id}")
def week_note(
    team_id: int,
    season: Optional[int] = None,
    week: Optional[int] = None,
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Read a stored weekly recap. Only the Tuesday scheduler writes them."""
    try:
        return fantasy_ai.read_week_note(db, season, week, team_id)
    except UnknownSeasonError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except fantasy_ai.UnknownWeekTeamError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# ── draft recap ─────────────────────────────────────────────────────────


@router.get("/draft")
def draft_recap(
    season: Optional[int] = None,
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Picks, grades, accolades, and the ADP board they were graded against.

    One read rather than three: the grades and the accolades are both derived
    from the same enriched pick list, and splitting them across endpoints
    would recompute the whole recap twice for one page load.
    """
    try:
        return fantasy_league_draft.get_draft_recap(db, season)
    except DraftUnavailable as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/draft/notes/{team_id}")
def draft_note(
    team_id: int,
    season: Optional[int] = None,
    _: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    """Read a stored draft recap. Only the Tuesday scheduler writes them."""
    resolved = _resolved_draft_season(db, season)
    try:
        return fantasy_ai.read_draft_note(db, resolved, team_id)
    except fantasy_ai.UnknownDraftTeamError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


def _resolved_draft_season(db: Session, season: Optional[int]) -> int:
    if season is not None:
        return season
    from app.services import fantasy_league_collector

    resolved = fantasy_league_collector.current_league_season(db)
    if not resolved:
        raise HTTPException(status_code=404, detail="No league season is configured.")
    return resolved
