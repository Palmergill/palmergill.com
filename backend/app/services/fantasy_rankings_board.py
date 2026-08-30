"""Personal ranking boards (spec 18).

A board is one member's own fantasy rankings for a (season, scoring, roster)
combination. The whole module rests on a single idea:

    A board stores ONE order, not five.

The product rule is that positional order is authoritative and a drag in the
overall list also reorders the player within his position. Taken literally,
that says: for two players of the same position, ``a`` precedes ``b`` overall
if and only if ``a`` precedes ``b`` in his positional list. Which means the
positional lists carry no information the overall list does not already have —
the QB list *is* the overall list filtered to QBs.

So there is no reconciliation pass here, and no "sync the lists" code path that
could be wrong. A positional move is translated into an overall slot (see
``_resolve_target``) and that is the end of it.

Ordering is stored as a sparse float ``sort_key``, seeded at 1000, 2000, ... so
a move writes a single row rather than renumbering three hundred. Display rank
is never stored; it is derived densely on read. Float midpoints do eventually
exhaust, which is handled by renormalizing the whole board rather than avoided
with a fancier key encoding.
"""
import math
import secrets
from typing import Any, Dict, List, Optional, Sequence, Tuple

from fastapi import HTTPException
from sqlalchemy.orm.exc import StaleDataError
from sqlalchemy.orm import Session

from app.database import (
    FantasyPlayer,
    FantasyRankBoard,
    FantasyRankEntry,
    FantasyRankTier,
    iso_utc,
    utc_now,
)
from app.services import fantasy_data
from app.services.fantasy_collector import SEASON_LONG_WEEK, latest_successful_run
from app.services.fantasy_common import normalize_scoring

# Hand-built boards cover the positions people actually rank. Kickers and
# defenses are in the catalog but nobody orders them by opinion.
RANKABLE_POSITIONS = ("QB", "RB", "WR", "TE")
SCOPES = ("OVERALL",) + RANKABLE_POSITIONS
ROSTERS = ("1qb", "superflex")

# A player must appear on at least a quarter of the eligible published boards
# before the site presents him as consensus.  The floor is always at least one,
# so the first person to publish produces a useful board instead of an empty
# state.  Omissions on the remaining boards are scored one slot past that
# board's bottom; a short board therefore cannot silently vote for a player it
# never ranked.
CONSENSUS_APPEARANCE_RATE = 0.25

# Sparse key spacing. Big enough that ~30 successive midpoint insertions into
# one gap are possible before renormalization (log2(KEY_STEP / MIN_GAP)), small
# enough to stay exact in a float64 for any board size we will ever see.
KEY_STEP = 1000.0
# Below this, a midpoint would land on one of its own neighbors.
MIN_GAP = 1e-6

# How deep to seed each position. Superflex drafts run the quarterback pool
# nearly dry, so a 45-deep QB list would leave genuinely draftable players
# unrankable; the other positions give back the room.
SEED_CAPS = {
    "1qb": {"QB": 45, "RB": 90, "WR": 115, "TE": 50},
    "superflex": {"QB": 70, "RB": 85, "WR": 100, "TE": 45},
}

# Replacement level, as a 1-based rank within the position, for a 12-team
# 2RB/3WR/1TE/1FLEX league. This table is the only thing superflex changes
# about the math: with the flex spot usually holding a second quarterback,
# replacement QB sits near QB22 instead of QB12, every quarterback's value over
# replacement rises, and they float up the overall board through exactly the
# same sort every other position goes through.
BASELINE_RANK = {
    "1qb": {"QB": 12, "RB": 30, "WR": 36, "TE": 12},
    "superflex": {"QB": 22, "RB": 30, "WR": 36, "TE": 12},
}

# Tie-break priority when two players have identical value over replacement —
# ordered the way drafts actually run for that roster format.
POSITION_PRIORITY = {
    "1qb": {"RB": 0, "WR": 1, "TE": 2, "QB": 3},
    "superflex": {"QB": 0, "RB": 1, "WR": 2, "TE": 3},
}


class BoardConflict(HTTPException):
    """A write raced another tab. Carries the current board so the client can
    reload rather than silently interleaving two versions of one intent."""

    def __init__(self, board_payload: Dict[str, Any]):
        super().__init__(
            status_code=409,
            detail={
                "message": "This board changed somewhere else. Reload to pick up the latest order.",
                "board": board_payload,
            },
        )


# ── identity ────────────────────────────────────────────────────────────────

def identity_names(identity: Dict[str, Any]) -> Tuple[str, str]:
    """(normalized username, display casing) — mirrors draft_order_game."""
    from app import accounts

    display_name = str(identity.get("username", "")).strip()
    username = accounts.normalize_username(display_name)
    if not username:
        raise HTTPException(status_code=401, detail="Sign in to build a ranking board.")
    return username, display_name


