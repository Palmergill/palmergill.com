"""Castle Defense daily leaderboard.

The game is fully client-side, so the server never trusts a reported score.
A run is posted as its date and layout; the server replays it in the very
same engine the page runs (castle-defense/castleDefenseGame.js, inside an
embedded V8) and stores what that replay earns. The engine is deterministic
— seeded map and horde, fixed time step — so the replay matches the run the
player watched.

Each day's tiers are worked out here too, in the background: hundreds of
trial layouts of the day's allotment set the cut-offs, and a hill climb from
the best of them finds the day's best known layout (see
castle-defense/castleDefenseTrials.js). Tomorrow's are done before the map
turns over, and any other day is done the first time someone asks for it.
"""
import json
import logging
import os
import threading
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import CastleDefenseScore, CastleDefenseTiers, SessionLocal, utc_now

logger = logging.getLogger(__name__)

BOARD_SIZE = 50
# Replays cost real CPU (about 0.1s each), so cap how often one account posts.
MAX_RUNS_PER_DAY = 100

_BACKEND_DIR = Path(__file__).resolve().parents[2]
_ENGINE_CANDIDATES = (
    # Docker image: the Dockerfile copies the engine next to the app.
    _BACKEND_DIR / "castle-defense" / "castleDefenseGame.js",
    # Repo checkout: backend/ and castle-defense/ are siblings.
    _BACKEND_DIR.parent / "castle-defense" / "castleDefenseGame.js",
)


@lru_cache(maxsize=None)
def _source(name: str) -> str:
    override = os.getenv("CASTLE_DEFENSE_ENGINE")
    dirs = [Path(override).parent] if override else [p.parent for p in _ENGINE_CANDIDATES]
    paths = [d / name for d in dirs]
    for path in paths:
        if path.is_file():
            return path.read_text(encoding="utf-8")
    raise RuntimeError(f"{name} not found; looked in " + ", ".join(str(p) for p in paths))


def engine_source() -> str:
    return _source("castleDefenseGame.js")


# FastAPI runs these requests on a thread pool, and two V8 contexts starting
# at once abort the whole process (V8's one-time setup isn't thread-safe), so
# replays take turns.
_ENGINE_LOCK = threading.Lock()


def _eval(expression: str) -> str:
    from py_mini_racer import MiniRacer

    with _ENGINE_LOCK:
        ctx = MiniRacer()
        try:
            ctx.eval(engine_source())
            ctx.eval(_source("castleDefenseTrials.js"))
            return ctx.eval(expression)
        finally:
            # Without an explicit close the V8 thread keeps the process alive.
            ctx.close()


@lru_cache(maxsize=1)
def current_rules() -> int:
    """The engine's own RULES number, so the server can't drift from it."""
    return int(_eval("CastleDefenseGame.RULES"))


