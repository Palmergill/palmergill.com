"""Account-backed API for the Fourth & Fortune draft-order game."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app import accounts
from app.services import draft_order_game

router = APIRouter(prefix="/api/fantasy/draft", tags=["fantasy-draft-order"])


class CreateRoomRequest(BaseModel):
    league_name: str = Field(..., min_length=3, max_length=60)


class JoinRoomRequest(BaseModel):
    join_code: str = Field(..., min_length=6, max_length=12)


class CreateBotRoomRequest(BaseModel):
    league_name: str = Field(..., min_length=3, max_length=60)
    bot_count: int = Field(5, ge=1, le=len(draft_order_game.BOT_NAMES))


def _identity(request: Request) -> dict[str, str]:
    identity = getattr(request.state, "app_user", None)
    if not identity:
        raise HTTPException(status_code=401, detail="Sign in or create an account to play.")
    return identity


@router.get("/sessions/mine")
def my_sessions(request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    identity = _identity(request)
    return {"sessions": draft_order_game.list_sessions_for_user(db, identity)}


@router.get("/sessions/all")
def all_sessions(request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    identity = _identity(request)
    return {"sessions": draft_order_game.list_all_sessions(db, identity)}


@router.get("/record/mine")
def my_record(request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    identity = _identity(request)
    return draft_order_game.career_record(db, identity)


@router.get("/leaderboard")
def leaderboard(request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    identity = _identity(request)
    return draft_order_game.score_leaderboard(db, identity)


@router.post("/sessions", status_code=201)
def create_room(
    payload: CreateRoomRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room = draft_order_game.create_session(db, identity, payload.league_name)
    return draft_order_game.serialize_session(db, room, identity["username"])


@router.post("/practice", status_code=201)
def create_practice(
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room = draft_order_game.create_practice_session(db, identity)
    return draft_order_game.serialize_session(db, room, identity["username"])


@router.post("/sessions/bots", status_code=201)
def create_bot_room(
    payload: CreateBotRoomRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room = draft_order_game.create_bot_session(
        db,
        identity,
        payload.league_name,
        payload.bot_count,
    )
    return draft_order_game.serialize_session(db, room, identity["username"])


@router.post("/sessions/test", status_code=201)
def create_test_room(
    payload: CreateBotRoomRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    if identity.get("role") != accounts.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Only the site admin can create bot test rooms.")
    room = draft_order_game.create_test_session(
        db,
        identity,
        payload.league_name,
        payload.bot_count,
    )
    return draft_order_game.serialize_session(db, room, identity["username"])


@router.post("/sessions/join")
def join_room(
    payload: JoinRoomRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room = draft_order_game.join_session(db, identity, payload.join_code)
    return draft_order_game.serialize_session(db, room, identity["username"])


@router.get("/sessions/{session_id}")
def room_status(
    session_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room = draft_order_game.get_session(db, session_id)
    view = draft_order_game.serialize_session(db, room, identity["username"])
    if not view["isMember"]:
        raise HTTPException(status_code=403, detail="Join this draft room to view it.")
    return view


@router.delete("/sessions/{session_id}", status_code=204)
def delete_room(
    session_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> Response:
    identity = _identity(request)
    draft_order_game.delete_session(db, identity, session_id)
    return Response(status_code=204)


# Declared before the {player_id} route below: Starlette matches in order, and
# "me" would otherwise be read as a player ID.
@router.delete("/sessions/{session_id}/players/me", status_code=204)
def leave_room(
    session_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> Response:
    identity = _identity(request)
    draft_order_game.leave_session(db, identity, session_id)
    return Response(status_code=204)


@router.delete("/sessions/{session_id}/players/{player_id}")
def remove_player(
    session_id: str,
    player_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room = draft_order_game.remove_player(db, identity, session_id, player_id)
    return draft_order_game.serialize_session(db, room, identity["username"])


@router.post("/sessions/{session_id}/start")
def start_room(
    session_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room = draft_order_game.start_session(db, identity, session_id)
    return draft_order_game.serialize_session(db, room, identity["username"])


@router.post("/sessions/{session_id}/flip")
def flip(
    session_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room = draft_order_game.flip_card(db, identity, session_id)
    return draft_order_game.serialize_session(db, room, identity["username"])


@router.post("/sessions/{session_id}/bank")
def bank(
    session_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room = draft_order_game.bank_round(db, identity, session_id)
    return draft_order_game.serialize_session(db, room, identity["username"])


@router.post("/sessions/{session_id}/forfeit")
def forfeit(
    session_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room = draft_order_game.forfeit_current_player(db, identity, session_id)
    return draft_order_game.serialize_session(db, room, identity["username"])


@router.post("/sessions/{session_id}/bots/step")
def play_bot_step(
    session_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room = draft_order_game.play_bot_step(db, identity, session_id)
    return draft_order_game.serialize_session(db, room, identity["username"])


@router.post("/sessions/{session_id}/reveal")
def reveal_room(
    session_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room = draft_order_game.reveal_results(db, identity, session_id)
    return draft_order_game.serialize_session(db, room, identity["username"])


@router.get("/sessions/{session_id}/verify")
def verify_room(
    session_id: str,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    room = draft_order_game.get_session(db, session_id)
    # Once the host reveals the result, the proof is intentionally public. A
    # copied draft order is only independently checkable if a league member can
    # send it to somebody who was never signed into the room.
    return draft_order_game.verification(db, room)