def normalize_roster(roster: Optional[str]) -> str:
    value = (roster or "").strip().lower().replace("-", "").replace("_", "")
    if value in ("superflex", "sf", "2qb"):
        return "superflex"
    return "1qb"


def normalize_scope(scope: Optional[str]) -> str:
    value = (scope or "OVERALL").strip().upper()
    if value in ("DST", "DEF"):
        raise HTTPException(status_code=422, detail="Boards cover QB, RB, WR and TE only.")
    if value not in SCOPES:
        raise HTTPException(status_code=422, detail=f"Unknown list '{scope}'.")
    return value


# ── reads ───────────────────────────────────────────────────────────────────

def _entries(db: Session, board_id: int) -> List[FantasyRankEntry]:
    """Every entry in board order. `id` breaks ties so the order is total."""
    return (
        db.query(FantasyRankEntry)
        .filter(FantasyRankEntry.board_id == board_id)
        .order_by(FantasyRankEntry.sort_key.asc(), FantasyRankEntry.id.asc())
        .all()
    )


def _tiers(db: Session, board_id: int) -> List[FantasyRankTier]:
    return (
        db.query(FantasyRankTier)
        .filter(FantasyRankTier.board_id == board_id)
        .order_by(FantasyRankTier.sort_key.asc(), FantasyRankTier.id.asc())
        .all()
    )


def _scope_entries(entries: Sequence[FantasyRankEntry], scope: str) -> List[FantasyRankEntry]:
    if scope == "OVERALL":
        return list(entries)
    return [e for e in entries if e.position == scope]


def owned_board(db: Session, board_id: int, username: str) -> FantasyRankBoard:
    """A board the caller owns, or 404.

    Deliberately 404 rather than 403 for someone else's board: a 403 would
    confirm the board exists and make ids enumerable. The admin gets no
    special case — these are personal artifacts, not moderated content.
    """
    board = db.query(FantasyRankBoard).filter(FantasyRankBoard.id == board_id).first()
    if board is None or board.username != username:
        raise HTTPException(status_code=404, detail="No such ranking board.")
    return board


def published_board(db: Session, share_slug: str) -> FantasyRankBoard:
    """A deliberately published board, or the same opaque 404 for every miss."""
    board = (
        db.query(FantasyRankBoard)
        .filter(
            FantasyRankBoard.share_slug == share_slug,
            FantasyRankBoard.published.is_(True),
        )
        .first()
    )
    if board is None:
        raise HTTPException(status_code=404, detail="That shared ranking board is unavailable.")
    return board


def check_revision(db: Session, board: FantasyRankBoard, revision: Optional[int]) -> None:
    if revision is not None and int(revision) != int(board.revision):
        raise BoardConflict(serialize_board(db, board))


def _commit_board_write(db: Session, board: FantasyRankBoard) -> None:
    """Commit through SQLAlchemy's atomic revision predicate.

    ``check_revision`` gives a caller an early, useful 409, but only the
    mapper's ``UPDATE ... WHERE revision = loaded_revision`` closes the race
    between that check and commit. Any child-row writes in the same transaction
    are rolled back with the stale board update.
    """
    board_id = board.id
    try:
        db.commit()
    except StaleDataError:
        db.rollback()
        current = db.query(FantasyRankBoard).filter(FantasyRankBoard.id == board_id).first()
        if current is None:
            raise HTTPException(status_code=404, detail="No such ranking board.")
        raise BoardConflict(serialize_board(db, current))


def serialize_board(db: Session, board: FantasyRankBoard) -> Dict[str, Any]:
    entries = _entries(db, board.id)
    players = {
        p.player_id: p
        for p in db.query(FantasyPlayer)
        .filter(FantasyPlayer.player_id.in_([e.player_id for e in entries]))
        .all()
    } if entries else {}

    position_seen: Dict[str, int] = {}
    payload = []
    for overall_rank, entry in enumerate(entries, start=1):
        position_seen[entry.position] = position_seen.get(entry.position, 0) + 1
        player = players.get(entry.player_id)
        payload.append(
            {
                "player_id": entry.player_id,
                # A player the collector has since dropped still renders, as a
                # tombstone the owner can remove. The board is theirs, not the
                # catalog's.
                "name": player.full_name if player else None,
                "team": player.team if player else None,
                "position": entry.position,
                "catalog_position": player.position if player else None,
                "injury_status": player.injury_status if player else None,
                "overallRank": overall_rank,
                "positionRank": position_seen[entry.position],
                "seedOverallRank": entry.seed_rank,
                "note": entry.note,
            }
        )

    return {
        "id": board.id,
        "season": board.season,
        "scoring": board.scoring,
        "roster": board.roster,
        "title": board.title,
        "owner": board.display_name,
        "revision": board.revision,
        "published": bool(board.published),
        "shareUrl": f"/fantasy/rankings/?share={board.share_slug}",
        "seededFrom": board.seeded_from,
        "entries": payload,
        "tiers": _serialize_tiers(_tiers(db, board.id), entries),
        "updatedAt": iso_utc(board.updated_at),
    }


