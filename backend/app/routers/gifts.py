"""Gift board API (spec 21).

Every route belongs to one account and is gated here with a JSON 403 rather
than by path prefix — see ``accounts.require_member_identity`` for why. The
privacy rule (ideas are only ever served to their author) lives in
``services/gift_board.py``, which filters every read on the caller.
"""
from datetime import date
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Path, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import accounts
from app.database import get_db
from app.services import gift_board

router = APIRouter(prefix="/api/gifts", tags=["gifts"])

STATUS_PATTERN = "^(idea|bought|given|wanted|received)$"
MAX_PRICE_CENTS = 100_000_000


def require_member(request: Request) -> Dict[str, Any]:
    """Any signed-in account keeps a gift board; anonymous callers may not."""
    return accounts.require_member_identity(request, "Sign in to use the gift board.")


def caller(identity: Dict[str, Any] = Depends(require_member)) -> str:
    return gift_board.username_for(identity)


class CreatePersonRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    note: Optional[str] = Field(None, max_length=2000)
    birthday: Optional[date] = None


class UpdatePersonRequest(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    note: Optional[str] = Field(None, max_length=2000)
    birthday: Optional[date] = None


class MovePersonRequest(BaseModel):
    index: int = Field(..., ge=0, le=gift_board.MAX_PEOPLE)


class CreateItemRequest(BaseModel):
    # Omitted or null: the caller's own wishlist.
    person_id: Optional[int] = Field(None, ge=1)
    title: str = Field(..., min_length=1, max_length=200)
    url: Optional[str] = Field(None, max_length=2000)
    price_cents: Optional[int] = Field(None, ge=0, le=MAX_PRICE_CENTS)
    note: Optional[str] = Field(None, max_length=2000)
    status: Optional[str] = Field(None, pattern=STATUS_PATTERN)
    occasion: Optional[str] = Field(None, max_length=80)
    given_on: Optional[date] = None


class UpdateItemRequest(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    url: Optional[str] = Field(None, max_length=2000)
    price_cents: Optional[int] = Field(None, ge=0, le=MAX_PRICE_CENTS)
    note: Optional[str] = Field(None, max_length=2000)
    status: Optional[str] = Field(None, pattern=STATUS_PATTERN)
    occasion: Optional[str] = Field(None, max_length=80)
    given_on: Optional[date] = None


class MoveItemRequest(BaseModel):
    # Required, so "move to my wishlist" is an explicit null rather than an
    # omitted field that happens to mean the same thing.
    person_id: Optional[int] = Field(..., ge=1)
    index: int = Field(..., ge=0, le=gift_board.MAX_ITEMS)


@router.get("/board")
def read_board(username: str = Depends(caller), db: Session = Depends(get_db)) -> Dict[str, Any]:
    return gift_board.board(db, username)


@router.post("/people", status_code=201)
def create_person(
    body: CreatePersonRequest, username: str = Depends(caller), db: Session = Depends(get_db)
) -> Dict[str, Any]:
    return gift_board.create_person(db, username, body.name, body.note, body.birthday)


@router.patch("/people/{person_id}")
def update_person(
    body: UpdatePersonRequest,
    person_id: int = Path(..., ge=1),
    username: str = Depends(caller),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return gift_board.update_person(db, username, person_id, body.model_dump(exclude_unset=True))


@router.post("/people/{person_id}/move")
def move_person(
    body: MovePersonRequest,
    person_id: int = Path(..., ge=1),
    username: str = Depends(caller),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return gift_board.move_person(db, username, person_id, body.index)


@router.delete("/people/{person_id}", status_code=204)
def delete_person(
    person_id: int = Path(..., ge=1), username: str = Depends(caller), db: Session = Depends(get_db)
) -> Response:
    gift_board.delete_person(db, username, person_id)
    return Response(status_code=204)


@router.post("/items", status_code=201)
def create_item(
    body: CreateItemRequest, username: str = Depends(caller), db: Session = Depends(get_db)
) -> Dict[str, Any]:
    return gift_board.create_item(db, username, body.model_dump())


@router.patch("/items/{item_id}")
def update_item(
    body: UpdateItemRequest,
    item_id: int = Path(..., ge=1),
    username: str = Depends(caller),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return gift_board.update_item(db, username, item_id, body.model_dump(exclude_unset=True))


@router.post("/items/{item_id}/move")
def move_item(
    body: MoveItemRequest,
    item_id: int = Path(..., ge=1),
    username: str = Depends(caller),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return gift_board.move_item(db, username, item_id, body.person_id, body.index)


@router.delete("/items/{item_id}", status_code=204)
def delete_item(
    item_id: int = Path(..., ge=1), username: str = Depends(caller), db: Session = Depends(get_db)
) -> Response:
    gift_board.delete_item(db, username, item_id)
    return Response(status_code=204)
