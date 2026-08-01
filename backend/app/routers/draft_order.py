"""Account-backed API for the Fourth & Fortune draft-order game."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.services import draft_order_game

router = APIRouter(prefix="/api/fantasy/draft", tags=["fantasy-draft-order"])


class CreateRoomRequest(BaseModel):
    league_name: str = Field(..., min_length=3, max_length=60)


class JoinRoomRequest(BaseModel):
    join_code: str = Field(..., min_length=6, max_length=12)


def _identity(request: Request) -> dict[str, str]:
    identity = getattr(request.state, "app_user", None)
    if not identity:
        raise HTTPException(status_code=401, detail="Sign in or create an account to play.")
    return identity


@router.get("/sessions/mine")
def my_sessions(request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    identity = _identity(request)
    return {"sessions": draft_order_game.list_sessions_for_user(db, identity)}


@router.post("/sessions", status_code=201)
def create_room(
    payload: CreateRoomRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room = draft_order_game.create_session(db, identity, payload.league_name)
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
    room, event = draft_order_game.flip_card(db, identity, session_id)
    view = draft_order_game.serialize_session(db, room, identity["username"])
    view["event"] = event
    return view


@router.post("/sessions/{session_id}/bank")
def bank(
    session_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room, event = draft_order_game.bank_round(db, identity, session_id)
    view = draft_order_game.serialize_session(db, room, identity["username"])
    view["event"] = event
    return view


@router.post("/sessions/{session_id}/forfeit")
def forfeit(
    session_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room, event = draft_order_game.forfeit_current_player(db, identity, session_id)
    view = draft_order_game.serialize_session(db, room, identity["username"])
    view["event"] = event
    return view


@router.get("/sessions/{session_id}/verify")
def verify_room(
    session_id: str,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    identity = _identity(request)
    room = draft_order_game.get_session(db, session_id)
    view = draft_order_game.serialize_session(db, room, identity["username"])
    if not view["isMember"]:
        raise HTTPException(status_code=403, detail="Join this draft room to verify it.")
    return draft_order_game.verification(db, room)
