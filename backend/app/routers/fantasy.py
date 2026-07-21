"""Fantasy football API.

Read endpoints are plain DB reads served identically in demo and
authenticated modes (the underlying data is free/public). The admin refresh
endpoint triggers collection and therefore requires real authentication —
demo callers are rejected even though /api/fantasy is a demo-mode prefix.
"""
import asyncio
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import SessionLocal, get_db
from app.services import fantasy_ai, fantasy_collector, fantasy_data, fantasy_news

router = APIRouter(prefix="/api/fantasy", tags=["fantasy"])

# Opaque conversation id issued as an HttpOnly cookie (mirrors bitcoin chat).
FANTASY_SESSION_COOKIE = "pg_fantasy_session"
FANTASY_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60


def is_demo_request(request: Request) -> bool:
    return bool(getattr(request.state, "demo_mode", False))


def is_authenticated(request: Request) -> bool:
    return bool(getattr(request.state, "app_auth_authenticated", False))


async def run_blocking(func, *args, **kwargs):
    return await asyncio.to_thread(func, *args, **kwargs)


class RefreshResponse(BaseModel):
    job: str
    status: str
    rows_written: int
    detail: Optional[str] = None


class FantasyChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=1000)
    session_id: Optional[str] = None
    timezone: Optional[str] = None


class FantasyChatResponse(BaseModel):
    answer: str
    tools_used: List[str]
    data: Dict[str, Any]
    warnings: List[str] = []


@router.get("/state")
def state(db: Session = Depends(get_db)) -> Dict[str, Any]:
    return fantasy_data.get_state(db)


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db)) -> Dict[str, Any]:
    return fantasy_data.get_dashboard(db)


@router.get("/rankings")
def rankings(
    season: Optional[int] = None,
    week: Optional[int] = None,
    position: str = Query("ALL"),
    scoring: str = Query("ppr"),
    source: Optional[str] = None,
    limit: int = Query(100, ge=1, le=400),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return fantasy_data.get_rankings(
        db, season=season, week=week, position=position, scoring=scoring, source=source, limit=limit
    )


@router.get("/projections")
def projections(
    season: Optional[int] = None,
    week: Optional[int] = None,
    position: Optional[str] = None,
    scoring: str = Query("ppr"),
    source: Optional[str] = None,
    limit: int = Query(200, ge=1, le=400),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return fantasy_data.get_projections(
        db, season=season, week=week, position=position, scoring=scoring, source=source, limit=limit
    )


@router.get("/projection-sources")
def projection_sources(
    season: Optional[int] = None,
    week: Optional[int] = None,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return fantasy_data.get_projection_sources(db, season=season, week=week)


@router.get("/players/search")
def players_search(
    q: str = Query(..., min_length=2, max_length=60),
    limit: int = Query(10, ge=1, le=25),
    db: Session = Depends(get_db),
) -> Dict[str, List[Dict[str, Any]]]:
    return {"results": fantasy_data.search_players(db, q, limit)}


@router.get("/compare")
def compare(
    ids: str = Query(..., description="Comma-separated player_ids (2-4)."),
    source: Optional[str] = None,
    scoring: str = Query("ppr"),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    player_ids = [pid.strip() for pid in ids.split(",") if pid.strip()][:4]
    if len(player_ids) < 2:
        raise HTTPException(status_code=400, detail="Provide 2-4 player ids to compare")
    return fantasy_data.compare_players(db, player_ids, source=source, scoring=scoring)


@router.get("/players/{player_id}")
def player_detail(
    player_id: str,
    source: Optional[str] = None,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    detail = fantasy_data.get_player_detail(db, player_id, source=source)
    if detail is None:
        raise HTTPException(status_code=404, detail="Unknown player")
    return detail


@router.get("/players/{player_id}/news")
async def player_news(player_id: str, db: Session = Depends(get_db)) -> Dict[str, Any]:
    # May do one lazy ESPN fetch (then cached), so keep it off the event loop.
    news = await run_blocking(fantasy_news.get_player_news, db, player_id)
    if news is None:
        raise HTTPException(status_code=404, detail="Unknown player")
    return news


@router.get("/trending")
def trending(
    kind: str = Query("add", pattern="^(add|drop)$"),
    limit: int = Query(10, ge=1, le=25),
    db: Session = Depends(get_db),
) -> Dict[str, List[Dict[str, Any]]]:
    return {"kind": kind, "results": fantasy_data.get_trending(db, kind, limit)}


@router.get("/games")
def games(
    season: Optional[int] = None,
    week: Optional[int] = None,
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return fantasy_data.get_games(db, season=season, week=week)


@router.get("/games/{game_id}/lines/history")
def game_lines_history(
    game_id: str,
    market: str = Query("spreads", pattern="^(spreads|totals|h2h)$"),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return fantasy_data.get_game_lines_history(db, game_id, market)


@router.get("/props")
def props(week: Optional[int] = None, db: Session = Depends(get_db)) -> Dict[str, Any]:
    return fantasy_data.get_props(db, week=week)


@router.get("/props/history")
def props_history(
    player_id: str = Query(...),
    market: str = Query(...),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return fantasy_data.get_prop_history(db, player_id, market)


@router.get("/futures")
def futures(
    market: Optional[str] = None,
    limit: int = Query(20, ge=1, le=50),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return fantasy_data.get_futures(db, market=market, limit=limit)


@router.post("/chat", response_model=FantasyChatResponse)
async def fantasy_chat(http_request: Request, request: FantasyChatRequest):
    # Prefer the cookie over the body so a stolen body token can't be replayed.
    session_id = http_request.cookies.get(FANTASY_SESSION_COOKIE) or request.session_id

    if is_demo_request(http_request):
        result = await run_blocking(fantasy_ai.answer_demo_chat, request.message, session_id, request.timezone)
    else:
        result = await run_blocking(fantasy_ai.answer_chat, request.message, session_id, request.timezone)

    cookie_session_id = result["session_id"]
    body = {key: value for key, value in result.items() if key != "session_id"}
    response = JSONResponse(content=body)
    response.set_cookie(
        FANTASY_SESSION_COOKIE,
        cookie_session_id,
        max_age=FANTASY_SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=http_request.url.scheme == "https",
        path="/api/fantasy",
    )
    return response


@router.post("/admin/refresh", response_model=RefreshResponse)
async def admin_refresh(http_request: Request, job: str = Query(...)):
    # This endpoint performs writes/network fetches; it must never run for an
    # anonymous demo caller even though /api/fantasy is a demo prefix.
    if is_demo_request(http_request) or not is_authenticated(http_request):
        raise HTTPException(status_code=403, detail="Admin authentication required")
    if job not in fantasy_collector.REFRESHABLE_JOBS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown job '{job}'. Valid: {', '.join(fantasy_collector.REFRESHABLE_JOBS)}",
        )

    def _run() -> RefreshResponse:
        db = SessionLocal()
        try:
            run = fantasy_collector.run_job(db, job)
            return RefreshResponse(
                job=run.job,
                status=run.status,
                rows_written=run.rows_written or 0,
                detail=run.detail,
            )
        finally:
            db.close()

    try:
        return await run_blocking(_run)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
