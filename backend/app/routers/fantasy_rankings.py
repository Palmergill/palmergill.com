"""Personal ranking boards API (spec 18).

Reading a published board or the site consensus is public — a share link has to
work for someone who is not signed in, or it is not a share link. Everything
under /boards belongs to one account and is gated here in the router rather
than by path prefix, for the reason spelled out in fantasy_league.py: a
transport-level rejection on a demo prefix is a 401 carrying
``WWW-Authenticate: Basic``, which some browsers turn into a native credential
modal on a ``fetch()``. A JSON 403 lets the page render its own sign-in panel.
"""
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.services import fantasy_rankings_board as boards

router = APIRouter(prefix="/api/fantasy/rankings", tags=["fantasy-rankings"])

SCORING_PATTERN = "^(ppr|half|std)$"
ROSTER_PATTERN = "^(1qb|superflex)$"
SCOPE_PATTERN = "^(OVERALL|QB|RB|WR|TE)$"


def require_member(request: Request) -> Dict[str, Any]:
    """Any signed-in account may keep boards; anonymous callers may not."""
    if getattr(request.state, "demo_mode", False):
        raise HTTPException(status_code=403, detail="Sign in to build your own rankings.")
    identity = getattr(request.state, "app_user", None)
    if not identity:
        raise HTTPException(status_code=403, detail="Sign in to build your own rankings.")
    return identity


class CreateBoardRequest(BaseModel):
    season: Optional[int] = Field(None, ge=2000, le=2100)
    scoring: str = Field("ppr", pattern=SCORING_PATTERN)
    roster: str = Field("1qb", pattern=ROSTER_PATTERN)
    title: Optional[str] = Field(None, max_length=80)


class UpdateBoardRequest(BaseModel):
    revision: int
    title: Optional[str] = Field(None, max_length=80)
    published: Optional[bool] = None


class RevisionRequest(BaseModel):
    revision: int


class AddEntryRequest(BaseModel):
    player_id: str = Field(..., min_length=1, max_length=32)
    revision: int
    scope: str = Field("OVERALL", pattern=SCOPE_PATTERN)
    before_player_id: Optional[str] = Field(None, max_length=32)
    to_rank: Optional[int] = Field(None, ge=1, le=5000)


class MoveEntryRequest(BaseModel):
    revision: int
    scope: str = Field("OVERALL", pattern=SCOPE_PATTERN)
    before_player_id: Optional[str] = Field(None, max_length=32)
    after_player_id: Optional[str] = Field(None, max_length=32)
    to_rank: Optional[int] = Field(None, ge=1, le=5000)
    before_tier_id: Optional[int] = Field(None, ge=1)
    after_tier_id: Optional[int] = Field(None, ge=1)


class CreateTierRequest(BaseModel):
    revision: int
    scope: str = Field("OVERALL", pattern=SCOPE_PATTERN)
    label: str = Field(..., min_length=1, max_length=60)
    before_player_id: Optional[str] = Field(None, max_length=32)
    after_player_id: Optional[str] = Field(None, max_length=32)
    to_rank: Optional[int] = Field(None, ge=1, le=5000)


class UpdateTierRequest(BaseModel):
    revision: int
    label: Optional[str] = Field(None, max_length=60)
    before_player_id: Optional[str] = Field(None, max_length=32)
    after_player_id: Optional[str] = Field(None, max_length=32)
    to_rank: Optional[int] = Field(None, ge=1, le=5000)


def _board_for(identity: Dict[str, Any], db: Session, board_id: int):
    username, _display = boards.identity_names(identity)
    return boards.owned_board(db, board_id, username)


def _require_one_placement(*values) -> None:
    if sum(value is not None for value in values) > 1:
        raise HTTPException(status_code=422, detail="Choose one destination for this move.")


