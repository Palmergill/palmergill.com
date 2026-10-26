"""Castle Defense daily leaderboard API.

Reading a day's board is public. Posting a run needs a site account and
answers anonymous callers with a JSON 403 (see accounts.require_member_identity)
so the page can show its own sign-in prompt. The score that's stored is the
server's replay of the posted layout — see services/castle_defense.py.
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app import accounts
from app.database import get_db
from app.services import castle_defense

router = APIRouter(prefix="/api/castle-defense", tags=["castle-defense"])

DAY_PATTERN = r"^\d{4}-\d{2}-\d{2}$"
TYPE_PATTERN = "^(archer|cannon|frost|mage|spikes|tar|mine)$"
MODE_PATTERN = "^(classic|open)$"


class Placement(BaseModel):
    type: str = Field(..., pattern=TYPE_PATTERN)
    x: int = Field(..., ge=0, le=7)
    y: int = Field(..., ge=0, le=7)


class RunRequest(BaseModel):
    day: str = Field(..., pattern=DAY_PATTERN)
    mode: str = Field("classic", pattern=MODE_PATTERN)
    # 1,000 gold at 75 a trap is at most 13 pieces.
    layout: List[Placement] = Field(..., min_length=1, max_length=16)


def _username(request: Request) -> Optional[str]:
    identity = getattr(request.state, "app_user", None)
    if not identity:
        return None
    return accounts.normalize_username(str(identity.get("username", ""))) or None


def _display_name(db: Session, username: str) -> str:
    user = accounts.get_user(db, username)
    return (user.display_name if user and user.display_name else username)[:40]


@router.get("/leaderboard")
def get_leaderboard(
    request: Request,
    day: str = Query(..., pattern=DAY_PATTERN),
    mode: str = Query("classic", pattern=MODE_PATTERN),
    db: Session = Depends(get_db),
) -> Dict[str, Any]:
    return castle_defense.leaderboard(db, castle_defense.validate_day(day), _username(request), mode)


@router.post("/runs")
def post_run(body: RunRequest, request: Request, db: Session = Depends(get_db)) -> Dict[str, Any]:
    message = "Sign in to put your score on the leaderboard."
    identity = accounts.require_member_identity(request, message)
    username = accounts.normalize_username(str(identity.get("username", "")))
    if not username:
        raise HTTPException(status_code=403, detail=message)
    day = castle_defense.validate_day(body.day)
    layout = [p.model_dump() for p in body.layout]
    return castle_defense.submit(db, day, layout, username, _display_name(db, username), body.mode)