def replay(day: str, layout: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Run `layout` on `day`'s map to the end and return the engine's result."""
    return json.loads(_eval(f"JSON.stringify(CastleDefenseGame.replay({json.dumps(day)}, {json.dumps(layout)}))"))


# ── daily tiers ──────────────────────────────────────────────────────────────

# A day's work: TRIALS trial layouts, then CLIMB_STEPS steps of the search.
# About a minute of CPU, in chunks of CHUNK replays (a second or so each), so
# posted runs waiting on the engine lock never wait long.
TRIALS = int(os.getenv("CASTLE_DEFENSE_TRIALS", "300"))
CLIMB_STEPS = int(os.getenv("CASTLE_DEFENSE_CLIMB_STEPS", "400"))
CHUNK = 12
# Day #1; nothing before it has a map worth working out.
EPOCH = "2026-10-18"

_tier_lock = threading.Lock()
_tier_queue: List[str] = []
_tier_worker: Optional[threading.Thread] = None


def _trials_call(fn: str, *args: Any) -> Any:
    params = ", ".join(json.dumps(a) for a in args)
    return json.loads(_eval(f"JSON.stringify(CastleDefenseTrials.{fn}({params}))"))


def _tiers_row(db: Session, day: str) -> Optional[CastleDefenseTiers]:
    return db.query(CastleDefenseTiers).filter_by(day=day, rules=current_rules()).first()


def work_out_tiers(day: str) -> None:
    """Play the day's trials and search, and store its tiers and best layout."""
    db = SessionLocal()
    try:
        if _tiers_row(db, day):
            return
        kills: List[int] = []
        best = None
        for start in range(0, TRIALS, CHUNK):
            chunk = _trials_call("runTrials", day, start, min(CHUNK, TRIALS - start))
            kills += chunk["kills"]
            if best is None or chunk["best"]["kills"] > best["kills"]:
                best = chunk["best"]
        for start in range(0, CLIMB_STEPS, CHUNK):
            best = _trials_call("climb", day, best, start, min(CHUNK, CLIMB_STEPS - start))
        cuts = _trials_call("tierCuts", kills)
        db.add(CastleDefenseTiers(
            day=day, rules=current_rules(), cuts=json.dumps(cuts),
            best_kills=int(best["kills"]), best_layout=json.dumps(best["layout"]),
        ))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
        logger.info("Castle Defense tiers for %s: %s, best found %s", day, cuts, best["kills"])
    finally:
        db.close()


def _work_tier_queue() -> None:
    global _tier_worker
    while True:
        with _tier_lock:
            if not _tier_queue:
                _tier_worker = None
                return
            day = _tier_queue[0]
        try:
            work_out_tiers(day)
        except Exception:
            logger.exception("Castle Defense tiers for %s failed", day)
        with _tier_lock:
            _tier_queue.remove(day)


def queue_tiers(days: List[str], first: bool = False) -> None:
    """Have the background worker work out these days' tiers, one at a time.
    Days outside day #1 to tomorrow are left alone, so nobody can queue up
    years of future maps."""
    global _tier_worker
    last = max(postable_days())
    days = [d for d in days if EPOCH <= d <= last]
    with _tier_lock:
        for day in days:
            if day in _tier_queue:
                continue
            # The day being worked on stays at the front.
            if first and _tier_queue:
                _tier_queue.insert(1, day)
            else:
                _tier_queue.append(day)
        if _tier_queue and _tier_worker is None:
            _tier_worker = threading.Thread(target=_work_tier_queue, name="castle-defense-tiers", daemon=True)
            _tier_worker.start()


def queue_upcoming_tiers() -> None:
    """Every day anyone can be playing now, tomorrow's included."""
    queue_tiers(sorted(postable_days()))


def tiers(db: Session, day: str) -> Dict[str, Any]:
    """A day's tier cut-offs and best found score, or ready: False while
    they're still being worked out. The best found is the search's best or
    the day's top run, whichever is higher."""
    row = _tiers_row(db, day)
    if row is None:
        queue_tiers([day], first=True)
        return {"day": day, "ready": False}
    top = _board_query(db, day).first()
    best = max(row.best_kills, top.kills if top else 0)
    return {"day": day, "ready": True, "cuts": json.loads(row.cuts), "best": best}


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


def _day(db: Session, day: str):
    """A day's rows that count: the ones played under the current rules."""
    return db.query(CastleDefenseScore).filter(
        CastleDefenseScore.day == day, CastleDefenseScore.rules == current_rules()
    )


def _board_query(db: Session, day: str):
    return (
        _day(db, day)
        .order_by(CastleDefenseScore.kills.desc(), CastleDefenseScore.achieved_at.asc(), CastleDefenseScore.id.asc())
    )


def rank_of(db: Session, row: CastleDefenseScore) -> int:
    """Standard competition ranking: tied scores share a place (1, 2, 2, 4)."""
    ahead = _day(db, row.day).filter(CastleDefenseScore.kills > row.kills).count()
    return ahead + 1


def player_count(db: Session, day: str) -> int:
    return _day(db, day).count()


def entry(row: CastleDefenseScore, rank: int, username: Optional[str] = None) -> Dict[str, Any]:
    return {
        "rank": rank,
        "name": row.display_name,
        "kills": row.kills,
        "wave": row.wave,
        "runs": row.runs,
        "you": username is not None and row.username == username,
    }


def leaderboard(db: Session, day: str, username: Optional[str] = None) -> Dict[str, Any]:
    rows = _board_query(db, day).limit(BOARD_SIZE).all()
    entries = []
    previous = None
    for index, row in enumerate(rows):
        rank = entries[-1]["rank"] if previous is not None and row.kills == previous else index + 1
        entries.append(entry(row, rank, username))
        previous = row.kills
    you = None
    if username:
        mine = _day(db, day).filter(CastleDefenseScore.username == username).first()
        if mine:
            # Your own best layout comes back to you, so any device can load it.
            you = {**entry(mine, rank_of(db, mine), username), "layout": json.loads(mine.layout)}
    return {"day": day, "players": player_count(db, day), "entries": entries, "you": you}


def all_time(db: Session, username: Optional[str] = None) -> Dict[str, Any]:
    """Every player's medals: a gold for each day they finished 1st, silver
    for 2nd, bronze for 3rd, ranking each day the way its own board does
    (tied scores share a place, so a tie for 1st is two golds and no silver).
    A day is judged under the rules it was played under — the newest rules
    among its rows — and today's standings count as they stand. Players rank
    like a medal table: golds, then silvers, then bronzes."""
    model = CastleDefenseScore
    rows = db.query(model.day, model.username, model.display_name, model.kills, model.rules).all()
    by_day: Dict[str, list] = {}
    for row in rows:
        by_day.setdefault(row.day, []).append(row)

    medals = {1: "gold", 2: "silver", 3: "bronze"}
    players: Dict[str, Dict[str, Any]] = {}
    # Oldest day first, so a player's newest display name is the one shown.
    for day in sorted(by_day):
        day_rows = by_day[day]
        rules = max(r.rules for r in day_rows)
        ranked = sorted((r for r in day_rows if r.rules == rules), key=lambda r: -r.kills)
        for index, row in enumerate(ranked):
            # Competition ranking: one more than the number of better scores.
            rank = 1 + sum(1 for other in ranked[:index] if other.kills > row.kills)
            p = players.setdefault(
                row.username, {"username": row.username, "gold": 0, "silver": 0, "bronze": 0, "days": 0}
            )
            p["name"] = row.display_name
            p["days"] += 1
            if rank in medals:
                p[medals[rank]] += 1

    tally = lambda p: (p["gold"], p["silver"], p["bronze"])
    order = sorted(players.values(), key=lambda p: (tuple(-n for n in tally(p)), -p["days"], p["name"].lower()))
    entries = []
    for index, p in enumerate(order):
        tied = entries and tally(p) == tally(order[index - 1])
        entries.append({
            "rank": entries[-1]["rank"] if tied else index + 1,
            "name": p["name"],
            "gold": p["gold"],
            "silver": p["silver"],
            "bronze": p["bronze"],
            "days": p["days"],
            "you": username is not None and p["username"] == username,
        })
    you = next((e for e in entries if e["you"]), None)
    return {"players": len(entries), "days": len(by_day), "entries": entries[:BOARD_SIZE], "you": you}


def _count_run(row: CastleDefenseScore, kills: int, wave: int, rules: int, layout: List[Dict[str, Any]], display_name: str) -> bool:
    """Count one more run on an existing row; True if it's the new best."""
    row.runs += 1
    row.display_name = display_name
    # A score from older rules isn't comparable, so any run replaces it.
    if row.rules != rules or kills > row.kills:
        row.kills, row.wave, row.layout, row.rules = kills, wave, json.dumps(layout), rules
        row.achieved_at = utc_now()
        return True
    return False


def submit(db: Session, day: str, layout: List[Dict[str, Any]], username: str, display_name: str) -> Dict[str, Any]:
    if day not in postable_days():
        raise HTTPException(status_code=422, detail="Only today's map is ranked.")

    row = db.query(CastleDefenseScore).filter_by(day=day, username=username).first()
    if row and row.runs >= MAX_RUNS_PER_DAY:
        raise HTTPException(status_code=429, detail="That's a lot of runs for one day. Try again tomorrow.")

    result = replay(day, layout)
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("reason") or "That layout isn't valid.")

    kills, wave, rules = int(result["kills"]), int(result["wave"]), int(result["rules"])
    if row is None:
        row = CastleDefenseScore(
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
        try:
            db.commit()
        except IntegrityError:
            # Another post of this account's first run today landed during
            # the replay: count this one against the row it made.
            db.rollback()
            row = db.query(CastleDefenseScore).filter_by(day=day, username=username).one()
            improved = _count_run(row, kills, wave, rules, layout, display_name)
            db.commit()
    else:
        improved = _count_run(row, kills, wave, rules, layout, display_name)
        db.commit()
    db.refresh(row)
    return {
        "day": day,
        "kills": kills,
        "wave": wave,
        "improved": improved,
        "best": entry(row, rank_of(db, row), username),
        "players": player_count(db, day),
    }
