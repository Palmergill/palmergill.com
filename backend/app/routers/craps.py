"""Craps strategy simulator API.

POST /api/craps/translate turns a plain-English description into a validated
StrategyIntent (no dollar amounts — the frontend sizes bets deterministically).
"""

from __future__ import annotations

import os
import time
from typing import List, Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError, field_validator

from app.services import craps_ai

router = APIRouter(prefix="/api/craps", tags=["craps"])

TRANSLATE_RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("CRAPS_TRANSLATE_RATE_LIMIT_WINDOW_SECONDS", "60"))
TRANSLATE_RATE_LIMIT_MAX = int(os.getenv("CRAPS_TRANSLATE_RATE_LIMIT_MAX", "20"))
_rate_limit_store: dict[str, list[float]] = {}

LINE_BETS = {"passLine", "dontPass", "come", "dontCome"}

BetType = Literal[
    "passLine", "dontPass", "come", "dontCome",
    "place4", "place5", "place6", "place8", "place9", "place10",
    "hard4", "hard6", "hard8", "hard10",
    "field", "any7", "anyCraps", "yo11", "craps2", "craps3", "craps12",
]


class TranslateRequest(BaseModel):
    description: str = Field(..., min_length=1, max_length=1000)
    baseUnit: int = Field(5, ge=1, le=10000)


class BetIntent(BaseModel):
    type: BetType
    units: int = Field(..., ge=1, le=1000)
    when: Optional[Literal["comeOut", "pointOn", "always"]] = None
    everyRoll: Optional[bool] = None
    maxActive: Optional[int] = Field(None, ge=1, le=10)


class ProgressionIntent(BaseModel):
    appliesTo: List[BetType] = Field(default_factory=list)
    onWin: Literal["press", "regress", "none"] = "none"
    onLoss: Literal["double", "none"] = "none"
    resetOnSevenOut: bool = False


class StrategyIntent(BaseModel):
    name: str = Field("Custom strategy", max_length=120)
    summary: str = Field("", max_length=400)
    workingOnComeOut: bool = False
    bets: List[BetIntent] = Field(..., min_length=1, max_length=24)
    odds: dict[str, object] = Field(default_factory=dict)
    progression: Optional[ProgressionIntent] = None

    @field_validator("odds")
    @classmethod
    def _check_odds(cls, value: dict) -> dict:
        for key, mult in value.items():
            if key not in LINE_BETS:
                raise ValueError(f'odds key "{key}" is not a line bet')
            if not (mult == "max" or (isinstance(mult, int) and 1 <= mult <= 100)):
                raise ValueError(f'odds.{key} must be "max" or an integer 1..100')
        return value


def _rate_limited(request: Request, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    # Reuse the shared proxy-aware client IP so rate limits aren't defeated
    # behind a reverse proxy.
    from app.main import client_ip

    key = client_ip(request)
    cutoff = now - TRANSLATE_RATE_LIMIT_WINDOW_SECONDS
    attempts = [t for t in _rate_limit_store.get(key, []) if t > cutoff]
    if len(attempts) >= TRANSLATE_RATE_LIMIT_MAX:
        _rate_limit_store[key] = attempts
        return True
    attempts.append(now)
    _rate_limit_store[key] = attempts
    return False


@router.post("/translate", response_model=StrategyIntent, response_model_exclude_none=True)
async def translate(payload: TranslateRequest, request: Request) -> StrategyIntent:
    if _rate_limited(request):
        raise HTTPException(status_code=429, detail="Too many requests. Try again shortly.")

    try:
        raw = craps_ai.translate_strategy(payload.description, payload.baseUnit)
    except craps_ai.CrapsUnavailableError:
        # No API key (or otherwise unavailable). The frontend falls back to
        # built-in preset strategies when it sees a 503.
        raise HTTPException(status_code=503, detail="Strategy translation is unavailable.")
    except craps_ai.CrapsTranslateError as exc:
        raise HTTPException(status_code=502, detail=f"Could not translate strategy: {exc}")

    try:
        return StrategyIntent.model_validate(raw)
    except ValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"The model produced an invalid strategy: {exc.errors()[:3]}",
        )