def serialize_published_board(db: Session, board: FantasyRankBoard) -> Dict[str, Any]:
    """The public representation is explicitly read-only and omits concurrency state."""
    payload = serialize_board(db, board)
    payload.pop("revision", None)
    payload["readOnly"] = True
    return payload


def _serialize_tiers(
    tiers: Sequence[FantasyRankTier], entries: Sequence[FantasyRankEntry]
) -> List[Dict[str, Any]]:
    """Dividers as "sits above this player", never as a raw key.

    The client never sees or reasons about key space; it only needs to know
    where a divider falls in a list it already has.
    """
    payload = []
    for tier in tiers:
        scoped = _scope_entries(entries, tier.scope)
        following = next((e for e in scoped if e.sort_key > tier.sort_key), None)
        payload.append(
            {
                "id": tier.id,
                "scope": tier.scope,
                "label": tier.label,
                "beforePlayerId": following.player_id if following else None,
            }
        )
    return payload


def summarize_boards(db: Session, username: str) -> List[Dict[str, Any]]:
    boards = (
        db.query(FantasyRankBoard)
        .filter(FantasyRankBoard.username == username)
        .order_by(FantasyRankBoard.season.desc(), FantasyRankBoard.updated_at.desc())
        .all()
    )
    summaries = []
    for board in boards:
        entries = _entries(db, board.id)
        counts = {pos: 0 for pos in RANKABLE_POSITIONS}
        for entry in entries:
            if entry.position in counts:
                counts[entry.position] += 1
        summaries.append(
            {
                "id": board.id,
                "season": board.season,
                "scoring": board.scoring,
                "roster": board.roster,
                "title": board.title,
                "entryCount": len(entries),
                "positionCounts": counts,
                "published": bool(board.published),
                "shareUrl": f"/fantasy/rankings/?share={board.share_slug}",
                "updatedAt": iso_utc(board.updated_at),
            }
        )
    return summaries


def site_consensus(
    db: Session, season: Optional[int], scoring: str, roster: str
) -> Dict[str, Any]:
    """Average published orders, imputing omissions just below each board.

    Ranks are averaged in overall space.  Positional ranks in the response are
    then derived by filtering that single consensus order, preserving the same
    invariant as a personal board.  A player has to clear an appearance floor
    before imputed ranks from boards that omitted him are allowed to pull him
    into the result.
    """
    scoring = normalize_scoring(scoring)
    roster = normalize_roster(roster)
    if season is None:
        season = fantasy_data.default_context(db)["season"] or utc_now().year
    published = (
        db.query(FantasyRankBoard)
        .filter(
            FantasyRankBoard.published.is_(True),
            FantasyRankBoard.season == season,
            FantasyRankBoard.scoring == scoring,
            FantasyRankBoard.roster == roster,
        )
        .order_by(FantasyRankBoard.id.asc())
        .all()
    )
    board_count = len(published)
    appearance_floor = max(1, math.ceil(board_count * CONSENSUS_APPEARANCE_RATE))
    if not published:
        return {
            "season": season,
            "scoring": scoring,
            "roster": roster,
            "boardCount": 0,
            "appearanceFloor": appearance_floor,
            "entries": [],
        }

    orders: List[List[FantasyRankEntry]] = [_entries(db, board.id) for board in published]
    appearances: Dict[str, int] = {}
    positions: Dict[str, str] = {}
    for order in orders:
        for entry in order:
            appearances[entry.player_id] = appearances.get(entry.player_id, 0) + 1
            positions.setdefault(entry.player_id, entry.position)

    eligible = {
        player_id
        for player_id, count in appearances.items()
        if count >= appearance_floor
    }
    values: Dict[str, List[int]] = {player_id: [] for player_id in eligible}
    actual_values: Dict[str, List[int]] = {player_id: [] for player_id in eligible}
    for order in orders:
        ranks = {entry.player_id: index for index, entry in enumerate(order, start=1)}
        imputed = len(order) + 1
        for player_id in eligible:
            value = ranks.get(player_id, imputed)
            values[player_id].append(value)
            if player_id in ranks:
                actual_values[player_id].append(value)

    ranked = sorted(
        eligible,
        key=lambda player_id: (
            sum(values[player_id]) / board_count,
            -appearances[player_id],
            player_id,
        ),
    )
    players = {
        player.player_id: player
        for player in db.query(FantasyPlayer)
        .filter(FantasyPlayer.player_id.in_(ranked))
        .all()
    } if ranked else {}

    seen: Dict[str, int] = {}
    result = []
    for overall_rank, player_id in enumerate(ranked, start=1):
        position = positions[player_id]
        seen[position] = seen.get(position, 0) + 1
        player = players.get(player_id)
        observed = actual_values[player_id]
        result.append(
            {
                "player_id": player_id,
                "name": player.full_name if player else None,
                "team": player.team if player else None,
                "position": position,
                "overallRank": overall_rank,
                "positionRank": seen[position],
                "averageRank": round(sum(values[player_id]) / board_count, 2),
                "best": min(observed) if observed else None,
                "worst": max(observed) if observed else None,
                "appearances": appearances[player_id],
                "boardCount": board_count,
            }
        )

    return {
        "season": season,
        "scoring": scoring,
        "roster": roster,
        "boardCount": board_count,
        "appearanceFloor": appearance_floor,
        "entries": result,
    }


