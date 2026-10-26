"""Castle Defense daily leaderboard.

The game is fully client-side, so the server never trusts a reported score.
A run is posted as its date and layout; the server replays it in the very
same engine the page runs (castle-defense/castleDefenseGame.js, inside an
embedded V8) and stores what that replay earns. The engine is deterministic
— seeded map and horde, fixed time step — so the replay matches the run the
player watched.

Each mode — the classic road and the open field — has its own board, in its
own table, ranked under its own rules number.
"""
import json
import os
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.database import CastleDefenseOpenScore, CastleDefenseScore, utc_now

BOARD_SIZE = 50
MODELS = {"classic": CastleDefenseScore, "open": CastleDefenseOpenScore}
# Replays cost real CPU (about 0.1s each), so cap how often one account posts.
MAX_RUNS_PER_DAY = 60

_BACKEND_DIR = Path(__file__).resolve().parents[2]
_ENGINE_CANDIDATES = (
    # Docker image: the Dockerfile copies the engine next to the app.
    _BACKEND_DIR / "castle-defense" / "castleDefenseGame.js",
    # Repo checkout: backend/ and castle-defense/ are siblings.
    _BACKEND_DIR.parent / "castle-defense" / "castleDefenseGame.js",
)


@lru_cache(maxsize=1)
def engine_source() -> str:
    override = os.getenv("CASTLE_DEFENSE_ENGINE")
    paths = [Path(override)] if override else list(_ENGINE_CANDIDATES)
    for path in paths:
        if path.is_file():
            return path.read_text(encoding="utf-8")
    raise RuntimeError("castleDefenseGame.js not found; looked in " + ", ".join(str(p) for p in paths))


def _eval(expression: str) -> str:
    from py_mini_racer import MiniRacer

    ctx = MiniRacer()
    try:
        ctx.eval(engine_source())
        return ctx.eval(expression)
    finally:
        # Without an explicit close the V8 thread keeps the process alive.
        ctx.close()


@lru_cache(maxsize=None)
def current_rules(mode: str = "classic") -> int:
    """The engine's own rules number for `mode`, so the server can't drift from it."""
    return int(_eval(f"CastleDefenseGame.RULES_BY_MODE[{json.dumps(mode)}]"))


def replay(day: str, layout: List[Dict[str, Any]], mode: str = "classic") -> Dict[str, Any]:
    """Run `layout` on `day`'s `mode` map to the end and return the engine's result."""
    return json.loads(
        _eval(f"JSON.stringify(CastleDefenseGame.replay({json.dumps(day)}, {json.dumps(layout)}, {json.dumps(mode)}))")
    )


def postable_days(now: Optional[datetime] = None) -> set:
    """Players post to their own local date, which can sit a day either side
    of UTC. Anything else is a replay of another day, and isn't ranked."""
    today = (now or datetime.now(timezone.utc)).date()
    return {(today + timedelta(days=offset)).isoformat() for offset in (-1, 0, 1)}


def validate_day(day: str) -> str:
    try:
        return date.fromisoformat(day).isoformat()
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="That isn't a date.")


def _day(db: Session, day: str, mode: str = "classic"):
    """A day's rows that count: the ones played under the mode's current rules."""
    model = MODELS[mode]
    return db.query(model).filter(model.day == day, model.rules == current_rules(mode))


def _board_query(db: Session, day: str, mode: str = "classic"):
    model = MODELS[mode]
    return _day(db, day, mode).order_by(model.kills.desc(), model.achieved_at.asc(), model.id.asc())


def rank_of(db: Session, row, mode: str = "classic") -> int:
    """Standard competition ranking: tied scores share a place (1, 2, 2, 4)."""
    ahead = _day(db, row.day, mode).filter(MODELS[mode].kills > row.kills).count()
    return ahead + 1


def player_count(db: Session, day: str, mode: str = "classic") -> int:
    return _day(db, day, mode).count()


def entry(row, rank: int, username: Optional[str] = None) -> Dict[str, Any]:
    return {
        "rank": rank,
        "name": row.display_name,
        "kills": row.kills,
        "wave": row.wave,
        "runs": row.runs,
        "you": username is not None and row.username == username,
    }


def leaderboard(db: Session, day: str, username: Optional[str] = None, mode: str = "classic") -> Dict[str, Any]:
    rows = _board_query(db, day, mode).limit(BOARD_SIZE).all()
    entries = []
    previous = None
    for index, row in enumerate(rows):
        rank = entries[-1]["rank"] if previous is not None and row.kills == previous else index + 1
        entries.append(entry(row, rank, username))
        previous = row.kills
    you = None
    if username:
        mine = _day(db, day, mode).filter(MODELS[mode].username == username).first()
        if mine:
            you = entry(mine, rank_of(db, mine, mode), username)
    return {"day": day, "players": player_count(db, day, mode), "entries": entries, "you": you}


def submit(
    db: Session, day: str, layout: List[Dict[str, Any]], username: str, display_name: str, mode: str = "classic"
) -> Dict[str, Any]:
    if day not in postable_days():
        raise HTTPException(status_code=422, detail="Only today's map is ranked.")

    model = MODELS[mode]
    row = db.query(model).filter_by(day=day, username=username).first()
    if row and row.runs >= MAX_RUNS_PER_DAY:
        raise HTTPException(status_code=429, detail="That's a lot of runs for one day. Try again tomorrow.")

    result = replay(day, layout, mode)
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("reason") or "That layout isn't valid.")

    kills, wave, rules = int(result["kills"]), int(result["wave"]), int(result["rules"])
    improved = False
    if row is None:
        row = model(
            day=day,
            username=username,
            display_name=display_name,
            kills=kills,
            wave=wave,
            layout=json.dumps(layout),
            runs=1,
            rules=rules,
        )
        db.add(row)
        improved = True
    else:
        row.runs += 1
        row.display_name = display_name
        # A score from older rules isn't comparable, so any run replaces it.
        if row.rules != rules or kills > row.kills:
            row.kills, row.wave, row.layout, row.rules = kills, wave, json.dumps(layout), rules
            row.achieved_at = utc_now()
            improved = True
    db.commit()
    db.refresh(row)
    return {
        "day": day,
        "kills": kills,
        "wave": wave,
        "improved": improved,
        "best": entry(row, rank_of(db, row, mode), username),
        "players": player_count(db, day, mode),
    }