@router.get("/shared/{share_slug}")
def read_shared_board(
    share_slug: str = Path(..., min_length=6, max_length=64),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return boards.serialize_published_board(db, boards.published_board(db, share_slug))


@router.get("/consensus")
def read_consensus(
    season: Optional[int] = Query(None, ge=2000, le=2100),
    scoring: str = Query("ppr", pattern=SCORING_PATTERN),
    roster: str = Query("1qb", pattern=ROSTER_PATTERN),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return boards.site_consensus(db, season, scoring, roster)


# Declared before /boards/{board_id}: Starlette matches in order, and "mine"
# would otherwise be read as a board id.
@router.get("/boards/mine")
def my_boards(
    identity: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    username, _display = boards.identity_names(identity)
    return {"boards": boards.summarize_boards(db, username)}


# Board-specific player search. Declared before /boards/{board_id} for the same
# ordering reason, and separate from /api/fantasy/players/search because a draft
# board searches its own scoring and season and only over rankable positions.
@router.get("/players/search")
def search_players(
    q: str = Query(..., min_length=2, max_length=60),
    season: Optional[int] = Query(None, ge=2000, le=2100),
    scoring: str = Query("ppr", pattern=SCORING_PATTERN),
    limit: int = Query(12, ge=1, le=25),
    _identity: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return {
        "results": boards.search_rankable_players(
            db, q, season, scoring=scoring, limit=limit
        )
    }


@router.post("/boards", status_code=201)
def create_board(
    payload: CreateBoardRequest,
    identity: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    board = boards.create_board(
        db, identity, payload.season, payload.scoring, payload.roster, payload.title
    )
    return boards.serialize_board(db, board)


@router.get("/boards/{board_id}")
def read_board(
    board_id: int,
    identity: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return boards.serialize_board(db, _board_for(identity, db, board_id))


@router.patch("/boards/{board_id}")
def patch_board(
    board_id: int,
    payload: UpdateBoardRequest,
    identity: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    board = _board_for(identity, db, board_id)
    boards.check_revision(db, board, payload.revision)
    board = boards.update_board(db, board, payload.title, payload.published)
    return boards.serialize_board(db, board)


@router.post("/boards/{board_id}/reset")
def reset_board(
    board_id: int,
    payload: RevisionRequest,
    identity: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    board = _board_for(identity, db, board_id)
    boards.check_revision(db, board, payload.revision)
    return boards.serialize_board(db, boards.reset_board(db, board))


@router.delete("/boards/{board_id}", status_code=204)
def delete_board(
    board_id: int,
    identity: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Response:
    boards.delete_board(db, _board_for(identity, db, board_id))
    return Response(status_code=204)


@router.post("/boards/{board_id}/entries", status_code=201)
def add_entry(
    board_id: int,
    payload: AddEntryRequest,
    identity: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    board = _board_for(identity, db, board_id)
    boards.check_revision(db, board, payload.revision)
    _require_one_placement(payload.before_player_id, payload.to_rank)
    return boards.add_entry(
        db,
        board,
        payload.player_id,
        boards.normalize_scope(payload.scope),
        before_player_id=payload.before_player_id,
        to_rank=payload.to_rank,
    )


@router.patch("/boards/{board_id}/entries/{player_id}")
def move_entry(
    board_id: int,
    player_id: str,
    payload: MoveEntryRequest,
    identity: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    board = _board_for(identity, db, board_id)
    boards.check_revision(db, board, payload.revision)
    _require_one_placement(
        payload.before_player_id,
        payload.after_player_id,
        payload.to_rank,
        payload.before_tier_id,
        payload.after_tier_id,
    )
    return boards.move_entry(
        db,
        board,
        player_id,
        boards.normalize_scope(payload.scope),
        before_player_id=payload.before_player_id,
        after_player_id=payload.after_player_id,
        to_rank=payload.to_rank,
        before_tier_id=payload.before_tier_id,
        after_tier_id=payload.after_tier_id,
    )


@router.delete("/boards/{board_id}/entries/{player_id}")
def remove_entry(
    board_id: int,
    player_id: str,
    revision: int = Query(...),
    identity: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    board = _board_for(identity, db, board_id)
    boards.check_revision(db, board, revision)
    return boards.remove_entry(db, board, player_id)


@router.post("/boards/{board_id}/tiers", status_code=201)
def add_tier(
    board_id: int,
    payload: CreateTierRequest,
    identity: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    board = _board_for(identity, db, board_id)
    boards.check_revision(db, board, payload.revision)
    _require_one_placement(
        payload.before_player_id, payload.after_player_id, payload.to_rank
    )
    return boards.create_tier(
        db,
        board,
        boards.normalize_scope(payload.scope),
        payload.label,
        before_player_id=payload.before_player_id,
        after_player_id=payload.after_player_id,
        to_rank=payload.to_rank,
    )


@router.patch("/boards/{board_id}/tiers/{tier_id}")
def patch_tier(
    board_id: int,
    tier_id: int,
    payload: UpdateTierRequest,
    identity: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    board = _board_for(identity, db, board_id)
    boards.check_revision(db, board, payload.revision)
    _require_one_placement(
        payload.before_player_id, payload.after_player_id, payload.to_rank
    )
    return boards.update_tier(
        db,
        board,
        tier_id,
        label=payload.label,
        before_player_id=payload.before_player_id,
        after_player_id=payload.after_player_id,
        to_rank=payload.to_rank,
        move_requested=any(
            value is not None
            for value in (payload.before_player_id, payload.after_player_id, payload.to_rank)
        ),
    )


@router.delete("/boards/{board_id}/tiers/{tier_id}")
def remove_tier(
    board_id: int,
    tier_id: int,
    revision: int = Query(...),
    identity: Dict[str, Any] = Depends(require_member),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    board = _board_for(identity, db, board_id)
    boards.check_revision(db, board, revision)
    return boards.delete_tier(db, board, tier_id)