# ── seeding ─────────────────────────────────────────────────────────────────

def _projection_points(db: Session, season: int, scoring: str) -> Dict[str, float]:
    """Season-long projected points per player, consensus first.

    Deliberately NOT read off the rankings rows. _build_rankings surfaces
    FantasyRanking.ecr as "projected_points", which happens to hold real points
    today because the derived collector is its only writer — but that column is
    documented as FantasyPros expert consensus, where a *lower* number is
    better. Subtracting a replacement baseline from a rank is nonsense, so take
    the order from rankings and the points from projections.
    """
    for source in (fantasy_data.CONSENSUS_SOURCE, None):
        data = fantasy_data.get_projections(
            db,
            season=season,
            week=SEASON_LONG_WEEK,
            position=None,
            scoring=scoring,
            source=source,
            limit=5000,
        )
        points = {
            row["player_id"]: row["projected_points"]
            for row in data.get("projections", [])
            if row.get("player_id") and row.get("projected_points") is not None
        }
        if points:
            return points
    return {}


def _stabilize_positions(order: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Force the seed to satisfy the invariant, whatever the points look like.

    Subtracting a per-position constant is monotone *within* a position, so VOR
    order and the site's positional order normally already agree. But that only
    holds while the site's ranks are themselves monotone in projected points,
    which is an accident of the current derived collector rather than a
    contract. So: keep the slots each position won, and refill them in the
    site's positional order. Usually a no-op, never wrong.
    """
    slots: Dict[str, List[int]] = {}
    for index, row in enumerate(order):
        slots.setdefault(row["position"], []).append(index)

    stabilized = list(order)
    for position, indices in slots.items():
        players = sorted(
            (order[i] for i in indices), key=lambda r: (r["source_rank"], r["player_id"])
        )
        for index, row in zip(indices, players):
            stabilized[index] = row
    return stabilized


def seed_order(db: Session, season: int, scoring: str, roster: str) -> Dict[str, Any]:
    """The order a fresh board starts in: value over replacement, descending."""
    caps = SEED_CAPS[roster]
    baselines = BASELINE_RANK[roster]
    priority = POSITION_PRIORITY[roster]
    points = _projection_points(db, season, scoring)

    by_position: Dict[str, List[Dict[str, Any]]] = {}
    as_of = None
    for position in RANKABLE_POSITIONS:
        data = fantasy_data.get_rankings(
            db,
            season=season,
            week=SEASON_LONG_WEEK,
            position=position,
            scoring=scoring,
            source=None,
            limit=caps[position],
        )
        as_of = as_of or data.get("as_of")
        rows = []
        for row in data.get("rankings", []):
            player_id = row.get("player_id")
            if not player_id or player_id not in points:
                # No projection means no defensible place in the order. He stays
                # addable by search; he just does not get seeded blind.
                continue
            rows.append(
                {
                    "player_id": player_id,
                    "position": position,
                    "source_rank": len(rows) + 1,
                    "points": float(points[player_id]),
                }
            )
        by_position[position] = rows

    combined: List[Dict[str, Any]] = []
    for position, rows in by_position.items():
        if not rows:
            continue
        baseline_index = min(baselines[position], len(rows)) - 1
        baseline_points = rows[baseline_index]["points"]
        for row in rows:
            row["vor"] = row["points"] - baseline_points
            combined.append(row)

    combined.sort(
        key=lambda r: (
            -r["vor"],
            r["source_rank"],
            priority.get(r["position"], 9),
            r["player_id"],
        )
    )
    ordered = _stabilize_positions(combined)

    run = latest_successful_run(db, "rankings", season, SEASON_LONG_WEEK)
    return {
        "order": ordered,
        "seeded_from": f"derived:{season}:{SEASON_LONG_WEEK}" if ordered else None,
        "seed_run_id": run.id if run is not None else None,
        "as_of": as_of,
    }


def _write_seed(db: Session, board: FantasyRankBoard) -> None:
    seed = seed_order(db, board.season, board.scoring, board.roster)
    for index, row in enumerate(seed["order"], start=1):
        db.add(
            FantasyRankEntry(
                board_id=board.id,
                player_id=row["player_id"],
                position=row["position"],
                sort_key=index * KEY_STEP,
                seed_rank=index,
            )
        )
    board.seeded_from = seed["seeded_from"]
    board.seed_run_id = seed["seed_run_id"]


# ── player search ───────────────────────────────────────────────────────────

def search_rankable_players(
    db: Session,
    query: str,
    season: Optional[int],
    scoring: str = "ppr",
    limit: int = 12,
) -> List[Dict[str, Any]]:
    """Search the pool a board actually cares about, best players first.

    The shared /api/fantasy/players/search now ranks by projection too, so the
    difference is no longer the ordering: this one takes the board's own
    scoring and season rather than the site default, drops the positions a
    board cannot hold, and returns the projected points the row renders.
    Anyone without a projection still appears, just below everyone who has
    one, so a deep-league flyer is still addable.
    """
    from app.database import FantasyPlayer as _Player  # local: keeps the import list flat

    term = (query or "").strip().lower()
    if len(term) < 2:
        return []

    rows = (
        db.query(_Player)
        .filter(
            _Player.search_name.like(f"%{term}%"),
            _Player.position.in_(RANKABLE_POSITIONS),
        )
        .limit(200)
        .all()
    )
    if not rows:
        return []

    if season is None:
        season = fantasy_data.default_context(db)["season"] or utc_now().year
    points = _projection_points(db, season, normalize_scoring(scoring))

    def sort_key(player):
        projected = points.get(player.player_id)
        return (
            0 if projected is not None else 1,
            -(projected or 0.0),
            player.full_name or "",
        )

    rows.sort(key=sort_key)
    return [
        {
            "player_id": player.player_id,
            "name": player.full_name,
            "team": player.team,
            "position": player.position,
            "injury_status": player.injury_status,
            "projected_points": points.get(player.player_id),
        }
        for player in rows[:limit]
    ]


# ── board lifecycle ─────────────────────────────────────────────────────────

def create_board(
    db: Session,
    identity: Dict[str, Any],
    season: Optional[int],
    scoring: str,
    roster: str,
    title: Optional[str],
) -> FantasyRankBoard:
    username, display_name = identity_names(identity)
    scoring = normalize_scoring(scoring)
    roster = normalize_roster(roster)
    if season is None:
        # An empty database has no collected state to read a season off, and a
        # board still has to be creatable — otherwise the page is unusable
        # before the first collection run.
        season = fantasy_data.default_context(db)["season"] or utc_now().year

    existing = (
        db.query(FantasyRankBoard)
        .filter(
            FantasyRankBoard.username == username,
            FantasyRankBoard.season == season,
            FantasyRankBoard.scoring == scoring,
            FantasyRankBoard.roster == roster,
        )
        .first()
    )
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "You already have a board for that season and format.",
                "boardId": existing.id,
            },
        )

    board = FantasyRankBoard(
        username=username,
        display_name=display_name or username,
        season=season,
        scoring=scoring,
        roster=roster,
        title=(title or "").strip() or None,
        share_slug=secrets.token_urlsafe(9),
    )
    db.add(board)
    db.flush()
    _write_seed(db, board)
    db.commit()
    db.refresh(board)
    return board


def reset_board(db: Session, board: FantasyRankBoard) -> FantasyRankBoard:
    db.query(FantasyRankEntry).filter(FantasyRankEntry.board_id == board.id).delete()
    db.query(FantasyRankTier).filter(FantasyRankTier.board_id == board.id).delete()
    _write_seed(db, board)
    _touch(board)
    _commit_board_write(db, board)
    db.refresh(board)
    return board


def update_board(
    db: Session,
    board: FantasyRankBoard,
    title: Optional[str],
    published: Optional[bool],
) -> FantasyRankBoard:
    if title is not None:
        board.title = title.strip() or None
    if published is not None and bool(published) != bool(board.published):
        board.published = bool(published)
        board.published_at = utc_now() if published else None
    _touch(board)
    _commit_board_write(db, board)
    db.refresh(board)
    return board


def delete_board(db: Session, board: FantasyRankBoard) -> None:
    # Explicit child deletes: SQLite does not enforce ON DELETE CASCADE unless
    # the pragma is on, and the ORM has no relationship() configured here.
    db.query(FantasyRankEntry).filter(FantasyRankEntry.board_id == board.id).delete()
    db.query(FantasyRankTier).filter(FantasyRankTier.board_id == board.id).delete()
    db.delete(board)
    _commit_board_write(db, board)


def _touch(board: FantasyRankBoard) -> None:
    # Mark the versioned board dirty; SQLAlchemy advances ``revision`` during
    # flush with the previous revision in the UPDATE predicate.
    board.updated_at = utc_now()


# ── ordering ────────────────────────────────────────────────────────────────

def _target_index(
    scoped: Sequence[FantasyRankEntry],
    before_player_id: Optional[str],
    after_player_id: Optional[str],
    to_rank: Optional[int],
) -> int:
    """Where in `scoped` (which excludes the moved row) the player should land.

    Moves arrive as intent — "above this player", "below this player", "at rank
    N" — never as keys. The client has no business doing key arithmetic: it
    would need the full neighbor set and would race anything else in flight.
    """
    ids = [e.player_id for e in scoped]
    if before_player_id is not None:
        if before_player_id not in ids:
            raise HTTPException(status_code=422, detail="That player is not on this list.")
        return ids.index(before_player_id)
    if after_player_id is not None:
        if after_player_id not in ids:
            raise HTTPException(status_code=422, detail="That player is not on this list.")
        return ids.index(after_player_id) + 1
    if to_rank is not None:
        return max(0, min(int(to_rank) - 1, len(scoped)))
    return len(scoped)


def _resolve_neighbors(
    entries: Sequence[FantasyRankEntry],
    scope: str,
    moved_player_id: Optional[str],
    target_index: int,
) -> Tuple[Optional[str], Optional[str]]:
    """Translate a move inside `scope` into a pair of overall neighbours.

    For the overall list this is just the two rows either side of the slot. For
    a positional list it is the step that makes the invariant hold by
    construction: landing at positional index i means landing immediately above
    whoever currently holds that positional slot, wherever he happens to sit
    overall. That is the only placement that changes this player's order
    relative to his own position and nothing else.
    """
    remaining = [e for e in entries if e.player_id != moved_player_id]
    scoped = _scope_entries(remaining, scope)

    if scope == "OVERALL":
        predecessor = remaining[target_index - 1] if target_index > 0 else None
        follower = remaining[target_index] if target_index < len(remaining) else None
        return (
            predecessor.player_id if predecessor else None,
            follower.player_id if follower else None,
        )

    if not scoped:
        # Only player at his position: nothing constrains him, so append.
        tail = remaining[-1] if remaining else None
        return (tail.player_id if tail else None, None)

    if target_index >= len(scoped):
        anchor = scoped[-1]
        index = remaining.index(anchor)
        follower = remaining[index + 1] if index + 1 < len(remaining) else None
        return (anchor.player_id, follower.player_id if follower else None)

    anchor = scoped[target_index]
    index = remaining.index(anchor)
    predecessor = remaining[index - 1] if index > 0 else None
    return (predecessor.player_id if predecessor else None, anchor.player_id)


def _midpoint(
    entries: Sequence[FantasyRankEntry], prev_id: Optional[str], next_id: Optional[str]
) -> Optional[float]:
    """The key between two rows, or None when the gap has been used up."""
    keys = {e.player_id: e.sort_key for e in entries}
    return _midpoint_values(
        keys.get(prev_id) if prev_id else None,
        keys.get(next_id) if next_id else None,
    )


def _midpoint_values(low: Optional[float], high: Optional[float]) -> Optional[float]:
    if low is None and high is None:
        return KEY_STEP
    if low is None:
        return high - KEY_STEP
    if high is None:
        return low + KEY_STEP
    if high - low < MIN_GAP:
        return None
    return (low + high) / 2.0


def renormalize(db: Session, board_id: int) -> None:
    """Respread every key to 1000, 2000, ... preserving the current order.

    Float midpoints run out after about thirty insertions into the same gap.
    Rather than encode ordering as strings to dodge that, take the rare
    three-hundred-row rewrite: it is cheap, obviously correct, and the client is
    told to accept the server's order wholesale afterwards. Tiers share the key
    space, so they are respread in the same pass or they would jump.
    """
    entries = _entries(db, board_id)
    tiers = _tiers(db, board_id)
    combined = sorted(
        [(e.sort_key, 0, e) for e in entries] + [(t.sort_key, 1, t) for t in tiers],
        key=lambda row: (row[0], row[1]),
    )
    for index, (_key, _kind, row) in enumerate(combined, start=1):
        row.sort_key = index * KEY_STEP
    db.flush()


def _apply_move(
    db: Session,
    board: FantasyRankBoard,
    row,
    scope: str,
    before_player_id: Optional[str],
    after_player_id: Optional[str],
    to_rank: Optional[int],
    moved_player_id: Optional[str],
) -> bool:
    """Place `row` (an entry or a tier) at the requested slot. True if respread."""
    entries = _entries(db, board.id)
    scoped = [e for e in _scope_entries(entries, scope) if e.player_id != moved_player_id]
    index = _target_index(scoped, before_player_id, after_player_id, to_rank)
    prev_id, next_id = _resolve_neighbors(entries, scope, moved_player_id, index)

    key = _midpoint(entries, prev_id, next_id)
    renormalized = False
    if key is None:
        renormalize(db, board.id)
        renormalized = True
        # Renormalization preserves order, so the neighbour ids are still the
        # right ones — only their keys moved.
        key = _midpoint(_entries(db, board.id), prev_id, next_id)
    row.sort_key = key
    return renormalized


def _apply_move_beside_tier(
    db: Session,
    board: FantasyRankBoard,
    row: FantasyRankEntry,
    scope: str,
    tier_id: int,
    place_after: bool,
) -> bool:
    """Place an entry immediately before/after a rendered tier divider.

    Dense player rank alone cannot express crossing a divider without passing
    another player. Pointer drops therefore carry the tier boundary explicitly.
    The key is chosen in the complete board key space so unrelated scoped tiers
    and entries keep their relative positions.
    """
    tier = _tier(db, board, tier_id)
    if tier.scope != scope:
        raise HTTPException(status_code=422, detail="That tier belongs to another list.")

    def neighbors() -> Tuple[Optional[float], Optional[float]]:
        combined = sorted(
            [
                (entry.sort_key, 0, entry.id, entry)
                for entry in _entries(db, board.id)
                if entry.player_id != row.player_id
            ]
            + [(item.sort_key, 1, item.id, item) for item in _tiers(db, board.id)],
            key=lambda item: (item[0], item[1], item[2]),
        )
        anchor = next(
            (
                index
                for index, item in enumerate(combined)
                if isinstance(item[3], FantasyRankTier) and item[3].id == tier.id
            ),
            None,
        )
        if anchor is None:
            raise HTTPException(status_code=404, detail="No such tier on this board.")
        if place_after:
            low = combined[anchor][0]
            high = combined[anchor + 1][0] if anchor + 1 < len(combined) else None
        else:
            low = combined[anchor - 1][0] if anchor > 0 else None
            high = combined[anchor][0]
        return low, high

    low, high = neighbors()
    key = _midpoint_values(low, high)
    renormalized = False
    if key is None:
        renormalize(db, board.id)
        renormalized = True
        low, high = neighbors()
        key = _midpoint_values(low, high)
    row.sort_key = key
    return renormalized


def move_entry(
    db: Session,
    board: FantasyRankBoard,
    player_id: str,
    scope: str,
    before_player_id: Optional[str] = None,
    after_player_id: Optional[str] = None,
    to_rank: Optional[int] = None,
    before_tier_id: Optional[int] = None,
    after_tier_id: Optional[int] = None,
) -> Dict[str, Any]:
    entry = (
        db.query(FantasyRankEntry)
        .filter(
            FantasyRankEntry.board_id == board.id,
            FantasyRankEntry.player_id == player_id,
        )
        .first()
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="That player is not on this board.")
    if scope != "OVERALL" and entry.position != scope:
        raise HTTPException(
            status_code=422, detail=f"{entry.position} players cannot move in the {scope} list."
        )

    if before_tier_id is not None or after_tier_id is not None:
        tier_id = before_tier_id if before_tier_id is not None else after_tier_id
        assert tier_id is not None
        renormalized = _apply_move_beside_tier(
            db,
            board,
            entry,
            scope,
            tier_id,
            place_after=after_tier_id is not None,
        )
    else:
        renormalized = _apply_move(
            db, board, entry, scope, before_player_id, after_player_id, to_rank, player_id
        )
    _touch(board)
    _commit_board_write(db, board)
    return move_result(db, board, player_id, renormalized)


def add_entry(
    db: Session,
    board: FantasyRankBoard,
    player_id: str,
    scope: str,
    before_player_id: Optional[str] = None,
    to_rank: Optional[int] = None,
) -> Dict[str, Any]:
    player = (
        db.query(FantasyPlayer).filter(FantasyPlayer.player_id == player_id).first()
    )
    if player is None:
        raise HTTPException(status_code=404, detail="No such player.")
    if player.position not in RANKABLE_POSITIONS:
        raise HTTPException(
            status_code=422, detail="Boards cover QB, RB, WR and TE only."
        )
    existing = (
        db.query(FantasyRankEntry)
        .filter(
            FantasyRankEntry.board_id == board.id,
            FantasyRankEntry.player_id == player_id,
        )
        .first()
    )
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"{player.full_name} is already on this board.")
    if scope != "OVERALL" and scope != player.position:
        raise HTTPException(
            status_code=422, detail=f"{player.full_name} is a {player.position}."
        )

    entry = FantasyRankEntry(
        board_id=board.id,
        player_id=player_id,
        position=player.position,
        sort_key=0.0,
    )
    db.add(entry)
    db.flush()
    renormalized = _apply_move(
        db, board, entry, scope, before_player_id, None, to_rank, player_id
    )
    _touch(board)
    _commit_board_write(db, board)
    return move_result(db, board, player_id, renormalized)


def remove_entry(db: Session, board: FantasyRankBoard, player_id: str) -> Dict[str, Any]:
    deleted = (
        db.query(FantasyRankEntry)
        .filter(
            FantasyRankEntry.board_id == board.id,
            FantasyRankEntry.player_id == player_id,
        )
        .delete()
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="That player is not on this board.")
    _touch(board)
    _commit_board_write(db, board)
    return move_result(db, board, None, False)


# ── tiers ───────────────────────────────────────────────────────────────────

def _tier(db: Session, board: FantasyRankBoard, tier_id: int) -> FantasyRankTier:
    tier = (
        db.query(FantasyRankTier)
        .filter(
            FantasyRankTier.id == tier_id,
            FantasyRankTier.board_id == board.id,
        )
        .first()
    )
    if tier is None:
        raise HTTPException(status_code=404, detail="No such tier on this board.")
    return tier


def _tier_label(label: str) -> str:
    value = (label or "").strip()
    if not value:
        raise HTTPException(status_code=422, detail="A tier needs a name.")
    return value


def create_tier(
    db: Session,
    board: FantasyRankBoard,
    scope: str,
    label: str,
    before_player_id: Optional[str] = None,
    after_player_id: Optional[str] = None,
    to_rank: Optional[int] = None,
) -> Dict[str, Any]:
    tier = FantasyRankTier(
        board_id=board.id,
        scope=scope,
        label=_tier_label(label),
        sort_key=0.0,
    )
    db.add(tier)
    db.flush()
    renormalized = _apply_move(
        db, board, tier, scope, before_player_id, after_player_id, to_rank, None
    )
    _touch(board)
    _commit_board_write(db, board)
    result = move_result(db, board, None, renormalized)
    result["tierId"] = tier.id
    return result


def update_tier(
    db: Session,
    board: FantasyRankBoard,
    tier_id: int,
    label: Optional[str] = None,
    before_player_id: Optional[str] = None,
    after_player_id: Optional[str] = None,
    to_rank: Optional[int] = None,
    move_requested: bool = False,
) -> Dict[str, Any]:
    tier = _tier(db, board, tier_id)
    if label is None and not move_requested:
        raise HTTPException(status_code=422, detail="Change the tier name or its position.")
    if label is not None:
        tier.label = _tier_label(label)
    renormalized = False
    if move_requested:
        renormalized = _apply_move(
            db,
            board,
            tier,
            tier.scope,
            before_player_id,
            after_player_id,
            to_rank,
            None,
        )
    _touch(board)
    _commit_board_write(db, board)
    return move_result(db, board, None, renormalized)


def delete_tier(
    db: Session, board: FantasyRankBoard, tier_id: int
) -> Dict[str, Any]:
    tier = _tier(db, board, tier_id)
    db.delete(tier)
    _touch(board)
    _commit_board_write(db, board)
    return move_result(db, board, None, False)


def move_result(
    db: Session,
    board: FantasyRankBoard,
    moved_player_id: Optional[str],
    renormalized: bool,
) -> Dict[str, Any]:
    """What every write returns: the full derived rank map, not a delta.

    The server has already run this query, and handing back every rank removes
    the last place where the client could get rank arithmetic wrong.
    """
    entries = _entries(db, board.id)
    seen: Dict[str, int] = {}
    ranks: Dict[str, List[int]] = {}
    for overall_rank, entry in enumerate(entries, start=1):
        seen[entry.position] = seen.get(entry.position, 0) + 1
        ranks[entry.player_id] = [overall_rank, seen[entry.position]]

    moved = None
    if moved_player_id and moved_player_id in ranks:
        moved = {
            "player_id": moved_player_id,
            "overallRank": ranks[moved_player_id][0],
            "positionRank": ranks[moved_player_id][1],
        }

    return {
        "revision": board.revision,
        "renormalized": renormalized,
        "moved": moved,
        "ranks": ranks,
        "tiers": _serialize_tiers(_tiers(db, board.id), entries),
    }
