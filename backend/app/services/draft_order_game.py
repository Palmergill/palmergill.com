"""Server-authoritative Fourth & Fortune draft-order game.

Every player gets a deterministic 52-card deck derived from the committed
master seed and their normalized account name. A player's three rounds consume
that deck continuously. The seed remains private until the room completes, at
which point the verification endpoint exposes everything needed to reproduce
the deal.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import uuid
from collections import defaultdict
from typing import Any, Iterable

from fastapi import HTTPException
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import accounts
from app.database import (
    FantasyDraftFlip,
    FantasyDraftPlayer,
    FantasyDraftRound,
    FantasyDraftSession,
    utc_now,
)

GAME_VERSION = "fourth-and-fortune-v1"
ROUNDS_PER_PLAYER = 3
# A round is over once it is banked, busted, or written off by the host when a
# manager walks away mid-draft. Forfeited rounds score zero and hold no cards.
FINISHED_ROUND_STATES = frozenset({"banked", "busted", "forfeited"})
MIN_PLAYERS = 2
MAX_PLAYERS = 16
MODE_LEAGUE = "league"
MODE_PRACTICE = "practice"
MODE_TEST = "test"
ROOM_MODES = frozenset({MODE_LEAGUE, MODE_PRACTICE, MODE_TEST})
BOT_NAMES = (
    "Ace Bot",
    "Blitz Bot",
    "Clover Bot",
    "Dime Bot",
    "End Zone Bot",
    "Fumble Bot",
    "Gridiron Bot",
    "Huddle Bot",
    "Iceman Bot",
    "Juke Bot",
    "Kickoff Bot",
    "Lombardi Bot",
    "Mascot Bot",
    "Nickel Bot",
    "Overtime Bot",
)
JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
SUITS = ("C", "D", "H", "S")
RANKS = tuple(str(value) for value in range(2, 11)) + ("J", "Q", "K", "A")
RANK_VALUES = {str(value): value for value in range(2, 11)} | {
    "J": 11,
    "Q": 12,
    "K": 13,
    "A": 14,
}
SUIT_NAMES = {"C": "clubs", "D": "diamonds", "H": "hearts", "S": "spades"}
SUIT_SYMBOLS = {"C": "♣", "D": "♦", "H": "♥", "S": "♠"}


def _identity_names(identity: dict[str, str]) -> tuple[str, str]:
    display_name = str(identity.get("username", "")).strip()
    username = accounts.normalize_username(display_name)
    if not username:
        raise HTTPException(status_code=401, detail="Sign in to play.")
    return username, display_name


def _master_seed_bytes(master_seed: str) -> bytes:
    return bytes.fromhex(master_seed)


def seed_commitment(master_seed: str) -> str:
    """SHA-256 of the raw 32-byte seed, encoded as lowercase hex."""
    return hashlib.sha256(_master_seed_bytes(master_seed)).hexdigest()


def _context_key(master_seed: str, context: str) -> bytes:
    return hmac.new(
        _master_seed_bytes(master_seed),
        context.encode("utf-8"),
        hashlib.sha256,
    ).digest()


class _HmacRandom:
    """Small deterministic CSPRNG stream with unbiased ``randbelow``."""

    def __init__(self, key: bytes):
        self.key = key
        self.counter = 0

    def _uint64(self) -> int:
        digest = hmac.new(
            self.key,
            self.counter.to_bytes(8, "big"),
            hashlib.sha256,
        ).digest()
        self.counter += 1
        return int.from_bytes(digest[:8], "big")

    def randbelow(self, upper: int) -> int:
        if upper <= 0:
            raise ValueError("upper must be positive")
        span = 1 << 64
        ceiling = span - (span % upper)
        while True:
            value = self._uint64()
            if value < ceiling:
                return value % upper


def _shuffle(values: Iterable[Any], master_seed: str, context: str) -> list[Any]:
    shuffled = list(values)
    random_stream = _HmacRandom(_context_key(master_seed, context))
    for index in range(len(shuffled) - 1, 0, -1):
        swap_index = random_stream.randbelow(index + 1)
        shuffled[index], shuffled[swap_index] = shuffled[swap_index], shuffled[index]
    return shuffled


def canonical_deck() -> list[str]:
    return [f"{rank}{suit}" for rank in RANKS for suit in SUITS]


def derive_player_deck(master_seed: str, username: str) -> list[str]:
    normalized = accounts.normalize_username(username)
    return _shuffle(canonical_deck(), master_seed, f"deck:v1:{normalized}")


def derive_turn_order(master_seed: str, usernames: Iterable[str]) -> list[str]:
    normalized = sorted(accounts.normalize_username(name) for name in usernames)
    return _shuffle(normalized, master_seed, "turn-order:v1")


def tie_break_value(master_seed: str, username: str) -> int:
    digest = hmac.new(
        _master_seed_bytes(master_seed),
        f"tiebreak:v1:{accounts.normalize_username(username)}".encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return int.from_bytes(digest[:8], "big")


def _card_rank(code: str) -> str:
    return code[:-1]


def card_value(code: str) -> int:
    return RANK_VALUES[_card_rank(code)]


def card_payload(code: str, deck_index: int | None = None) -> dict[str, Any]:
    suit = code[-1]
    payload: dict[str, Any] = {
        "code": code,
        "rank": _card_rank(code),
        "suit": SUIT_NAMES[suit],
        "symbol": SUIT_SYMBOLS[suit],
        "value": card_value(code),
        "red": suit in {"D", "H"},
    }
    if deck_index is not None:
        payload["deckIndex"] = deck_index
    return payload


def _new_join_code(db: Session) -> str:
    for _ in range(24):
        code = "".join(secrets.choice(JOIN_CODE_ALPHABET) for _ in range(6))
        exists = db.query(FantasyDraftSession.id).filter(FantasyDraftSession.join_code == code).first()
        if not exists:
            return code
    raise HTTPException(status_code=503, detail="Couldn't create a room code. Try again.")


def _session_or_404(db: Session, session_id: str, *, lock: bool = False) -> FantasyDraftSession:
    query = db.query(FantasyDraftSession).filter(FantasyDraftSession.id == session_id)
    if lock:
        query = query.with_for_update()
    room = query.first()
    if room is None:
        raise HTTPException(status_code=404, detail="Draft room not found.")
    return room


def _players(db: Session, session_id: str) -> list[FantasyDraftPlayer]:
    return (
        db.query(FantasyDraftPlayer)
        .filter(FantasyDraftPlayer.session_id == session_id)
        .order_by(FantasyDraftPlayer.joined_at, FantasyDraftPlayer.id)
        .all()
    )


def _rounds(db: Session, session_id: str) -> list[FantasyDraftRound]:
    return (
        db.query(FantasyDraftRound)
        .filter(FantasyDraftRound.session_id == session_id)
        .order_by(FantasyDraftRound.round_number, FantasyDraftRound.started_at)
        .all()
    )


def _player_flips(db: Session, player_id: str) -> list[FantasyDraftFlip]:
    return (
        db.query(FantasyDraftFlip)
        .filter(FantasyDraftFlip.player_id == player_id)
        .order_by(FantasyDraftFlip.deck_index)
        .all()
    )


def _cards(round_row: FantasyDraftRound) -> list[str]:
    try:
        value = json.loads(round_row.cards_json or "[]")
    except (TypeError, json.JSONDecodeError):
        return []
    return [str(card) for card in value if isinstance(card, str)]


def _round_score_total(rounds: list[FantasyDraftRound]) -> int:
    return sum(row.score for row in rounds if row.state in FINISHED_ROUND_STATES)


def _best_round(rounds: list[FantasyDraftRound]) -> int:
    return max(
        (row.score for row in rounds if row.state in FINISHED_ROUND_STATES),
        default=0,
    )


def _active_round(rounds: list[FantasyDraftRound]) -> FantasyDraftRound | None:
    return next((row for row in rounds if row.state == "active"), None)


def _round_payload(round_row: FantasyDraftRound) -> dict[str, Any]:
    return {
        "number": round_row.round_number,
        "cards": [card_payload(code) for code in _cards(round_row)],
        "score": round_row.score,
        "busted": bool(round_row.busted),
        "state": round_row.state,
    }


def standing_key(
    score: int,
    best_round: int,
    master_seed: str,
    username: str,
) -> tuple[int, int, int]:
    """The one ranking rule: total, then best round, then the seeded tiebreak.

    The live standings and the final draft order both sort on this. They used
    to disagree — the standings fell back to turn position on a tie — so a
    manager could watch themselves hold first place and then be handed the
    second pick.
    """
    return (-score, -best_round, -tie_break_value(master_seed, username))


def _final_order(
    players: list[FantasyDraftPlayer],
    rounds_by_player: dict[str, list[FantasyDraftRound]],
    master_seed: str,
) -> list[FantasyDraftPlayer]:
    return sorted(
        players,
        key=lambda player: standing_key(
            player.final_score,
            _best_round(rounds_by_player[player.id]),
            master_seed,
            player.username,
        ),
    )


def _bust_chance(
    room: FantasyDraftSession,
    player: FantasyDraftPlayer,
    active_round: FantasyDraftRound | None,
    flips_used: int,
) -> float:
    if active_round is None:
        return 0.0
    held_ranks = {_card_rank(code) for code in _cards(active_round)}
    deck = derive_player_deck(room.master_seed, player.username)
    remaining = deck[flips_used:]
    if not remaining or not held_ranks:
        return 0.0
    danger = sum(1 for code in remaining if _card_rank(code) in held_ranks)
    return round((danger / len(remaining)) * 100, 1)


def serialize_session(
    db: Session,
    room: FantasyDraftSession,
    viewer_username: str | None,
) -> dict[str, Any]:
    players = _players(db, room.id)
    all_rounds = _rounds(db, room.id)
    rounds_by_player: dict[str, list[FantasyDraftRound]] = defaultdict(list)
    for round_row in all_rounds:
        rounds_by_player[round_row.player_id].append(round_row)

    viewer_normalized = accounts.normalize_username(viewer_username)
    current_player = next((player for player in players if player.id == room.current_player_id), None)
    player_payloads = []
    scores: dict[str, int] = {}
    for player in players:
        player_rounds = rounds_by_player[player.id]
        score = player.final_score if room.state == "complete" else _round_score_total(player_rounds)
        scores[player.id] = score
        player_payloads.append({
            "id": player.id,
            "username": player.username,
            "displayName": player.display_name,
            "turnPosition": player.turn_position,
            "score": score,
            "bestRound": _best_round(player_rounds),
            "roundsCompleted": sum(
                1 for row in player_rounds if row.state in FINISHED_ROUND_STATES
            ),
            "rounds": [_round_payload(row) for row in player_rounds],
            "isCurrent": player.id == room.current_player_id,
            "isHost": player.username == room.created_by,
            "isBot": bool(player.is_bot),
        })

    leaderboard = sorted(
        player_payloads,
        key=lambda player: standing_key(
            player["score"],
            player["bestRound"],
            room.master_seed,
            player["username"],
        ),
    )
    for place, player in enumerate(leaderboard, start=1):
        player["place"] = place

    current_round_payload = None
    decision = None
    if current_player is not None:
        current_round = _active_round(rounds_by_player[current_player.id])
        flips_used = db.query(func.count(FantasyDraftFlip.id)).filter(
            FantasyDraftFlip.player_id == current_player.id
        ).scalar() or 0
        completed = sum(
            1
            for row in rounds_by_player[current_player.id]
            if row.state in {"banked", "busted"}
        )
        if current_round is None:
            current_round_payload = {
                "number": min(completed + 1, ROUNDS_PER_PLAYER),
                "cards": [],
                "pot": 0,
                "bustChance": 0.0,
                "deckRemaining": 52 - flips_used,
            }
        else:
            current_round_payload = {
                "number": current_round.round_number,
                "cards": [card_payload(code) for code in _cards(current_round)],
                "pot": current_round.score,
                "bustChance": _bust_chance(room, current_player, current_round, flips_used),
                "deckRemaining": 52 - flips_used,
            }

        projected_score = scores[current_player.id] + current_round_payload["pot"]
        hypothetical = dict(scores)
        hypothetical[current_player.id] = projected_score
        projected_order = sorted(
            players,
            key=lambda player: (
                -hypothetical[player.id],
                player.turn_position if player.turn_position is not None else MAX_PLAYERS + 1,
            ),
        )
        bank_position = next(
            index for index, player in enumerate(projected_order, start=1) if player.id == current_player.id
        )
        other_scores = [score for player_id, score in scores.items() if player_id != current_player.id]
        score_to_beat = max(other_scores, default=0)
        decision = {
            "projectedScore": projected_score,
            "bankPosition": bank_position,
            "scoreToBeat": score_to_beat,
            "isLeadingIfBanked": projected_score > score_to_beat,
        }

    draft_order = None
    if room.state == "complete":
        draft_order = []
        for pick, player in enumerate(_final_order(players, rounds_by_player, room.master_seed), start=1):
            draft_order.append({
                "pick": pick,
                "playerId": player.id,
                "displayName": player.display_name,
                "score": player.final_score,
                "bestRound": _best_round(rounds_by_player[player.id]),
                "isBot": bool(player.is_bot),
            })

    member = next((player for player in players if player.username == viewer_normalized), None)
    return {
        "id": room.id,
        "leagueName": room.league_name,
        "mode": room.mode or MODE_LEAGUE,
        "joinCode": (
            room.join_code
            if member is not None and room.mode == MODE_LEAGUE
            else None
        ),
        "seedHash": room.seed_hash,
        "state": room.state,
        "roundsPerPlayer": ROUNDS_PER_PLAYER,
        "createdAt": room.created_at.isoformat() if room.created_at else None,
        "startedAt": room.started_at.isoformat() if room.started_at else None,
        "completedAt": room.completed_at.isoformat() if room.completed_at else None,
        "isHost": viewer_normalized == room.created_by,
        "isMember": member is not None,
        "canStart": viewer_normalized == room.created_by and room.state == "lobby" and len(players) >= MIN_PLAYERS,
        "canPlay": bool(
            member is not None
            and current_player is not None
            and member.id == current_player.id
            and room.state == "active"
        ),
        "canForfeit": bool(
            viewer_normalized == room.created_by
            and room.state == "active"
            and current_player is not None
        ),
        "canRunBot": bool(
            viewer_normalized == room.created_by
            and room.mode == MODE_TEST
            and room.state == "active"
            and current_player is not None
            and current_player.is_bot
        ),
        "currentPlayer": (
            {
                "id": current_player.id,
                "displayName": current_player.display_name,
                "turnPosition": current_player.turn_position,
                "isBot": bool(current_player.is_bot),
            }
            if current_player is not None
            else None
        ),
        "currentRound": current_round_payload,
        "decision": decision,
        "players": player_payloads,
        "leaderboard": leaderboard,
        "draftOrder": draft_order,
    }


def create_session(
    db: Session,
    identity: dict[str, str],
    league_name: str,
    *,
    mode: str = MODE_LEAGUE,
) -> FantasyDraftSession:
    username, display_name = _identity_names(identity)
    cleaned_name = " ".join(league_name.split())
    if len(cleaned_name) < 3 or len(cleaned_name) > 60:
        raise HTTPException(status_code=400, detail="League name must be 3–60 characters.")
    if mode not in ROOM_MODES:
        raise ValueError(f"Unsupported draft room mode: {mode}")

    master_seed = secrets.token_hex(32)
    room = FantasyDraftSession(
        id=str(uuid.uuid4()),
        league_name=cleaned_name,
        join_code=_new_join_code(db),
        master_seed=master_seed,
        seed_hash=seed_commitment(master_seed),
        mode=mode,
        state="lobby",
        created_by=username,
    )
    db.add(room)
    # These models deliberately do not define ORM relationships. Without an
    # explicit flush SQLAlchemy may insert the host player before the room;
    # PostgreSQL then rejects the player's session_id foreign key. Persist the
    # parent row first so every supported database sees a valid room ID.
    db.flush()
    db.add(FantasyDraftPlayer(
        id=str(uuid.uuid4()),
        session_id=room.id,
        username=username,
        display_name=display_name,
        is_bot=False,
    ))
    db.commit()
    db.refresh(room)
    return room


def create_practice_session(db: Session, identity: dict[str, str]) -> FantasyDraftSession:
    """Create or resume a private three-round solo warm-up."""
    username, display_name = _identity_names(identity)
    existing = (
        db.query(FantasyDraftSession)
        .join(FantasyDraftPlayer, FantasyDraftPlayer.session_id == FantasyDraftSession.id)
        .filter(
            FantasyDraftSession.mode == MODE_PRACTICE,
            FantasyDraftSession.created_by == username,
            FantasyDraftSession.state.in_(("lobby", "active")),
            FantasyDraftPlayer.username == username,
        )
        .order_by(FantasyDraftSession.created_at.desc())
        .first()
    )
    if existing is not None:
        if existing.state == "lobby":
            player = db.query(FantasyDraftPlayer).filter(
                FantasyDraftPlayer.session_id == existing.id,
                FantasyDraftPlayer.username == username,
            ).one()
            player.turn_position = 1
            existing.current_player_id = player.id
            existing.state = "active"
            existing.started_at = utc_now()
            db.commit()
            db.refresh(existing)
        return existing

    room = create_session(
        db,
        identity,
        f"{display_name} practice",
        mode=MODE_PRACTICE,
    )
    player = db.query(FantasyDraftPlayer).filter(
        FantasyDraftPlayer.session_id == room.id,
        FantasyDraftPlayer.username == username,
    ).one()
    player.turn_position = 1
    room.current_player_id = player.id
    room.state = "active"
    room.started_at = utc_now()
    db.commit()
    db.refresh(room)
    return room


def create_test_session(
    db: Session,
    identity: dict[str, str],
    league_name: str,
    bot_count: int,
) -> FantasyDraftSession:
    """Create an admin-only production test room with marked bot players."""
    if identity.get("role") != accounts.ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="Only the site admin can create bot test rooms.")
    if bot_count < 1 or bot_count > len(BOT_NAMES):
        raise HTTPException(
            status_code=400,
            detail=f"Choose between 1 and {len(BOT_NAMES)} bot opponents.",
        )

    room = create_session(db, identity, league_name, mode=MODE_TEST)
    for index, display_name in enumerate(BOT_NAMES[:bot_count], start=1):
        db.add(FantasyDraftPlayer(
            id=str(uuid.uuid4()),
            session_id=room.id,
            username=f"__bot_{index:02d}",
            display_name=display_name,
            is_bot=True,
        ))
    db.commit()
    db.refresh(room)
    return room


def join_session(db: Session, identity: dict[str, str], join_code: str) -> FantasyDraftSession:
    username, display_name = _identity_names(identity)
    code = "".join(str(join_code).upper().split())
    room = (
        db.query(FantasyDraftSession)
        .filter(FantasyDraftSession.join_code == code)
        .with_for_update()
        .first()
    )
    if room is None:
        raise HTTPException(status_code=404, detail="That room code doesn't exist.")
    if room.mode != MODE_LEAGUE:
        raise HTTPException(status_code=409, detail="That room isn't open to league managers.")
    if room.state != "lobby":
        raise HTTPException(status_code=409, detail="That draft room has already started.")
    existing = db.query(FantasyDraftPlayer).filter(
        FantasyDraftPlayer.session_id == room.id,
        FantasyDraftPlayer.username == username,
    ).first()
    if existing:
        return room
    player_count = db.query(func.count(FantasyDraftPlayer.id)).filter(
        FantasyDraftPlayer.session_id == room.id
    ).scalar() or 0
    if player_count >= MAX_PLAYERS:
        raise HTTPException(status_code=409, detail="That draft room is full.")

    db.add(FantasyDraftPlayer(
        id=str(uuid.uuid4()),
        session_id=room.id,
        username=username,
        display_name=display_name,
        is_bot=False,
    ))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        # A double-click or two browser tabs racing to join should be
        # idempotent when this account already won the unique constraint.
        existing = db.query(FantasyDraftPlayer.id).filter(
            FantasyDraftPlayer.session_id == room.id,
            FantasyDraftPlayer.username == username,
        ).first()
        if not existing:
            raise HTTPException(status_code=409, detail="Unable to join that room.")
    return _session_or_404(db, room.id)


def remove_player(
    db: Session,
    identity: dict[str, str],
    session_id: str,
    player_id: str,
) -> FantasyDraftSession:
    username, _ = _identity_names(identity)
    room = _session_or_404(db, session_id, lock=True)
    if username != room.created_by:
        raise HTTPException(status_code=403, detail="Only the host can remove a player.")
    if room.state != "lobby":
        raise HTTPException(status_code=409, detail="The roster is already locked.")
    player = db.query(FantasyDraftPlayer).filter(
        FantasyDraftPlayer.id == player_id,
        FantasyDraftPlayer.session_id == room.id,
    ).first()
    if player is None:
        raise HTTPException(status_code=404, detail="Player not found.")
    if player.username == room.created_by:
        raise HTTPException(status_code=409, detail="The host can't remove themself.")
    db.delete(player)
    db.commit()
    return room


def start_session(db: Session, identity: dict[str, str], session_id: str) -> FantasyDraftSession:
    username, _ = _identity_names(identity)
    room = _session_or_404(db, session_id, lock=True)
    if username != room.created_by:
        raise HTTPException(status_code=403, detail="Only the host can start the draft.")
    if room.state != "lobby":
        raise HTTPException(status_code=409, detail="This draft room has already started.")
    players = _players(db, room.id)
    minimum_players = 1 if room.mode == MODE_PRACTICE else MIN_PLAYERS
    if len(players) < minimum_players:
        raise HTTPException(status_code=409, detail="At least two players are needed.")

    by_username = {player.username: player for player in players}
    ordered_names = derive_turn_order(room.master_seed, by_username)
    for position, ordered_name in enumerate(ordered_names, start=1):
        by_username[ordered_name].turn_position = position
    room.current_player_id = by_username[ordered_names[0]].id
    room.state = "active"
    room.started_at = utc_now()
    db.commit()
    return room


def _current_player_or_error(
    db: Session,
    room: FantasyDraftSession,
    username: str,
) -> FantasyDraftPlayer:
    if room.state != "active" or not room.current_player_id:
        raise HTTPException(status_code=409, detail="This draft room isn't accepting plays.")
    player = db.query(FantasyDraftPlayer).filter(
        FantasyDraftPlayer.id == room.current_player_id,
        FantasyDraftPlayer.session_id == room.id,
    ).first()
    if player is None:
        raise HTTPException(status_code=409, detail="The current player is unavailable.")
    if player.username != username:
        raise HTTPException(status_code=403, detail=f"It's {player.display_name}'s turn.")
    return player


def _get_or_create_active_round(
    db: Session,
    room: FantasyDraftSession,
    player: FantasyDraftPlayer,
) -> FantasyDraftRound:
    round_row = db.query(FantasyDraftRound).filter(
        FantasyDraftRound.player_id == player.id,
        FantasyDraftRound.state == "active",
    ).first()
    if round_row:
        return round_row
    completed = db.query(func.count(FantasyDraftRound.id)).filter(
        FantasyDraftRound.player_id == player.id,
        FantasyDraftRound.state.in_(tuple(FINISHED_ROUND_STATES)),
    ).scalar() or 0
    if completed >= ROUNDS_PER_PLAYER:
        raise HTTPException(status_code=409, detail="This player's rounds are complete.")
    round_row = FantasyDraftRound(
        id=str(uuid.uuid4()),
        session_id=room.id,
        player_id=player.id,
        round_number=completed + 1,
        cards_json="[]",
        score=0,
        state="active",
    )
    db.add(round_row)
    db.flush()
    return round_row


def _advance_after_round(
    db: Session,
    room: FantasyDraftSession,
    player: FantasyDraftPlayer,
) -> None:
    player_rounds = (
        db.query(FantasyDraftRound)
        .filter(FantasyDraftRound.player_id == player.id)
        .order_by(FantasyDraftRound.round_number)
        .all()
    )
    completed = [row for row in player_rounds if row.state in FINISHED_ROUND_STATES]
    if len(completed) < ROUNDS_PER_PLAYER:
        return

    player.final_score = sum(row.score for row in completed)
    next_player = (
        db.query(FantasyDraftPlayer)
        .filter(
            FantasyDraftPlayer.session_id == room.id,
            FantasyDraftPlayer.turn_position > player.turn_position,
        )
        .order_by(FantasyDraftPlayer.turn_position)
        .first()
    )
    if next_player is not None:
        room.current_player_id = next_player.id
        return

    room.current_player_id = None
    room.state = "complete"
    room.completed_at = utc_now()


def flip_card(
    db: Session,
    identity: dict[str, str],
    session_id: str,
) -> tuple[FantasyDraftSession, dict[str, Any]]:
    username, _ = _identity_names(identity)
    room = _session_or_404(db, session_id, lock=True)
    player = _current_player_or_error(db, room, username)
    round_row = _get_or_create_active_round(db, room, player)
    flips_used = db.query(func.count(FantasyDraftFlip.id)).filter(
        FantasyDraftFlip.player_id == player.id
    ).scalar() or 0
    deck = derive_player_deck(room.master_seed, player.username)
    if flips_used >= len(deck):
        raise HTTPException(status_code=409, detail="No cards remain in this player's deck.")

    code = deck[flips_used]
    previous_cards = _cards(round_row)
    busted = _card_rank(code) in {_card_rank(card) for card in previous_cards}
    cards = previous_cards + [code]
    round_row.cards_json = json.dumps(cards, separators=(",", ":"))
    round_row.score = 0 if busted else sum(card_value(card) for card in cards)
    round_row.busted = busted
    db.add(FantasyDraftFlip(
        session_id=room.id,
        player_id=player.id,
        round_id=round_row.id,
        card=code,
        deck_index=flips_used,
    ))
    if busted:
        round_row.state = "busted"
        round_row.ended_at = utc_now()
        db.flush()
        _advance_after_round(db, room, player)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="That card was already dealt. Refresh the room.")
    return room, {
        "type": "flip",
        "playerId": player.id,
        "round": round_row.round_number,
        "card": card_payload(code, flips_used),
        "busted": busted,
    }


def bank_round(
    db: Session,
    identity: dict[str, str],
    session_id: str,
) -> tuple[FantasyDraftSession, dict[str, Any]]:
    username, _ = _identity_names(identity)
    room = _session_or_404(db, session_id, lock=True)
    player = _current_player_or_error(db, room, username)
    round_row = db.query(FantasyDraftRound).filter(
        FantasyDraftRound.player_id == player.id,
        FantasyDraftRound.state == "active",
    ).first()
    if round_row is None or not _cards(round_row):
        raise HTTPException(status_code=409, detail="Flip at least one card before banking.")

    round_row.state = "banked"
    round_row.ended_at = utc_now()
    banked_score = round_row.score
    db.flush()
    _advance_after_round(db, room, player)
    db.commit()
    return room, {
        "type": "bank",
        "playerId": player.id,
        "round": round_row.round_number,
        "score": banked_score,
    }


def forfeit_current_player(
    db: Session,
    identity: dict[str, str],
    session_id: str,
) -> tuple[FantasyDraftSession, dict[str, Any]]:
    """Host-only escape hatch for a manager who never comes back.

    Without this a closed laptop strands the room forever: the roster is
    locked, only the current player may act, and the seed stays sealed because
    verification waits on a final score. Every unplayed round is written down
    as a zero so the turn order and each deck still reproduce exactly.
    """
    username, _ = _identity_names(identity)
    room = _session_or_404(db, session_id, lock=True)
    if username != room.created_by:
        raise HTTPException(status_code=403, detail="Only the host can skip a manager.")
    if room.state != "active" or not room.current_player_id:
        raise HTTPException(status_code=409, detail="This draft room isn't in play.")
    player = db.query(FantasyDraftPlayer).filter(
        FantasyDraftPlayer.id == room.current_player_id,
        FantasyDraftPlayer.session_id == room.id,
    ).first()
    if player is None:
        raise HTTPException(status_code=409, detail="The current player is unavailable.")

    existing = (
        db.query(FantasyDraftRound)
        .filter(FantasyDraftRound.player_id == player.id)
        .order_by(FantasyDraftRound.round_number)
        .all()
    )
    finished = {row.round_number for row in existing if row.state in FINISHED_ROUND_STATES}
    for round_row in existing:
        if round_row.state == "active":
            # Cards already dealt stay on the record — the proof should show
            # what was in front of them — but the round is worth nothing.
            round_row.state = "forfeited"
            round_row.score = 0
            round_row.busted = False
            round_row.ended_at = utc_now()
            finished.add(round_row.round_number)
    for number in range(1, ROUNDS_PER_PLAYER + 1):
        if number in finished:
            continue
        db.add(FantasyDraftRound(
            id=str(uuid.uuid4()),
            session_id=room.id,
            player_id=player.id,
            round_number=number,
            cards_json="[]",
            score=0,
            busted=False,
            state="forfeited",
            ended_at=utc_now(),
        ))
    db.flush()
    _advance_after_round(db, room, player)
    db.commit()
    return room, {
        "type": "forfeit",
        "playerId": player.id,
        "displayName": player.display_name,
    }


def _bot_should_bank(
    room: FantasyDraftSession,
    player: FantasyDraftPlayer,
    round_row: FantasyDraftRound,
) -> bool:
    cards = _cards(round_row)
    context = f"bot-strategy:v1:{player.username}:{round_row.round_number}"
    target = 18 + (int.from_bytes(_context_key(room.master_seed, context)[:2], "big") % 10)
    return len(cards) >= 4 or (len(cards) >= 2 and round_row.score >= target)


def play_test_bot_round(
    db: Session,
    identity: dict[str, str],
    session_id: str,
) -> tuple[FantasyDraftSession, dict[str, Any]]:
    """Play one complete bot round so the UI can animate test progress."""
    username, _ = _identity_names(identity)
    room = _session_or_404(db, session_id, lock=True)
    if room.mode != MODE_TEST:
        raise HTTPException(status_code=409, detail="Bots only play inside test rooms.")
    if username != room.created_by:
        raise HTTPException(status_code=403, detail="Only the test-room host can run bots.")
    if room.state != "active" or not room.current_player_id:
        raise HTTPException(status_code=409, detail="This test room isn't waiting on a bot.")

    player = db.query(FantasyDraftPlayer).filter(
        FantasyDraftPlayer.id == room.current_player_id,
        FantasyDraftPlayer.session_id == room.id,
    ).first()
    if player is None or not player.is_bot:
        raise HTTPException(status_code=409, detail="The current turn belongs to a real player.")

    bot_identity = {"username": player.username, "role": accounts.ROLE_MEMBER}
    cards = []
    round_number = None
    outcome = "banked"
    score = 0
    for _ in range(5):
        room, flip_event = flip_card(db, bot_identity, session_id)
        round_number = flip_event["round"]
        cards.append(flip_event["card"])
        if flip_event["busted"]:
            outcome = "busted"
            break

        active_round = db.query(FantasyDraftRound).filter(
            FantasyDraftRound.player_id == player.id,
            FantasyDraftRound.state == "active",
        ).first()
        if active_round is not None and _bot_should_bank(room, player, active_round):
            room, bank_event = bank_round(db, bot_identity, session_id)
            score = bank_event["score"]
            break
    else:  # Defensive only: the strategy always banks by card four.
        raise HTTPException(status_code=500, detail="The bot couldn't finish its round.")

    return room, {
        "type": "bot_round",
        "playerId": player.id,
        "displayName": player.display_name,
        "round": round_number,
        "outcome": outcome,
        "score": score,
        "cards": cards,
    }


def list_sessions_for_user(db: Session, identity: dict[str, str]) -> list[dict[str, Any]]:
    username, _ = _identity_names(identity)
    rooms = (
        db.query(FantasyDraftSession)
        .join(FantasyDraftPlayer, FantasyDraftPlayer.session_id == FantasyDraftSession.id)
        .filter(
            FantasyDraftPlayer.username == username,
            or_(
                FantasyDraftSession.mode != MODE_PRACTICE,
                FantasyDraftSession.state != "complete",
            ),
        )
        .order_by(FantasyDraftSession.created_at.desc())
        .limit(12)
        .all()
    )
    return [serialize_session(db, room, username) for room in rooms]


def verification(db: Session, room: FantasyDraftSession) -> dict[str, Any]:
    if room.state != "complete":
        raise HTTPException(
            status_code=409,
            detail="Verification unlocks after the final score is locked.",
        )
    players = sorted(_players(db, room.id), key=lambda player: player.turn_position or MAX_PLAYERS + 1)
    all_rounds = _rounds(db, room.id)
    rounds_by_player: dict[str, list[FantasyDraftRound]] = defaultdict(list)
    for round_row in all_rounds:
        rounds_by_player[round_row.player_id].append(round_row)

    verification_players = []
    for player in players:
        deck = derive_player_deck(room.master_seed, player.username)
        flips = _player_flips(db, player.id)
        round_number_by_id = {row.id: row.round_number for row in rounds_by_player[player.id]}
        verification_players.append({
            "playerId": player.id,
            "username": player.username,
            "displayName": player.display_name,
            "turnPosition": player.turn_position,
            "finalScore": player.final_score,
            "tieBreakValue": f"{tie_break_value(room.master_seed, player.username):016x}",
            "deck": [card_payload(code, index) for index, code in enumerate(deck)],
            "draws": [
                {
                    "round": round_number_by_id[flip.round_id],
                    "deckIndex": flip.deck_index,
                    "card": card_payload(flip.card, flip.deck_index),
                }
                for flip in flips
            ],
            "rounds": [_round_payload(row) for row in rounds_by_player[player.id]],
        })

    return {
        "game": GAME_VERSION,
        "sessionId": room.id,
        "leagueName": room.league_name,
        "masterSeed": room.master_seed,
        "publishedSeedHash": room.seed_hash,
        "computedSeedHash": seed_commitment(room.master_seed),
        "hashMatches": secrets.compare_digest(room.seed_hash, seed_commitment(room.master_seed)),
        "turnOrder": [player.display_name for player in players],
        "players": verification_players,
        "algorithm": {
            "commitment": "SHA-256 of the raw 32-byte master seed, displayed as lowercase hex.",
            "canonicalDeck": "Ranks 2 through A; within each rank: clubs, diamonds, hearts, spades.",
            "derivation": (
                "HMAC-SHA256(master_seed, context) creates a context key. Each random 64-bit "
                "word is the first 8 bytes of HMAC-SHA256(context_key, counter as 8-byte big-endian)."
            ),
            "shuffle": (
                "Fisher-Yates from index 51 down to 1. Rejection sampling removes modulo bias "
                "before choosing swap_index = word mod (index + 1)."
            ),
            "contexts": {
                "turnOrder": "turn-order:v1 over account names sorted lowercase first",
                "playerDeck": "deck:v1:{normalized account name}",
                "tieBreak": "first 8 bytes of HMAC-SHA256(master_seed, tiebreak:v1:{normalized account name})",
            },
            "tieBreakRule": "Total score, then best round, then higher seeded tie-break value.",
            "forfeit": (
                "A round in state 'forfeited' was written off by the host after the manager "
                "stopped playing. It scores zero regardless of any cards already dealt."
            ),
        },
    }


def get_session(db: Session, session_id: str) -> FantasyDraftSession:
    return _session_or_404(db, session_id)
